// The shared state machine behind the real-weather cloud layer (tides-l3s).
// Every View's EarthRenderer ticks one controller, and they all show the same
// frames. Building a texture is injected, so this module needs no DOM. Which
// keyframes are wanted comes from ../cloud-frames.ts (tides-kzj.4.1): a frame
// is a day of the daily composite or a geostationary slot over one
// (tides-1zj). Up to MAX_IN_FLIGHT of them build at once, most wanted first,
// and the last MAX_CACHED_FRAMES are kept.
import {
  initialPlanState,
  MAX_CACHED_FRAMES,
  MAX_IN_FLIGHT,
  planCloudFrames,
  stepCloudPlan,
  type CloudFrame,
  type CloudStatus,
  type FrameView,
  type PlanState,
} from '../cloud-frames'
import { pickEvictions, type CloudSource, type GeoSource, type GibsSource } from '../real-clouds'

export type { CloudStatus, FrameView, GibsSource }
/** A source that needs imagery fetched. */
export type ImagerySource = GibsSource | GeoSource

export interface CloudSnapshot<T> {
  /** The committed frames in time order; empty until the first tick. */
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
  abort: AbortController
}

export function createRealCloudController<T>({ build, dispose }: CloudControllerDeps<T>) {
  let plan: PlanState = initialPlanState
  let staticUrl = ''
  // Builds survive the plan moving on (they finish into the cache) unless a
  // discontinuous commit or deactivate aborts them.
  const inFlight = new Map<string, Build>()
  const cache = new Map<string, { texture: T; lastUsed: number }>()
  // Frames in the plan whose build found no imagery; forgotten once they leave.
  const failed = new Set<string>()
  let useCount = 0
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

  function publish() {
    const frames = [...planFrames()]
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
    const keep = new Set(planFrames().map((f) => f.key))
    for (const key of pickEvictions(entries, keep, MAX_CACHED_FRAMES)) {
      dispose(cache.get(key)!.texture)
      cache.delete(key)
    }
  }

  function start(key: string, source: ImagerySource) {
    const current: Build = { key, abort: new AbortController() }
    inFlight.set(key, current)
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

  /** Starts builds for the plan's frames, in priority order, while there is
   * room. */
  function pump() {
    for (const { key, source } of planFrames()) {
      if (inFlight.size >= MAX_IN_FLIGHT) return
      if (source.kind === 'static' || cache.has(key) || inFlight.has(key) || failed.has(key)) continue
      start(key, source)
    }
  }

  function finish(done: Build, texture: T | null) {
    if (done.abort.signal.aborted) {
      // Aborted or deactivated: never touches the snapshot or the cache.
      if (texture) dispose(texture)
      return
    }
    inFlight.delete(done.key)
    if (texture) cache.set(done.key, { texture, lastUsed: ++useCount })
    else if (planFrames().some((f) => f.key === done.key)) failed.add(done.key)
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
      staticUrl = staticCloudsUrl
      // During a jump the clock tweens through everything in between; only
      // the target matters.
      const next = planCloudFrames(jumpToMs ?? simMs, timeScale, nowMs)
      const settled = planFrames().every((f) => statusOf(f) !== 'loading')
      const step = stepCloudPlan(plan, next, wallMs, { jumping: jumpToMs !== null, settled })
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
