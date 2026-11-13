import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { backoffMs, createGlmFeed, glmCovers } from './glm-feed'
import { glmHourPrefix, HOUR_MS, SATELLITES, type GlmBatch, type GlmSatellite } from './glm'
import { WINDOW_MS, type FlashBatch, type LightningFeed, type LightningTick } from './lightning'
import { ClimatologyUnusable, syntheticClimatology, type LightningClimatology } from './lightning-climatology'
import { epochOfWindow, simulateWindow, type SimClouds, type SimFrame } from './lightning-sim'
import { createSimulatedFeed, DEFAULT_SIMULATOR, mergeFeeds, type Simulator } from './lightning-sim-feed'

const NOW = Date.UTC(2026, 10, 13, 12, 30, 7)
const CLIM = {} as LightningClimatology
const frameA: SimFrame = { id: 1, cover: null, precip: null }
const frameB: SimFrame = { id: 2, cover: null, precip: null }
const FUTURE = NOW + 3 * 86_400_000
const wOf = (ms: number) => Math.floor(ms / WINDOW_MS)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function batchOf(w: number, source: FlashBatch['source'] = 'simulated'): FlashBatch {
  return {
    source,
    key: `${source}:${w}`,
    startMs: w * WINDOW_MS,
    count: 1,
    lat: new Float32Array(1),
    lon: new Float32Array(1),
    offsetMs: new Float32Array([1000]),
    durationMs: new Float32Array([200]),
    energyJ: new Float32Array([1e-13]),
    areaKm2: new Float32Array([300]),
    owned: new Uint8Array([1]),
  }
}

/**
 * A simulated feed over a stub simulation that logs its work: its
 * climatology loads at once (`auto`) or when the test says; every epoch is
 * seeded already, or none (`seeded: false`). Each tick is a new frame
 * (wallMs + 16) unless it says otherwise.
 */
function harness({ auto = true, seeded = true } = {}) {
  const loads: { resolve: (c: LightningClimatology) => void; reject: (e: unknown) => void; signal: AbortSignal }[] = []
  const made: number[] = []
  const work: { wall: number; what: string }[] = []
  const epochs = new Set<number>()
  const clouds = { a: frameA as SimFrame | null, b: frameB as SimFrame | null, mix: 0.3, loaded: true }
  const outs: SimClouds[] = []
  const args: LightningTick = { clockMs: FUTURE, stride: 1, rate: 1, wallMs: 0, nowMs: NOW, fetch: true }
  const simulator: Simulator = {
    isSeeded: (e) => seeded || epochs.has(e),
    seed: (e) => {
      epochs.add(e)
      work.push({ wall: args.wallMs, what: `seed ${e}` })
    },
    simulate: (w) => {
      made.push(w)
      work.push({ wall: args.wallMs, what: `make ${w}` })
      return batchOf(w)
    },
  }
  const feed = createSimulatedFeed({
    loadClimatology: (signal) =>
      auto ? Promise.resolve(CLIM) : new Promise((resolve, reject) => loads.push({ resolve, reject, signal })),
    clouds: (_t, out) => {
      outs.push(out)
      if (!clouds.loaded) return false
      out.a = clouds.a
      out.b = clouds.b
      out.mix = clouds.mix
      return true
    },
    covers: (w, nowMs) => glmCovers(w, nowMs),
    simulator,
  })
  const tick = (over: Partial<LightningTick> = {}) => {
    if (over.wallMs === undefined) args.wallMs += 16
    return feed.tick(Object.assign(args, over))
  }
  return { feed, loads, made, work, epochs, clouds, outs, args, tick }
}

