// The simulated lightning's feed (tides-ufyr.14): ./lightning-sim.ts's
// windows, for the times GOES GLM has no file for, as a LightningFeed. No
// DOM: the climatology's load, the clouds and GLM's coverage are injected
// (renderers/lightningFeed.ts).
//
// It plays the windows the GLM feed would (./glm-feed.ts: w = floor(clock /
// 20 s), every stride-th when sped up), each made once for the clouds drawn
// at its middle and kept (MAX_WINDOWS), made again when those clouds
// change. At most one window is made per tick, the current or the next,
// and only while playing and allowed to fetch; the climatology loads once,
// when first needed, its errors backing off. A window GLM covers is never
// made, and one kept is dropped from the batches the tick it becomes
// covered: GLM's and the simulation's windows never meet.
import { backoffMs } from './glm-feed'
import type { LightningClimatology } from './lightning-climatology'
import { simulateWindow, type SimClouds, type SimFrame } from './lightning-sim'
import { WINDOW_MS, type FlashBatch, type LightningFeed, type LightningTick } from './lightning'

/** Windows kept. */
export const MAX_WINDOWS = 4
/** The clouds' mix is taken in steps of this (a window isn't made again for less). */
export const MIX_STEP = 1 / 16

export interface SimulatedFeedDeps {
  loadClimatology(signal: AbortSignal): Promise<LightningClimatology>
  /** The clouds drawn at a time; null while none are loaded. The same
   * frames are the same SimFrame objects; the answer is read at once, so
   * it may be reused. */
  clouds(tMs: number): SimClouds | null
  /** GLM has window w (./glm-feed.ts glmCovers). */
  covers(w: number, nowMs: number): boolean
  simulate?: (w: number, clim: LightningClimatology, clouds: SimClouds) => FlashBatch
}

interface Made {
  a: SimFrame | null
  b: SimFrame | null
  mix: number
  batch: FlashBatch
}

export function createSimulatedFeed({
  loadClimatology,
  clouds,
  covers,
  simulate = simulateWindow,
}: SimulatedFeedDeps): LightningFeed {
  const windows = new Map<number, Made>()
  const out: FlashBatch[] = []
  let clim: LightningClimatology | null = null
  let loading: AbortController | null = null
  let failures = 0
  let retryAt = -Infinity
  let generation = 0

  function startLoad(wallMs: number) {
    const abort = new AbortController()
    const gen = generation
    loading = abort
    loadClimatology(abort.signal).then(
      (loaded) => {
        if (gen !== generation || loading !== abort) return
        loading = null
        failures = 0
        clim = loaded
      },
      (err: unknown) => {
        if (gen !== generation || loading !== abort) return
        loading = null
        if (abort.signal.aborted) return
        failures++
        retryAt = wallMs + backoffMs(failures)
        console.warn(`[lightning] climatology failed; retrying in ${backoffMs(failures) / 1000} s`, err)
      }
    )
  }

  // Makes window w for the clouds at its middle unless it's made for them
  // already; true when it made it.
  function make(w: number, loaded: LightningClimatology): boolean {
    const now = clouds((w + 0.5) * WINDOW_MS)
    if (!now) return false
    const mix = Math.round(now.mix / MIX_STEP) * MIX_STEP
    const made = windows.get(w)
    if (made && made.a === now.a && made.b === now.b && made.mix === mix) return false
    const batch = simulate(w, loaded, { a: now.a, b: now.b, mix })
    windows.delete(w)
    windows.set(w, { a: now.a, b: now.b, mix, batch })
    return true
  }

  function prune(wc: number) {
    while (windows.size > MAX_WINDOWS) {
      let far = wc
      let farthest = -1
      for (const w of windows.keys()) {
        if (Math.abs(w - wc) > farthest) {
          farthest = Math.abs(w - wc)
          far = w
        }
      }
      windows.delete(far)
    }
  }

  return {
    tick({ clockMs, stride, rate, wallMs, nowMs, fetch }: LightningTick) {
      const span = stride * WINDOW_MS
      const wc = Math.floor(clockMs / span) * stride
      const wn = wc + (rate < 0 ? -1 : 1) * stride
      const wanted = !covers(wc, nowMs) || !covers(wn, nowMs)
      if (fetch && wanted && !clim && !loading && wallMs >= retryAt) startLoad(wallMs)
      if (fetch && rate !== 0 && clim) {
        const madeCurrent = !covers(wc, nowMs) && make(wc, clim)
        if (!madeCurrent && !covers(wn, nowMs)) make(wn, clim)
      }
      prune(wc)
      out.length = 0
      for (let k = -1; k <= 1; k++) {
        const w = wc + k * stride
        const made = windows.get(w)
        if (made && !covers(w, nowMs)) out.push(made.batch)
      }
      return out
    },

    deactivate() {
      generation++
      loading?.abort()
      loading = null
    },
  }
}

/** One feed playing all of these feeds' batches, the same array every tick. */
export function mergeFeeds(...feeds: LightningFeed[]): LightningFeed {
  const out: FlashBatch[] = []
  return {
    tick(args: LightningTick) {
      out.length = 0
      for (const feed of feeds) {
        const batches = feed.tick(args)
        for (let i = 0; i < batches.length; i++) out.push(batches[i])
      }
      return out
    },
    deactivate() {
      for (const feed of feeds) feed.deactivate()
    },
  }
}
