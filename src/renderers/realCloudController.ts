// The shared state machine behind the real-weather cloud layer (tides-l3s).
// Every View's EarthRenderer ticks one controller, and they all show the same
// texture. Building a texture is injected, so this module needs no DOM. A
// source is a day of the daily composite or a geostationary slot over one
// (tides-1zj); nearby slots settle for longer so playback doesn't refetch.
import {
  desiredCloudSource,
  initialCloudDayState,
  MAX_CACHED_DAYS,
  pickEvictions,
  settleMsFor,
  sourceKey,
  stepCloudDay,
  type CloudDayState,
  type CloudSource,
  type GeoSource,
  type GibsSource,
} from '../real-clouds'

export type CloudStatus = 'loading' | 'ready' | 'failed'
export type { GibsSource }
/** A source that needs imagery fetched. */
export type ImagerySource = GibsSource | GeoSource

export interface CloudSnapshot<T> {
  /** Null shows the static clouds. */
  texture: T | null
  /** The committed source; null until the first tick. */
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
  source: ImagerySource
  abort: AbortController
}

export function createRealCloudController<T>({ build, dispose }: CloudControllerDeps<T>) {
  let day: CloudDayState = initialCloudDayState
  // The source behind day.committed, for how long the next one must settle.
  let committedSource: CloudSource | null = null
  let displayedKey: string | null = null
  let staticUrl = ''
  // Only ever the committed source: committing anything else aborts it.
  let inFlight: Build | null = null
  const cache = new Map<string, { texture: T; lastUsed: number }>()
  const listeners = new Set<() => void>()
  const initialSnapshot: CloudSnapshot<T> = { texture: null, source: null, status: 'loading' }
  let snapshot = initialSnapshot

  function publish(next: CloudSnapshot<T>) {
    if (
      next.texture === snapshot.texture &&
      next.source === snapshot.source &&
      next.status === snapshot.status
    ) {
      return
    }
    snapshot = next
    listeners.forEach((l) => l())
  }

  function show(key: string, source: ImagerySource) {
    const entry = cache.get(key)!
    entry.lastUsed = performance.now()
    displayedKey = key
    publish({ texture: entry.texture, source, status: 'ready' })
  }

  function evict() {
    const entries = [...cache].map(([key, e]) => ({ key, lastUsed: e.lastUsed }))
    for (const key of pickEvictions(entries, displayedKey, MAX_CACHED_DAYS)) {
      dispose(cache.get(key)!.texture)
      cache.delete(key)
    }
  }

  function cancelInFlight() {
    inFlight?.abort.abort()
    inFlight = null
  }

  function start(source: ImagerySource) {
    const current: Build = { key: sourceKey(source), source, abort: new AbortController() }
    inFlight = current
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

  function finish(done: Build, texture: T | null) {
    if (inFlight !== done) {
      // Superseded or deactivated: never touches the snapshot or the cache.
      if (texture) dispose(texture)
      return
    }
    inFlight = null
    if (texture) {
      cache.set(done.key, { texture, lastUsed: performance.now() })
      show(done.key, done.source)
      evict()
    } else {
      displayedKey = null
      publish({ texture: null, source: done.source, status: 'failed' })
    }
  }

  function commit(source: CloudSource) {
    const key = sourceKey(source)
    if (inFlight?.key === key) return
    cancelInFlight()
    if (source.kind === 'static') {
      displayedKey = null
      publish({ texture: null, source, status: 'ready' })
      return
    }
    if (cache.has(key)) {
      show(key, source)
      return
    }
    // Keep showing the previous day until this one is ready.
    publish({ texture: snapshot.texture, source, status: 'loading' })
    start(source)
  }

  return {
    /** Call every frame while Real weather is on; cheap when nothing changes.
     * Idempotent within a frame, so every View can call it. */
    tick(
      simMs: number,
      jumpToMs: number | null,
      wallMs: number,
      nowMs: number,
      staticCloudsUrl: string
    ) {
      staticUrl = staticCloudsUrl
      const source = desiredCloudSource(simMs, jumpToMs, nowMs)
      const step = stepCloudDay(
        day,
        sourceKey(source),
        wallMs,
        settleMsFor(source, committedSource)
      )
      day = step.state
      if (step.commit) {
        committedSource = source
        commit(source)
      }
    },
    /** Stops fetching; the cache is kept for when Real weather comes back. */
    deactivate() {
      cancelInFlight()
      day = initialCloudDayState
      committedSource = null
      displayedKey = null
      publish(initialSnapshot)
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