describe('createSimulatedFeed', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('plays the windows GLM has no file for, one made per frame, the current first', async () => {
    const h = harness()
    h.tick()
    await flush()
    const wc = wOf(FUTURE)
    expect(h.tick().map((b) => b.startMs)).toEqual([wc * WINDOW_MS])
    expect(h.made).toEqual([wc])
    h.tick({ clockMs: FUTURE + 1 })
    expect(h.made).toEqual([wc, wc + 1])
    h.tick({ clockMs: FUTURE + 2 })
    expect(h.made).toEqual([wc, wc + 1])
    // Played backward, the next is the one before.
    h.tick({ clockMs: FUTURE + 3, rate: -1 })
    expect(h.made).toEqual([wc, wc + 1, wc - 1])
  })

  test('the same array every tick', async () => {
    const h = harness()
    const first = h.tick()
    await flush()
    for (let i = 0; i < 5; i++) expect(h.tick({ clockMs: FUTURE + i * 7000 })).toBe(first)
    const merged = mergeFeeds(h.feed, h.feed)
    const out = merged.tick(h.args)
    expect(merged.tick(h.args)).toBe(out)
  })

  test('makes nothing while paused, while told not to fetch, or while the climatology loads', async () => {
    const h = harness({ auto: false })
    h.tick()
    expect(h.loads).toHaveLength(1)
    h.tick({ clockMs: FUTURE + 5000 })
    expect(h.made).toEqual([])
    h.loads[0].resolve(CLIM)
    await flush()
    h.tick({ clockMs: FUTURE, rate: 0 })
    h.tick({ fetch: false })
    expect(h.work).toEqual([])
    h.tick({ rate: 1, fetch: true })
    expect(h.made).toHaveLength(1)
  })

  test('one unit of work a frame, however many Views tick it: seeding an epoch, or making a window once all of its are', async () => {
    const h = harness({ seeded: false })
    h.tick()
    await flush()
    for (let frame = 0; frame < 12; frame++) {
      h.tick()
      h.tick({ wallMs: h.args.wallMs })
      h.tick({ wallMs: h.args.wallMs })
    }
    const perWall = new Map<number, number>()
    for (const { wall } of h.work) perWall.set(wall, (perWall.get(wall) ?? 0) + 1)
    for (const n of perWall.values()) expect(n).toBe(1)
    const wc = wOf(FUTURE)
    const e = epochOfWindow(wc)
    const en = epochOfWindow(wc + 1)
    const expected = [`seed ${e - 2}`, `seed ${e - 1}`, `seed ${e}`, `make ${wc}`]
    for (let k = en - 2; k <= en; k++) if (k > e) expected.push(`seed ${k}`)
    expected.push(`make ${wc + 1}`)
    // Then the epoch ahead in the play direction, and nothing more.
    expected.push(`seed ${en + 1}`)
    expect(h.work.map((w) => w.what)).toEqual(expected)
  })

  test('loads the climatology once, only when a window needs it; network errors back off from the failure', async () => {
    const h = harness({ auto: false })
    // GLM covers it: nothing to load for.
    h.tick({ clockMs: NOW - 120_000 })
    h.tick({ clockMs: FUTURE, fetch: false })
    expect(h.loads).toHaveLength(0)
    h.tick({ fetch: true, wallMs: 0 })
    h.tick({ wallMs: 1 })
    expect(h.loads).toHaveLength(1)
    // It fails 5 s on.
    h.tick({ wallMs: 5000 })
    h.loads[0].reject(new Error('network'))
    await flush()
    h.tick({ wallMs: 5000 + backoffMs(1) - 1 })
    expect(h.loads).toHaveLength(1)
    h.tick({ wallMs: 5000 + backoffMs(1) })
    expect(h.loads).toHaveLength(2)
    h.loads[1].reject(new Error('timeout'))
    await flush()
    const failedAt = h.args.wallMs
    h.tick({ wallMs: failedAt + backoffMs(2) - 1 })
    expect(h.loads).toHaveLength(2)
    h.tick({ wallMs: failedAt + backoffMs(2) })
    expect(h.loads).toHaveLength(3)
    h.loads[2].resolve(CLIM)
    await flush()
    for (let i = 0; i < 10; i++) h.tick({ wallMs: 1e6 + i * 1e6 })
    expect(h.loads).toHaveLength(3)
    expect(h.made.length).toBeGreaterThan(0)
  })

  test('a missing or malformed climatology warns once and is never asked for again', async () => {
    const h = harness({ auto: false })
    h.tick()
    h.loads[0].reject(new ClimatologyUnusable('HTTP 404'))
    await flush()
    for (let i = 0; i < 10; i++) h.tick({ wallMs: (i + 1) * 1e6 })
    expect(h.loads).toHaveLength(1)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(h.tick()).toHaveLength(0)
  })

  test('deactivate drops the climatology in flight; the next need loads it again', async () => {
    const h = harness({ auto: false })
    h.tick()
    h.feed.deactivate()
    expect(h.loads[0].signal.aborted).toBe(true)
    h.loads[0].resolve(CLIM)
    await flush()
    h.tick()
    expect(h.made).toEqual([])
    expect(h.loads).toHaveLength(2)
  })

  test('makes a window again when the clouds drawn at it change, keeping only their ids', async () => {
    const h = harness()
    h.tick()
    await flush()
    h.tick()
    h.tick()
    expect(h.made).toHaveLength(2)
    h.clouds.mix = 0.3 + 0.02
    h.tick()
    expect(h.made).toHaveLength(2)
    // Both windows again, one a frame.
    h.clouds.mix = 0.5
    h.tick()
    expect(h.made).toHaveLength(3)
    h.tick()
    expect(h.made).toHaveLength(4)
    // Another frame object with the same id is the same frame.
    h.clouds.a = { ...frameA }
    h.tick()
    expect(h.made).toHaveLength(4)
    h.clouds.a = frameB
    h.tick()
    expect(h.made).toHaveLength(5)
    // No clouds loaded: nothing made, what was made still plays.
    h.clouds.loaded = false
    expect(h.tick()).toHaveLength(2)
    expect(h.made).toHaveLength(5)
    // The feed lets go of the frames it read.
    for (const out of h.outs) {
      expect(out.a).toBeNull()
      expect(out.b).toBeNull()
    }
  })

  test('drops windows more than a stride from the current one', async () => {
    const h = harness()
    h.tick()
    await flush()
    h.tick()
    h.tick()
    expect(h.made).toEqual([wOf(FUTURE), wOf(FUTURE) + 1])
    h.tick({ clockMs: FUTURE + 10 * WINDOW_MS })
    h.tick({ clockMs: FUTURE })
    expect(h.made.filter((w) => w === wOf(FUTURE))).toHaveLength(2)
  })

  test("a window is the same at any speed and as made at once: the stride and the spreading don't reach it", async () => {
    const clim = syntheticClimatology({ density: 0.003, cover: 1 })
    const batches: FlashBatch[] = []
    for (const stride of [1, 4]) {
      const feed = createSimulatedFeed({
        loadClimatology: async () => clim,
        clouds: (_t, out) => {
          out.a = null
          out.b = null
          out.mix = 0
          return true
        },
        covers: (w, nowMs) => glmCovers(w, nowMs),
      })
      const w = wOf(FUTURE) - (wOf(FUTURE) % 4) + 400 * stride
      const args = { clockMs: w * WINDOW_MS + 100, stride, rate: stride * 4, wallMs: 0, nowMs: NOW, fetch: true }
      feed.tick(args)
      await flush()
      let out: readonly FlashBatch[] = []
      for (let frame = 1; frame <= 10 && out.length === 0; frame++) out = feed.tick({ ...args, wallMs: frame * 16 })
      expect(out).toHaveLength(1)
      batches.push(out[0])
    }
    const w = batches[0].startMs / WINDOW_MS
    expect(batches[1].startMs / WINDOW_MS).toBe(w + 400 * 3)
    expect(batches[0]).toEqual(simulateWindow(w, clim, { a: null, b: null, mix: 0 }))
    expect(batches[1]).toEqual(simulateWindow(w + 1200, clim, { a: null, b: null, mix: 0 }))
    // And the same window at stride 4 as at stride 1.
    expect(simulateWindow(w + 1200, clim, { a: null, b: null, mix: 0 })).toEqual(batches[1])
  })
})

