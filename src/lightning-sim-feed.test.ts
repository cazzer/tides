import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { backoffMs, glmCovers } from './glm-feed'
import { SATELLITES } from './glm'
import { WINDOW_MS, type FlashBatch, type LightningFeed, type LightningTick } from './lightning'
import { syntheticClimatology, type LightningClimatology } from './lightning-climatology'
import { simulateWindow, type SimClouds, type SimFrame } from './lightning-sim'
import { createSimulatedFeed, mergeFeeds } from './lightning-sim-feed'

const NOW = Date.UTC(2026, 10, 13, 12, 30, 7)
const CLIM = {} as LightningClimatology
const frameA: SimFrame = { cover: null, precip: null }
const frameB: SimFrame = { cover: null, precip: null }

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

/** A simulated feed whose climatology loads when told (or at once with `auto`). */
function harness({ auto = true, covers = (w: number, nowMs: number) => glmCovers(w, nowMs) } = {}) {
  const loads: { resolve: (c: LightningClimatology) => void; reject: (e: unknown) => void; signal: AbortSignal }[] = []
  const made: number[] = []
  const shown: SimClouds = { a: frameA, b: frameB, mix: 0.3 }
  const clouds = { value: shown as SimClouds | null }
  const feed = createSimulatedFeed({
    loadClimatology: (signal) =>
      auto ? Promise.resolve(CLIM) : new Promise((resolve, reject) => loads.push({ resolve, reject, signal })),
    clouds: () => clouds.value,
    covers,
    simulate: (w) => {
      made.push(w)
      return batchOf(w)
    },
  })
  const args: LightningTick = { clockMs: 0, stride: 1, rate: 1, wallMs: 0, nowMs: NOW, fetch: true }
  const tick = (over: Partial<LightningTick> = {}) => feed.tick(Object.assign(args, over))
  return { feed, loads, made, clouds, shown, args, tick }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const FUTURE = NOW + 3 * 86_400_000
const wOf = (ms: number) => Math.floor(ms / WINDOW_MS)

describe('createSimulatedFeed', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('plays the windows GLM has no file for, one made per tick, the current first', async () => {
    const h = harness()
    h.tick({ clockMs: FUTURE })
    await flush()
    const wc = wOf(FUTURE)
    expect(h.tick({ clockMs: FUTURE }).map((b) => b.startMs)).toEqual([wc * WINDOW_MS])
    expect(h.made).toEqual([wc])
    h.tick({ clockMs: FUTURE + 1 })
    expect(h.made).toEqual([wc, wc + 1])
    // Both made: nothing more.
    h.tick({ clockMs: FUTURE + 2 })
    expect(h.made).toEqual([wc, wc + 1])
    // Played backward, the next is the one before.
    h.tick({ clockMs: FUTURE + 3, rate: -1 })
    expect(h.made).toEqual([wc, wc + 1, wc - 1])
  })

  test('the same array every tick', async () => {
    const h = harness()
    const first = h.tick({ clockMs: FUTURE })
    await flush()
    for (let i = 0; i < 5; i++) expect(h.tick({ clockMs: FUTURE + i * 7000 })).toBe(first)
    const merged = mergeFeeds(h.feed, h.feed)
    const out = merged.tick(h.args)
    expect(merged.tick(h.args)).toBe(out)
  })

  test('makes nothing while paused, while told not to fetch, or while the climatology loads', async () => {
    const h = harness({ auto: false })
    h.tick({ clockMs: FUTURE })
    expect(h.loads).toHaveLength(1)
    h.tick({ clockMs: FUTURE + 5000 })
    expect(h.made).toEqual([])
    h.loads[0].resolve(CLIM)
    await flush()
    h.tick({ clockMs: FUTURE, rate: 0 })
    h.tick({ clockMs: FUTURE, fetch: false })
    expect(h.made).toEqual([])
    h.tick({ clockMs: FUTURE, rate: 1, fetch: true })
    expect(h.made).toHaveLength(1)
  })

  test("loads the climatology once, only when a window needs it, and backs off on errors", async () => {
    const h = harness({ auto: false })
    // GLM covers it: nothing to load for.
    h.tick({ clockMs: NOW - 120_000 })
    h.tick({ clockMs: FUTURE, fetch: false })
    expect(h.loads).toHaveLength(0)
    h.tick({ clockMs: FUTURE, wallMs: 0, fetch: true })
    h.tick({ clockMs: FUTURE, wallMs: 1 })
    expect(h.loads).toHaveLength(1)
    h.loads[0].reject(new Error('HTTP 404'))
    await flush()
    h.tick({ wallMs: backoffMs(1) - 1 })
    expect(h.loads).toHaveLength(1)
    h.tick({ wallMs: backoffMs(1) })
    expect(h.loads).toHaveLength(2)
    h.loads[1].reject(new Error('HTTP 404'))
    await flush()
    h.tick({ wallMs: backoffMs(1) + backoffMs(2) - 1 })
    expect(h.loads).toHaveLength(2)
    h.tick({ wallMs: backoffMs(1) + backoffMs(2) })
    expect(h.loads).toHaveLength(3)
    h.loads[2].resolve(CLIM)
    await flush()
    for (let i = 0; i < 10; i++) h.tick({ wallMs: 1e6 + i * 1e6 })
    expect(h.loads).toHaveLength(3)
    expect(h.made.length).toBeGreaterThan(0)
  })

  test('deactivate drops the climatology in flight; the next need loads it again', async () => {
    const h = harness({ auto: false })
    h.tick({ clockMs: FUTURE })
    h.feed.deactivate()
    expect(h.loads[0].signal.aborted).toBe(true)
    h.loads[0].resolve(CLIM)
    await flush()
    h.tick({ clockMs: FUTURE })
    expect(h.made).toEqual([])
    expect(h.loads).toHaveLength(2)
  })

  test('makes a window again when the clouds drawn at it change, not for a mix within its step', async () => {
    const h = harness()
    h.tick({ clockMs: FUTURE })
    await flush()
    h.tick({ clockMs: FUTURE })
    h.tick({ clockMs: FUTURE })
    expect(h.made).toHaveLength(2)
    h.shown.mix = 0.3 + 0.02
    h.tick({ clockMs: FUTURE })
    expect(h.made).toHaveLength(2)
    h.shown.mix = 0.5
    h.tick({ clockMs: FUTURE })
    expect(h.made).toHaveLength(3)
    h.shown.a = frameB
    h.tick({ clockMs: FUTURE })
    expect(h.made).toHaveLength(4)
    // No clouds loaded: nothing made, what was made still plays.
    h.clouds.value = null
    h.shown.b = frameA
    expect(h.tick({ clockMs: FUTURE })).toHaveLength(2)
    expect(h.made).toHaveLength(4)
  })

  test("a window is the same at any speed: the stride doesn't reach it", async () => {
    const clim = syntheticClimatology({ density: 0.003, cover: 1 })
    const batches: FlashBatch[][] = []
    for (const stride of [1, 4]) {
      const feed = createSimulatedFeed({
        loadClimatology: async () => clim,
        clouds: () => ({ a: null, b: null, mix: 0 }),
        covers: (w, nowMs) => glmCovers(w, nowMs),
      })
      const w = wOf(FUTURE) - (wOf(FUTURE) % 4)
      const args = { clockMs: w * WINDOW_MS + 100, stride, rate: stride * 4, wallMs: 0, nowMs: NOW, fetch: true }
      feed.tick(args)
      await flush()
      batches.push([...feed.tick(args)])
    }
    expect(batches[0][0].key).toBe(batches[1][0].key)
    expect(batches[1][0]).toEqual(batches[0][0])
    expect(batches[0][0]).toEqual(simulateWindow(batches[0][0].startMs / WINDOW_MS, clim, { a: null, b: null, mix: 0 }))
  })
})

