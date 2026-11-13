// Which GLM files to download for the lightning (tides-ufyr.13), and when.
// No DOM: listing and loading are injected (renderers/lightningFeed.ts).
//
// Each satellite plays the window the clock is in (its index w =
// floor(clock / 20 s), only every stride-th window when sped up). Downloads
// are bounded: one file per satellite per window played (windowWallMs of
// wall time, 20 s live): the next window in the play direction is fetched
// as the clock nears it (PREFETCH_LEAD), never sooner than MIN_GAP_SHARE
// of a window's play after the last start (which lets a cold start, made
// mid-window, get one window ahead); an hour's listing once (an unfinished hour again, after its
// last key, at most every RELIST_MS and only for a missing key); nothing
// for a window outside a satellite's archive or not yet ended; errors back
// off; nothing at all while the caller says not to fetch. A jump waits
// SETTLE_MS for the target to stop moving and abandons downloads it no
// longer needs.
import {
  glmKeyWindow,
  hourStartMs,
  HOUR_MS,
  ownsFlash,
  SATELLITES,
  WINDOW_MS,
  type GlmBatch,
  type GlmSatellite,
} from './glm'
import type { FlashBatch, LightningFeed, LightningTick } from './lightning'

/** How long a jump's target must hold before its window downloads. */
export const SETTLE_MS = 500
/** An unfinished hour is listed again no more often than this. */
export const RELIST_MS = 20_000
/** An hour listed this long after it ended lists every file it will have. */
export const HOUR_DONE_MS = 2 * 60_000
export const BACKOFF_BASE_MS = 10_000
export const BACKOFF_MAX_MS = 5 * 60_000
/** Windows kept per satellite (loaded, empty or failed). */
export const MAX_WINDOWS = 4
/** Hours' listings kept per satellite. */
export const MAX_HOURS = 24
/** [TUNE] The next window downloads when the clock is this share of a window's play from it. */
export const PREFETCH_LEAD = 0.25
/** Starts are at least this share of a window's play apart (at 1x if paused). */
export const MIN_GAP_SHARE = 0.5

/** Wait after `failures` failures in a row: 10 s, 20 s, 40 s ... 5 min. */
export function backoffMs(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS)
}

/** Wall ms one window plays for at this stride and speed (Infinity paused). */
export function windowWallMs(stride: number, rate: number): number {
  return rate === 0 ? Infinity : (stride * WINDOW_MS) / Math.abs(rate)
}

/** The least wall ms between two file starts of a satellite. */
export function minStartGapMs(stride: number, rate: number): number {
  return (MIN_GAP_SHARE * stride * WINDOW_MS) / Math.max(Math.abs(rate), 1)
}

export interface GlmFeedDeps {
  /** One hour's keys (after `startAfter`), in key order. */
  list(sat: GlmSatellite, hourMs: number, startAfter: string | null, signal: AbortSignal): Promise<string[]>
  load(sat: GlmSatellite, key: string, windowStartMs: number, signal: AbortSignal): Promise<GlmBatch>
  satellites?: readonly GlmSatellite[]
}

interface Hour {
  /** Window index to key. */
  keys: Map<number, string>
  lastKey: string | null
  /** Wall ms the last listing started. */
  listedAt: number
  /** Listed after it ended (HOUR_DONE_MS): a missing key means no file. */
  complete: boolean
}

type Window =
  | { status: 'loading'; abort: AbortController }
  | { status: 'done'; batch: GlmBatch; owned: boolean }
  | { status: 'empty' }
  | { status: 'failed' }

interface Sat {
  sat: GlmSatellite
  hours: Map<number, Hour>
  listing: { hourMs: number; abort: AbortController } | null
  /** Change through setWindow / dropWindow, which keep `finished`. */
  windows: Map<number, Window>
  /** Windows not loading (done, empty or failed). */
  finished: number
  failures: number
  /** No download starts before this wall ms. */
  retryAt: number
  /** Wall ms of the last file download's start. */
  lastStartAt: number
  /** Playing on from a window it started, rather than waiting on a jump. */
  anchored: boolean
}