describe('GLM and simulated lightning at their seams', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** A GLM feed with every covered window it plays loaded. */
  function fakeGlm(): LightningFeed {
    const out: FlashBatch[] = []
    return {
      tick({ clockMs, stride, nowMs }) {
        out.length = 0
        const wc = Math.floor(clockMs / (stride * WINDOW_MS)) * stride
        for (let k = -1; k <= 1; k++) if (glmCovers(wc + k * stride, nowMs)) out.push(batchOf(wc + k * stride, 'glm'))
        return out
      },
      deactivate() {},
    }
  }

  function stubSimFeed() {
    return createSimulatedFeed({
      loadClimatology: async () => CLIM,
      clouds: (_t, out) => {
        out.a = frameA
        out.b = frameA
        out.mix = 0
        return true
      },
      covers: (w, nowMs) => glmCovers(w, nowMs),
      simulator: { ...DEFAULT_SIMULATOR, isSeeded: () => true, simulate: (w) => batchOf(w) },
    })
  }

  function assertDisjoint(batches: readonly FlashBatch[]) {
    const glm = new Set(batches.filter((b) => b.source === 'glm').map((b) => b.startMs))
    const sim = batches.filter((b) => b.source === 'simulated').map((b) => b.startMs)
    for (const s of sim) expect(glm.has(s)).toBe(false)
    return { glm: glm.size, sim: sim.length }
  }

  test("sweeping the clock over the latest data and the archives' starts, no window plays twice", async () => {
    const merged = mergeFeeds(fakeGlm(), stubSimFeed())
    const g18 = SATELLITES.find((s) => s.id === 'G18')!.fromMs
    const g19 = SATELLITES.find((s) => s.id === 'G19')!.fromMs
    let seen = { glm: 0, sim: 0 }
    let wallMs = 0
    for (const edge of [NOW, g18, g19]) {
      for (const stride of [1, 8]) {
        const tickAt = (clockMs: number) =>
          merged.tick({ clockMs, stride, rate: stride * 4, wallMs: (wallMs += 16), nowMs: NOW, fetch: true })
        tickAt(edge - 30 * stride * WINDOW_MS)
        await flush()
        for (let t = edge - 30 * stride * WINDOW_MS; t < edge + 30 * stride * WINDOW_MS; t += 3000 * stride) {
          const counts = assertDisjoint(tickAt(t))
          seen = { glm: seen.glm + counts.glm, sim: seen.sim + counts.sim }
        }
      }
    }
    // Both played somewhere (G19's start is inside G18's archive: GLM's alone).
    expect(seen.glm).toBeGreaterThan(0)
    expect(seen.sim).toBeGreaterThan(0)
  })

  test('a simulated window leaves the tick GLM covers it', async () => {
    const merged = mergeFeeds(fakeGlm(), stubSimFeed())
    // The newest window, not yet ended: simulated, then GLM's once it has.
    const w = wOf(NOW)
    const args = { clockMs: w * WINDOW_MS + 5000, stride: 1, rate: 1, wallMs: 0, nowMs: NOW, fetch: true }
    merged.tick(args)
    await flush()
    merged.tick({ ...args, wallMs: 16 })
    expect(merged.tick({ ...args, wallMs: 32 }).find((b) => b.startMs === w * WINDOW_MS)?.source).toBe('simulated')
    const after = merged.tick({ ...args, wallMs: 48, nowMs: (w + 1) * WINDOW_MS })
    expect(after.filter((b) => b.startMs === w * WINDOW_MS).map((b) => b.source)).toEqual(['glm'])
    assertDisjoint(after)
  })

  test('with the real GLM feed (stub S3) over the latest data and GOES-18’s start, they never share a window', async () => {
    const pad = (n: number, width: number) => String(n).padStart(width, '0')
    const stamp = (ms: number) => {
      const t = new Date(ms)
      const day = Math.floor((ms - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000) + 1
      return `${t.getUTCFullYear()}${pad(day, 3)}${pad(t.getUTCHours(), 2)}${pad(t.getUTCMinutes(), 2)}${pad(t.getUTCSeconds(), 2)}0`
    }
    const keyFor = (sat: GlmSatellite, w: number) => {
      const s = w * WINDOW_MS
      const e = s + WINDOW_MS
      return `${glmHourPrefix(s)}OR_GLM-L2-LCFA_${sat.id}_s${stamp(s)}_e${stamp(e)}_c${stamp(e)}.nc`
    }
    const glm = createGlmFeed({
      list: async (sat, hourMs, startAfter) => {
        const keys: string[] = []
        for (let w = hourMs / WINDOW_MS; w < (hourMs + HOUR_MS) / WINDOW_MS; w++) {
          if (w * WINDOW_MS < sat.fromMs || (w + 1) * WINDOW_MS > NOW) continue
          const key = keyFor(sat, w)
          if (startAfter === null || key > startAfter) keys.push(key)
        }
        return keys
      },
      load: async (sat, key, windowStartMs): Promise<GlmBatch> => ({
        ...batchOf(windowStartMs / WINDOW_MS, 'glm'),
        key,
        lon: new Float32Array([sat.id === 'G19' ? -75 : -137]),
        subpointLon: sat.id === 'G19' ? -75.2 : -137,
      }),
    })
    const merged = mergeFeeds(glm, stubSimFeed())
    const g18 = SATELLITES.find((s) => s.id === 'G18')!.fromMs
    let seen = { glm: 0, sim: 0 }
    let wallMs = 0
    for (const edge of [NOW, g18]) {
      merged.deactivate()
      // At 1x over 12 windows across the edge, a second a tick.
      for (let t = edge - 6 * WINDOW_MS; t < edge + 6 * WINDOW_MS; t += 1000) {
        wallMs += 1000
        const counts = assertDisjoint(merged.tick({ clockMs: t, stride: 1, rate: 1, wallMs, nowMs: NOW, fetch: true }))
        seen = { glm: seen.glm + counts.glm, sim: seen.sim + counts.sim }
        await flush()
      }
    }
    expect(seen.glm).toBeGreaterThan(0)
    expect(seen.sim).toBeGreaterThan(0)
  })
})
