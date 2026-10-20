// The shared state machine behind the real-weather cloud layer (tides-l3s).
// Every View's EarthRenderer ticks one controller, and they all show the same
// frames. Building a texture is injected, so this module needs no DOM. Which
// keyframes are wanted comes from ../cloud-frames.ts (tides-kzj.4.1): a frame
// is a day of the daily composite, a geostationary slot over one (tides-1zj)
// or a forecast from the latest of them (tides-kzj.4.3). Up to MAX_IN_FLIGHT of them build at once, most wanted first,
// and the last MAX_CACHED_FRAMES are kept. Slow builds lengthen the frames
// (BUILD_MARGIN), and a frame that finishes after playback has moved past it
// is still shown while it is the latest there is.
import {
  initialPlanState,
  isSteady,
  MAX_CACHED_FRAMES,
  MAX_IN_FLIGHT,
  MIN_FRAME_WALL_MS,
  planCloudFrames,
  stepCloudPlan,
  type CloudFrame,
  type CloudStatus,
  type FrameView,
  type PlanState,
} from '../cloud-frames'
import {
  pickEvictions,
  type CloudSource,
  type ForecastSource,
  type GeoSource,
  type GibsSource,
} from '../real-clouds'

export type { CloudStatus, FrameView, GibsSource }
/** A source that needs imagery fetched (or, for a forecast, synthesised). */
export type ImagerySource = GibsSource | GeoSource | ForecastSource

/** A frame lasts at least this many times the average build. */
export const BUILD_MARGIN = 1.2
// The average follows new builds this fast, and moves the frame minimum only
// when it is this far off, so the cadence doesn't flip back and forth.
const BUILD_AVERAGE_WEIGHT = 0.3
const MIN_FRAME_HYSTERESIS = 0.25

export interface CloudSnapshot<T> {
  /** The committed frames, and loaded ones just behind them that playback
   * has moved past, in time order; empty until the first tick. */
  frames: readonly FrameView<T>[]
  /** The rest describe the frame at or before the sim time (for attribution):
   * its texture, null while it loads or for the static clouds. */
  texture: T | null
  /** Null until the first tick. */
  source: CloudSource | null
  status: CloudStatus
}

export interface CloudControllerDeps<T> {
  /** Resolves null when no imagery could be had; may reject once aborted. */
  build: (source: ImagerySource, staticCloudsUrl: string, signal: AbortSignal) => Promise<T | null>
  dispose: (texture: T) => void
}

interface Build {
  key: string
  frame: CloudFrame
  startedAt: number
  abort: AbortController
}