describe('GLM and simulated lightning at their seams', () => {
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

  function assertDisjoint(batches: readonly FlashBatch[]) {
    const glm = new Set(batches.filter((b) => b.source === 'glm').map((b) => b.startMs))
    const sim = batches.filter((b) => b.source === 'simulated').map((b) => b.startMs)
    for (const s of sim) expect(glm.has(s)).toBe(false)
    return { glm: glm.size, sim: sim.length }
  }

  test('sweeping the clock over the latest data, and over the archives’ starts, no window plays twice', async () => {
    const h = harness()
    const merged = mergeFeeds(fakeGlm(), h.feed)
    const g18 = SATELLITES.find((s) => s.id === 'G18')!.fromMs
    const g19 = SATELLITES.find((s) => s.id === 'G19')!.fromMs
    let seen = { glm: 0, sim: 0 }
    for (const edge of [NOW, g18, g19]) {
      for (const stride of [1, 8]) {
        merged.tick({ clockMs: edge - 30 * stride * WINDOW_MS, stride, rate: stride * 4, wallMs: 0, nowMs: NOW, fetch: true })
        await flush()
        for (let t = edge - 30 * stride * WINDOW_MS; t < edge + 30 * stride * WINDOW_MS; t += 3000 * stride) {
          const counts = assertDisjoint(merged.tick({ clockMs: t, stride, rate: stride * 4, wallMs: 0, nowMs: NOW, fetch: true }))
          seen = { glm: seen.glm + counts.glm, sim: seen.sim + counts.sim }
        }
      }
    }
    // Both played somewhere (G19's start is inside G18's archive: GLM's alone).
    expect(seen.glm).toBeGreaterThan(0)
    expect(seen.sim).toBeGreaterThan(0)
  })

  test('a simulated window leaves the tick GLM covers it', async () => {
    const h = harness()
    const merged = mergeFeeds(fakeGlm(), h.feed)
    // The newest window, not yet ended: simulated, then GLM's once it has.
    const w = wOf(NOW)
    const args = { clockMs: w * WINDOW_MS + 5000, stride: 1, rate: 1, wallMs: 0, nowMs: NOW, fetch: true }
    merged.tick(args)
    await flush()
    merged.tick(args)
    expect(merged.tick(args).find((b) => b.startMs === w * WINDOW_MS)?.source).toBe('simulated')
    const after = merged.tick({ ...args, nowMs: (w + 1) * WINDOW_MS })
    expect(after.filter((b) => b.startMs === w * WINDOW_MS).map((b) => b.source)).toEqual(['glm'])
    assertDisjoint(after)
  })
})