export function createGlmFeed({ list, load, satellites = SATELLITES }: GlmFeedDeps): LightningFeed {
  const sats: Sat[] = satellites.map((sat) => ({
    sat,
    hours: new Map(),
    listing: null,
    windows: new Map(),
    finished: 0,
    failures: 0,
    retryAt: -Infinity,
    lastStartAt: -Infinity,
    anchored: false,
  }))
  const out: FlashBatch[] = []
  let generation = 0
  let wall = 0
  let lastCurrent: number | null = null
  let lastStride = 0
  let settleSince = 0
  /** Nothing started since creation or deactivate(): the first start needs no settling. */
  let fresh = true

  const available = (s: Sat, w: number, nowMs: number) =>
    w * WINDOW_MS >= s.sat.fromMs && (w + 1) * WINDOW_MS <= nowMs

  function setWindow(s: Sat, w: number, state: Window) {
    const before = s.windows.get(w)
    if (before && before.status !== 'loading') s.finished--
    if (state.status !== 'loading') s.finished++
    s.windows.set(w, state)
  }

  function dropWindow(s: Sat, w: number) {
    const before = s.windows.get(w)
    if (!before) return
    if (before.status !== 'loading') s.finished--
    s.windows.delete(w)
  }

  // Window w's batches settle their shares again: another satellite's file
  // for it came in (perhaps after one was drawing it alone).
  function reshare(w: number) {
    for (const s of sats) {
      const state = s.windows.get(w)
      if (state?.status === 'done') state.owned = false
    }
  }

  function fail(s: Sat, what: string, err: unknown) {
    s.failures++
    s.retryAt = wall + backoffMs(s.failures)
    console.warn(`[lightning] GLM ${what} failed (${s.sat.id}); retrying in ${backoffMs(s.failures) / 1000} s`, err)
  }

  function startListing(s: Sat, hourMs: number, nowMs: number) {
    const hour = s.hours.get(hourMs)
    const abort = new AbortController()
    const gen = generation
    s.listing = { hourMs, abort }
    const listedAt = wall
    const complete = nowMs >= hourMs + HOUR_MS + HOUR_DONE_MS
    list(s.sat, hourMs, hour?.lastKey ?? null, abort.signal).then(
      (keys) => {
        if (gen !== generation || s.listing?.abort !== abort) return
        s.listing = null
        s.failures = 0
        const entry = s.hours.get(hourMs) ?? { keys: new Map(), lastKey: null, listedAt, complete }
        for (const key of keys) {
          const w = glmKeyWindow(key)
          if (Number.isFinite(w)) entry.keys.set(w, key)
        }
        if (keys.length > 0) entry.lastKey = keys[keys.length - 1]
        entry.listedAt = listedAt
        entry.complete = complete
        s.hours.delete(hourMs)
        s.hours.set(hourMs, entry)
        while (s.hours.size > MAX_HOURS) s.hours.delete(s.hours.keys().next().value!)
      },
      (err: unknown) => {
        if (gen !== generation || s.listing?.abort !== abort) return
        s.listing = null
        if (!abort.signal.aborted) fail(s, 'listing', err)
      }
    )
  }

  function startLoad(s: Sat, w: number, key: string) {
    const abort = new AbortController()
    const gen = generation
    setWindow(s, w, { status: 'loading', abort })
    s.lastStartAt = wall
    fresh = false
    load(s.sat, key, w * WINDOW_MS, abort.signal).then(
      (batch) => {
        if (gen !== generation || (s.windows.get(w) as { abort?: AbortController } | undefined)?.abort !== abort) return
        s.failures = 0
        setWindow(s, w, { status: 'done', batch, owned: false })
        reshare(w)
      },
      (err: unknown) => {
        if (gen !== generation || (s.windows.get(w) as { abort?: AbortController } | undefined)?.abort !== abort) return
        if (abort.signal.aborted) {
          dropWindow(s, w)
          return
        }
        setWindow(s, w, { status: 'failed' })
        fail(s, 'file', err)
      }
    )
  }

  /**
   * Moves window w toward a download: a file start, a listing, or the
   * window found empty. 'started' when a file download began, 'settled'
   * when nothing is left to do for it, 'waiting' otherwise.
   */
  function advance(s: Sat, w: number, nowMs: number): 'started' | 'settled' | 'waiting' {
    if (!available(s, w, nowMs)) return 'settled'
    const state = s.windows.get(w)
    if (state && state.status !== 'failed') return 'settled'
    if (wall < s.retryAt) return 'waiting'
    const hourMs = hourStartMs(w * WINDOW_MS)
    const hour = s.hours.get(hourMs)
    const key = hour?.keys.get(w)
    if (key) {
      startLoad(s, w, key)
      return 'started'
    }
    if (hour?.complete) {
      setWindow(s, w, { status: 'empty' })
      return 'settled'
    }
    if (s.listing) return 'waiting'
    if (!hour || wall - hour.listedAt >= RELIST_MS) startListing(s, hourMs, nowMs)
    return 'waiting'
  }

  // What the other satellite saw of window w: its subpoint longitude, NaN
  // when it has nothing for it (none to come, or none in flight once the
  // clock has reached w: a gap in its files, an outage), undefined while
  // it may yet. Should its file come in after all, reshare() settles the
  // shares again.
  function otherSubpoint(o: Sat, w: number, nowMs: number, reached: boolean): number | undefined {
    if (!available(o, w, nowMs)) return Number.NaN
    const state = o.windows.get(w)
    if (state?.status === 'done') return state.batch.subpointLon
    if (state?.status === 'loading') return undefined
    if (state || o.failures > 0 || reached) return Number.NaN
    return undefined
  }

  // Once both satellites have window w (or one has none), each flash goes
  // to the one nearer it. `reached`: the clock is in w or past it.
  function resolveOwnership(w: number, nowMs: number, reached: boolean) {
    for (let i = 0; i < sats.length; i++) {
      const state = sats[i].windows.get(w)
      if (state?.status !== 'done' || state.owned) continue
      let lon = Number.NaN
      let pending = false
      for (const o of sats) {
        if (o === sats[i]) continue
        const other = otherSubpoint(o, w, nowMs, reached)
        if (other === undefined) pending = true
        else lon = other
      }
      if (pending) continue
      const { batch } = state
      for (let j = 0; j < batch.count; j++) {
        batch.owned[j] = Number.isNaN(lon) || ownsFlash(batch.lon[j], batch.subpointLon, lon, i === 0) ? 1 : 0
      }
      state.owned = true
    }
  }

  // Keeps the MAX_WINDOWS finished windows nearest the current one.
  function prune(s: Sat, wc: number) {
    if (s.finished <= MAX_WINDOWS) return
    const kept = [...s.windows].filter(([, state]) => state.status !== 'loading')
    kept.sort((a, b) => Math.abs(b[0] - wc) - Math.abs(a[0] - wc))
    for (const [w] of kept.slice(0, kept.length - MAX_WINDOWS)) dropWindow(s, w)
  }

  // A jump: drop downloads for windows other than these.
  function abandon(keep: readonly number[]) {
    const hours = keep.map((w) => hourStartMs(w * WINDOW_MS))
    for (const s of sats) {
      for (const [w, state] of s.windows) {
        if (state.status === 'loading' && !keep.includes(w)) {
          state.abort.abort()
          dropWindow(s, w)
        }
      }
      if (s.listing && !hours.includes(s.listing.hourMs)) {
        s.listing.abort.abort()
        s.listing = null
      }
    }
  }

  return {
    tick({ clockMs, stride, rate, wallMs, nowMs, fetch }: LightningTick) {
      wall = wallMs
      const span = stride * WINDOW_MS
      const wc = Math.floor(clockMs / span) * stride
      const dir = rate < 0 ? -1 : 1
      const wn = wc + dir * stride
      if (lastCurrent === null || stride !== lastStride || Math.abs(wc - lastCurrent) > stride) {
        // Only the very first target goes at once: a scrub from the start
        // settles like any other.
        if (lastCurrent !== null) fresh = false
        for (const s of sats) s.anchored = false
        settleSince = wallMs
        abandon([wc, wn])
      } else if (wc !== lastCurrent) {
        for (const s of sats) if (!s.anchored) settleSince = wallMs
      }
      lastCurrent = wc
      lastStride = stride

      if (fetch) {
        const gap = minStartGapMs(stride, rate)
        // How far the clock is through the current window, in the play direction.
        const into = (clockMs - wc * WINDOW_MS) / span
        const played = dir > 0 ? into : 1 - into
        const settled = fresh || wallMs - settleSince >= SETTLE_MS
        for (const s of sats) {
          if (!s.anchored) {
            if (settled && advance(s, wc, nowMs) !== 'waiting') s.anchored = true
            continue
          }
          // Playing on: the current window if it isn't in (just entered,
          // or failed: the backoff paces that), else the next as the clock
          // nears it.
          const current = s.windows.get(wc)
          const paced = wallMs - s.lastStartAt >= gap
          if (current === undefined ? paced : current.status === 'failed') {
            advance(s, wc, nowMs)
          } else if (paced && rate !== 0 && played >= 1 - PREFETCH_LEAD) {
            advance(s, wn, nowMs)
          }
        }
      }

      out.length = 0
      for (let k = -1; k <= 1; k++) resolveOwnership(wc + k * stride, nowMs, k * dir <= 0)
      for (const s of sats) {
        prune(s, wc)
        for (let k = -1; k <= 1; k++) {
          const state = s.windows.get(wc + k * stride)
          if (state?.status === 'done' && state.owned) out.push(state.batch)
        }
      }
      return out
    },

    deactivate() {
      generation++
      for (const s of sats) {
        for (const [w, state] of s.windows) {
          if (state.status === 'loading') {
            state.abort.abort()
            dropWindow(s, w)
          }
        }
        s.listing?.abort.abort()
        s.listing = null
        s.anchored = false
      }
      lastCurrent = null
      fresh = true
    },
  }
}
