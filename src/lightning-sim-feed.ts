// The simulated lightning's feed (tides-ufyr.14): ./lightning-sim.ts's
// windows, for the times GOES GLM has no file for, as a LightningFeed. No
// DOM: the climatology's load, the clouds and GLM's coverage are injected
// (renderers/lightningFeed.ts).
//
// It plays the windows the GLM feed would (./glm-feed.ts: w = floor(clock /
// 20 s), every stride-th when sped up), each made once for the clouds drawn
// at its middle, made again when those clouds change, and dropped once
// more than a stride from the current one. The work is spread over frames:
// at most one unit per wall time (every View ticks the feed; the shared
// clock gives them all one wallMs a frame), and only while playing and
// allowed to fetch: seeding one epoch's storms, or, once all of a window's
// are seeded, making the window, the current one before the next; with
// nothing else to do, the epoch ahead in the play direction is seeded. The
// batches are the same as made all at once. The climatology loads once,
// when first needed: network errors back off, a missing or malformed asset
// (ClimatologyUnusable) stops it for good. A window GLM covers is never
// made, and one kept is dropped the tick it becomes covered: GLM's and the
// simulation's windows never meet.
import { backoffMs } from './glm-feed'
import { ClimatologyUnusable, type LightningClimatology } from './lightning-climatology'
import {
  EPOCHS_BACK,
  epochOfWindow,
  isEpochSeeded,
  simulateWindow,
  stormsOfEpoch,
  type SimClouds,
} from './lightning-sim'
import { WINDOW_MS, type FlashBatch, type LightningFeed, type LightningTick } from './lightning'

/** The clouds' mix is taken in steps of this (a window isn't made again for less). */
export const MIX_STEP = 1 / 16

/** The simulation's steps, injectable for tests (./lightning-sim.ts's by default). */
export interface Simulator {
  isSeeded(epoch: number, clim: LightningClimatology): boolean
  seed(epoch: number, clim: LightningClimatology): void
  simulate(w: number, clim: LightningClimatology, clouds: SimClouds): FlashBatch
}

export const DEFAULT_SIMULATOR: Simulator = {
  isSeeded: isEpochSeeded,
  seed: (epoch, clim) => void stormsOfEpoch(epoch, clim),
  simulate: simulateWindow,
}

export interface SimulatedFeedDeps {
  /** Rejects with ClimatologyUnusable when trying again won't help. */
  loadClimatology(signal: AbortSignal): Promise<LightningClimatology>
  /** Fills `out` with the clouds drawn at a time; false while none are
   * loaded. The feed keeps only the frames' ids. */
  clouds(tMs: number, out: SimClouds): boolean
  /** GLM has window w (./glm-feed.ts glmCovers). */
  covers(w: number, nowMs: number): boolean
  simulator?: Simulator
}

interface Made {
  /** The frames' ids, 0 for the static clouds. */
  a: number
  b: number
  mix: number
  batch: FlashBatch
}

export function createSimulatedFeed({
  loadClimatology,
  clouds,
  covers,
  simulator = DEFAULT_SIMULATOR,
}: SimulatedFeedDeps): LightningFeed {
  const windows = new Map<number, Made>()
  const out: FlashBatch[] = []
  const shown: SimClouds = { a: null, b: null, mix: 0 }
  let clim: LightningClimatology | null = null
  let loading: AbortController | null = null
  let unusable = false
  let failures = 0
  let retryAt = -Infinity
  let generation = 0
  /** The latest tick's wall ms. */
  let wall = 0
  let lastWorkWall = Number.NaN

  function startLoad() {
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
        if (err instanceof ClimatologyUnusable) {
          unusable = true
          console.warn('[lightning] no usable climatology; no simulated lightning', err)
          return
        }
        failures++
        retryAt = wall + backoffMs(failures)
        console.warn(`[lightning] climatology failed; retrying in ${backoffMs(failures) / 1000} s`, err)
      }
    )
  }

  // One unit of work toward window w for the clouds at its middle: 'done'
  // when it's made for them already (or there are none yet), 'worked' when
  // an epoch was seeded or the window made.
  function advance(w: number, loaded: LightningClimatology): 'done' | 'worked' {
    if (!clouds((w + 0.5) * WINDOW_MS, shown)) return release('done')
    const a = shown.a?.id ?? 0
    const b = shown.b?.id ?? 0
    const mix = Math.round(shown.mix / MIX_STEP) * MIX_STEP
    const made = windows.get(w)
    if (made && made.a === a && made.b === b && made.mix === mix) return release('done')
    const e = epochOfWindow(w)
    for (let epoch = e - EPOCHS_BACK; epoch <= e; epoch++) {
      if (!simulator.isSeeded(epoch, loaded)) {
        simulator.seed(epoch, loaded)
        return release('worked')
      }
    }
    shown.mix = mix
    windows.set(w, { a, b, mix, batch: simulator.simulate(w, loaded, shown) })
    return release('worked')
  }

  // Lets go of the frames (their cover bytes are megabytes).
  function release<T>(result: T): T {
    shown.a = null
    shown.b = null
    return result
  }

  function work(wc: number, wn: number, dir: number, nowMs: number, loaded: LightningClimatology) {
    if (!covers(wc, nowMs) && advance(wc, loaded) === 'worked') return
    if (covers(wn, nowMs) || advance(wn, loaded) === 'worked') return
    const ahead = dir > 0 ? epochOfWindow(wn) + 1 : epochOfWindow(wn) - EPOCHS_BACK - 1
    if (!simulator.isSeeded(ahead, loaded)) simulator.seed(ahead, loaded)
  }

  return {
    tick({ clockMs, stride, rate, wallMs, nowMs, fetch }: LightningTick) {
      wall = wallMs
      const span = stride * WINDOW_MS
      const wc = Math.floor(clockMs / span) * stride
      const dir = rate < 0 ? -1 : 1
      const wn = wc + dir * stride
      const wanted = !covers(wc, nowMs) || !covers(wn, nowMs)
      if (fetch && wanted && !clim && !loading && !unusable && wallMs >= retryAt) startLoad()
      if (fetch && rate !== 0 && clim && wallMs !== lastWorkWall) {
        lastWorkWall = wallMs
        work(wc, wn, dir, nowMs, clim)
      }
      for (const w of windows.keys()) {
        if (Math.abs(w - wc) > stride || covers(w, nowMs)) windows.delete(w)
      }
      out.length = 0
      for (let k = -1; k <= 1; k++) {
        const made = windows.get(wc + k * stride)
        if (made) out.push(made.batch)
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