export function createRealCloudController<T>({ build, dispose }: CloudControllerDeps<T>) {
  let plan: PlanState = initialPlanState
  let staticUrl = ''
  // Builds survive the plan moving on (they finish into the cache) unless a
  // discontinuous commit or deactivate aborts them.
  const inFlight = new Map<string, Build>()
  const cache = new Map<string, { frame: CloudFrame; texture: T; lastUsed: number }>()
  // Frames in the plan whose build found no imagery; forgotten once they leave.
  const failed = new Set<string>()
  let useCount = 0
  let buildMsAverage: number | null = null
  let minFrameWallMs = MIN_FRAME_WALL_MS
  // The last tick's inputs: playback vs scrubbing, and what pump() aims for.
  let last: { simMs: number; wallMs: number; jumpToMs: number | null; timeScale: number } | null =
    null
  const listeners = new Set<() => void>()
  const initialSnapshot: CloudSnapshot<T> = { frames: [], texture: null, source: null, status: 'loading' }
  let snapshot = initialSnapshot

  const planFrames = (): readonly CloudFrame[] => plan.committed?.frames ?? []

  function statusOf(frame: CloudFrame): CloudStatus {
    if (frame.source.kind === 'static' || cache.has(frame.key)) return 'ready'
    return failed.has(frame.key) ? 'failed' : 'loading'
  }

  function notify(next: CloudSnapshot<T>) {
    snapshot = next
    listeners.forEach((l) => l())
  }

  /** Loaded frames outside the plan but at most two steps behind it. */
  function nearbyCached(): CloudFrame[] {
    const committed = plan.committed
    if (committed?.mode !== 'bracket') return []
    const [first, second] = committed.frames
    const step = Math.max(committed.cadenceMs, second ? second.timeMs - first.timeMs : 0)
    const from = first.timeMs - 2 * step
    const to = Math.max(...committed.frames.map((f) => f.timeMs))
    const inPlan = new Set(committed.frames.map((f) => f.key))
    return [...cache.values()]
      .map((e) => e.frame)
      .filter((f) => !inPlan.has(f.key) && f.timeMs >= from && f.timeMs <= to)
  }

  function publish() {
    const frames = [...planFrames(), ...nearbyCached()]
      .sort((a, b) => a.timeMs - b.timeMs)
      .map((f) => ({ ...f, status: statusOf(f), texture: cache.get(f.key)?.texture ?? null }))
    const unchanged =
      frames.length === snapshot.frames.length &&
      frames.every((f, i) => {
        const was = snapshot.frames[i]
        return was.key === f.key && was.status === f.status && was.texture === f.texture
      })
    if (unchanged) return
    const primary = frames.find((f) => f.key === planFrames()[0]?.key)
    notify({
      frames,
      texture: primary?.texture ?? null,
      source: primary?.source ?? null,
      status: primary?.status ?? 'loading',
    })
  }

  function evict() {
    const entries = [...cache].map(([key, e]) => ({ key, lastUsed: e.lastUsed }))
    // Shown frames stay: the plan's, and the late ones still on screen.
    const keep = new Set([...planFrames(), ...nearbyCached()].map((f) => f.key))
    for (const key of pickEvictions(entries, keep, MAX_CACHED_FRAMES)) {
      dispose(cache.get(key)!.texture)
      cache.delete(key)
    }
  }

  function start(frame: CloudFrame, source: ImagerySource) {
    const current: Build = {
      key: frame.key,
      frame,
      startedAt: last?.wallMs ?? 0,
      abort: new AbortController(),
    }
    inFlight.set(frame.key, current)
    build(source, staticUrl, current.abort.signal).then(
      (texture) => finish(current, texture),
      (err) => {
        if (!current.abort.signal.aborted) {
          console.error('[clouds] building the GIBS cloud texture failed', err)
        }
        finish(current, null)
      }
    )
  }

  /** True when playback will pass the frame after `frame` before a build of
   * `frame` would finish, so building it is wasted. */
  function outrun(frame: CloudFrame): boolean {
    if (!last || last.timeScale <= 0 || buildMsAverage === null) return false
    const frames = planFrames()
    const next = frames[frames.indexOf(frame) + 1]
    if (!next) return false
    const simMs = last.jumpToMs ?? last.simMs
    return (next.timeMs - simMs) / last.timeScale < buildMsAverage
  }

  /** Starts builds for the plan's frames, in priority order, while there is
   * room. */
  function pump() {
    for (const frame of planFrames()) {
      if (inFlight.size >= MAX_IN_FLIGHT) return
      const { key, source } = frame
      if (source.kind === 'static' || cache.has(key) || inFlight.has(key) || failed.has(key)) continue
      if (outrun(frame)) continue
      start(frame, source)
    }
  }

  function recordBuildTime(ms: number) {
    buildMsAverage =
      buildMsAverage === null ? ms : buildMsAverage + BUILD_AVERAGE_WEIGHT * (ms - buildMsAverage)
    const target = Math.max(MIN_FRAME_WALL_MS, BUILD_MARGIN * buildMsAverage)
    if (Math.abs(target - minFrameWallMs) > MIN_FRAME_HYSTERESIS * minFrameWallMs) {
      minFrameWallMs = target
    }
  }

  function finish(done: Build, texture: T | null) {
    if (done.abort.signal.aborted) {
      // Aborted or deactivated: never touches the snapshot or the cache.
      if (texture) dispose(texture)
      return
    }
    inFlight.delete(done.key)
    if (texture) {
      cache.set(done.key, { frame: done.frame, texture, lastUsed: ++useCount })
      if (last) recordBuildTime(last.wallMs - done.startedAt)
    } else if (planFrames().some((f) => f.key === done.key)) failed.add(done.key)
    evict()
    publish()
    pump()
  }

  return {
    /** Call every frame while Real weather is on; cheap when nothing changes.
     * Idempotent within a frame, so every View can call it. timeScale is sim
     * seconds per wall second. */
    tick(
      simMs: number,
      jumpToMs: number | null,
      timeScale: number,
      wallMs: number,
      nowMs: number,
      staticCloudsUrl: string
    ) {
      if (
        last &&
        last.wallMs === wallMs &&
        last.simMs === simMs &&
        last.jumpToMs === jumpToMs &&
        last.timeScale === timeScale
      ) {
        return
      }
      staticUrl = staticCloudsUrl
      // During a jump the clock tweens through everything in between; only
      // the target matters.
      const target = jumpToMs ?? simMs
      const steady = isSteady(
        last && { simMs: last.jumpToMs ?? last.simMs, wallMs: last.wallMs },
        target,
        wallMs,
        timeScale
      )
      last = { simMs, wallMs, jumpToMs, timeScale }
      const next = planCloudFrames(target, timeScale, nowMs, minFrameWallMs)
      const settled = planFrames().every((f) => statusOf(f) !== 'loading')
      const step = stepCloudPlan(plan, next, wallMs, {
        jumping: jumpToMs !== null,
        settled,
        steady,
      })
      plan = step.state
      if (!step.commit) return
      const wanted = new Set(step.commit.frames.map((f) => f.key))
      if (step.abortUnwanted) {
        for (const [key, b] of inFlight) {
          if (wanted.has(key)) continue
          b.abort.abort()
          inFlight.delete(key)
        }
      }
      for (const key of failed) if (!wanted.has(key)) failed.delete(key)
      for (const f of step.commit.frames) {
        const entry = cache.get(f.key)
        if (entry) entry.lastUsed = ++useCount
      }
      pump()
      publish()
    },
    /** Stops fetching; the cache is kept for when Real weather comes back. */
    deactivate() {
      for (const b of inFlight.values()) b.abort.abort()
      inFlight.clear()
      failed.clear()
      plan = initialPlanState
      last = null
      if (snapshot !== initialSnapshot) notify(initialSnapshot)
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot(): CloudSnapshot<T> {
      return snapshot
    },
  }
}

export type RealCloudController<T> = ReturnType<typeof createRealCloudController<T>>
