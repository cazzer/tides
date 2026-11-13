import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { backoffMs, createGlmFeed, RELIST_MS, SETTLE_MS, windowWallMs } from './glm-feed'
import { glmHourPrefix, glmKeyWindow, HOUR_MS, SATELLITES, WINDOW_MS, type GlmBatch, type GlmSatellite } from './glm'
import { lightningClock, windowStride } from './lightning'

const NOW = Date.UTC(2026, 10, 13, 12, 30, 7)
/** A file is listed this long after its window ends. */
const POSTED_MS = 15_000

const pad = (n: number, w: number) => String(n).padStart(w, '0')
function keyFor(sat: GlmSatellite, w: number): string {
  const ms = w * WINDOW_MS
  const d = new Date(ms)
  const e = new Date(ms + WINDOW_MS)
  const day = (t: Date) => pad(Math.floor((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000) + 1, 3)
  const stamp = (t: Date) =>
    `${t.getUTCFullYear()}${day(t)}${pad(t.getUTCHours(), 2)}${pad(t.getUTCMinutes(), 2)}${pad(t.getUTCSeconds(), 2)}0`
  return `${glmHourPrefix(ms)}OR_GLM-L2-LCFA_${sat.id}_s${stamp(d)}_e${stamp(e)}_c${stamp(e)}.nc`
}

function batchFor(sat: GlmSatellite, key: string, startMs: number, lons: number[] = [-80, -130]): GlmBatch {
  const n = lons.length
  return {
    source: 'glm',
    key,
    startMs,
    count: n,
    lat: new Float32Array(n),
    lon: Float32Array.from(lons),
    offsetMs: Float32Array.from(lons, (_, i) => 1000 + i * 5000),
    durationMs: new Float32Array(n).fill(200),
    energyJ: new Float32Array(n).fill(1e-13),
    areaKm2: new Float32Array(n).fill(300),
    owned: new Uint8Array(n),
    subpointLon: sat.id === 'G19' ? -75.2 : -137,
  }
}

interface Call {
  sat: GlmSatellite
  wall: number
  signal: AbortSignal
  resolve: (v: never) => void
  reject: (e: unknown) => void
}
interface ListCall extends Call {
  hourMs: number
  startAfter: string | null
}
interface LoadCall extends Call {
  key: string
  window: number
}

/**
 * A feed over a fake S3, on a stepped wall clock. `auto`: listings answer
 * with the files posted by then, loads with a batch, both at once; else the
 * test settles each call itself.
 */
function harness({
  auto = true,
  failLoads = false,
  startNow = NOW,
}: { auto?: boolean; failLoads?: boolean; startNow?: number } = {}) {
  const lists: ListCall[] = []
  const loads: LoadCall[] = []
  let wall = 0
  let now = startNow
  const state = { failLoads }
  const feed = createGlmFeed({
    list: (sat, hourMs, startAfter, signal) =>
      new Promise((resolve, reject) => {
        lists.push({ sat, hourMs, startAfter, signal, wall, resolve: resolve as never, reject })
        if (!auto) return
        const keys: string[] = []
        for (let w = hourMs / WINDOW_MS; w < (hourMs + HOUR_MS) / WINDOW_MS; w++) {
          if ((w + 1) * WINDOW_MS + POSTED_MS > now || w * WINDOW_MS < sat.fromMs) continue
          const key = keyFor(sat, w)
          if (startAfter === null || key > startAfter) keys.push(key)
        }
        resolve(keys)
      }),
    load: (sat, key, windowStartMs, signal) =>
      new Promise((resolve, reject) => {
        loads.push({ sat, key, window: windowStartMs / WINDOW_MS, signal, wall, resolve: resolve as never, reject })
        if (!auto) return
        if (state.failLoads) reject(new Error('boom'))
        else resolve(batchFor(sat, key, windowStartMs))
      }),
  })
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  }
  /** Plays `seconds` of wall time from scene time `sceneMs` at `rate`, ticking every `stepMs`. */
  async function play(sceneMs: number, rate: number, seconds: number, { stepMs = 100, fetch = true } = {}) {
    const startWall = wall
    const startNow = now
    let last: readonly GlmBatch[] | null = null
    for (let t = 0; t <= seconds * 1000; t += stepMs) {
      wall = startWall + t
      now = startNow + t
      const scene = sceneMs + rate * t
      last = feed.tick({
        clockMs: lightningClock(scene, now),
        stride: windowStride(rate),
        rate,
        wallMs: wall,
        nowMs: now,
        fetch,
      }) as readonly GlmBatch[]
      await settle()
    }
    return last!
  }
  return {
    feed,
    lists,
    loads,
    play,
    settle,
    state,
    get wall() {
      return wall
    },
  }
}

const g19 = <C extends Call>(calls: C[]) => calls.filter((c) => c.sat.id === 'G19')
const gaps = (calls: Call[]) => calls.slice(1).map((c, i) => c.wall - calls[i].wall)

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('createGlmFeed', () => {
  test('pacing helpers', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffMs)).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000])
    expect(windowWallMs(1, 1)).toBe(20_000)
    expect(windowWallMs(1024, 3600)).toBeCloseTo(5689, 0)
    expect(windowWallMs(1, 0)).toBe(Infinity)
  })

  test('live at 1x: one file and at most one listing per satellite per 20 s, every window played', async () => {
    const h = harness()
    await h.play(NOW, 1, 600)
    for (const sat of SATELLITES) {
      const loads = h.loads.filter((c) => c.sat === sat)
      const lists = h.lists.filter((c) => c.sat === sat)
      // 10 minutes is 30 windows: the one the clock starts in, then each as it is reached.
      expect(loads.length).toBeGreaterThanOrEqual(30)
      expect(loads.length).toBeLessThanOrEqual(31)
      // The first window starts mid-way; the next two catch up to a window
      // ahead, at least half a window's play apart; after that, a window's
      // play apart (to the tick).
      for (const gap of gaps(loads)) expect(gap).toBeGreaterThanOrEqual(10_000)
      for (const gap of gaps(loads).slice(2)) expect(gap).toBeGreaterThanOrEqual(20_000 - 100)
      for (const gap of gaps(lists)) expect(gap).toBeGreaterThanOrEqual(RELIST_MS)
      const windows = loads.map((c) => c.window)
      expect(windows).toEqual(windows.map((_, i) => windows[0] + i))
      // Never a window that has not ended.
      for (const c of loads) expect((c.window + 1) * WINDOW_MS).toBeLessThanOrEqual(NOW + c.wall)
    }
  })

  test('live across an hour: the new hour is listed a window after the last listing', async () => {
    const start = Date.UTC(2026, 10, 13, 13, 0, 45)
    const h = harness({ startNow: start })
    await h.play(start, 1, 180)
    const lists = g19(h.lists)
    expect(new Set(lists.map((c) => c.hourMs))).toEqual(new Set([Date.UTC(2026, 10, 13, 12), Date.UTC(2026, 10, 13, 13)]))
    // The cold start's catch-up lists the new hour half a window on; then a window apart.
    expect(gaps(lists)[0]).toBeGreaterThanOrEqual(10_000)
    for (const gap of gaps(lists).slice(1)) expect(gap).toBeGreaterThanOrEqual(RELIST_MS - 100)
    const windows = g19(h.loads).map((c) => c.window)
    expect(windows).toEqual(windows.map((_, i) => windows[0] + i))
  })

  test('the newest data plays a minute late', async () => {
    const h = harness()
    await h.play(NOW, 1, 1)
    expect(h.loads[0].window).toBe(Math.floor((NOW - 60_000) / WINDOW_MS))
  })

  test('nothing for a scene in the future', async () => {
    const h = harness()
    await h.play(NOW + 86_400_000, 1, 120)
    expect(h.lists.length + h.loads.length).toBe(0)
  })

  test('nothing before the archives; only GOES-18 before GOES-19 had GLM files', async () => {
    const early = harness()
    await early.play(Date.UTC(2021, 5, 1), 1, 60)
    expect(early.lists.length + early.loads.length).toBe(0)
    const mid = harness()
    await mid.play(Date.UTC(2023, 5, 1, 12), 1, 60)
    expect(mid.loads.length).toBeGreaterThan(0)
    expect(mid.lists.every((c) => c.sat.id === 'G18') && mid.loads.every((c) => c.sat.id === 'G18')).toBe(true)
    // With no GOES-19 data the GOES-18 batch draws every flash.
    const batches = await mid.play(Date.UTC(2023, 5, 1, 12) + 60_000, 1, 1)
    expect(batches.length).toBeGreaterThan(0)
    expect([...batches[0].owned]).toEqual([1, 1])
  })

  test('nothing while the caller says not to fetch', async () => {
    const h = harness()
    await h.play(NOW, 1, 120, { fetch: false })
    expect(h.lists.length + h.loads.length).toBe(0)
  })

  test('errors back off 10 s, 20 s, 40 s ... up to 5 min, and a success resets it', async () => {
    const h = harness({ failLoads: true })
    const scene = Date.UTC(2026, 10, 10, 6)
    // Paused, so every start is a retry of the same window.
    await h.play(scene, 0, 1200, { stepMs: 500 })
    const starts = g19(h.loads)
    expect(gaps(starts).slice(0, 7)).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000])
    h.state.failLoads = false
    const before = g19(h.loads).length
    await h.play(scene, 0, 400, { stepMs: 500 })
    expect(g19(h.loads).length).toBe(before + 1)
    // Reset: the next failure waits 10 s again.
    h.state.failLoads = true
    await h.play(scene + 3 * WINDOW_MS, 0, 15, { stepMs: 500 })
    expect(gaps(g19(h.loads).slice(-2))).toEqual([10_000])
  })

  test('a jump abandons downloads it no longer needs and waits for the target to settle', async () => {
    const h = harness({ auto: false })
    const scene = Date.UTC(2026, 10, 10, 6)
    await h.play(scene, 0, 0.1)
    expect(g19(h.lists)).toHaveLength(1)
    const listing = g19(h.lists)[0]
    // The hour's listing returns; its window starts.
    listing.resolve([keyFor(listing.sat, scene / WINDOW_MS)] as never)
    await h.play(scene, 0, 0.1)
    const first = g19(h.loads)[0]
    expect(first.window).toBe(scene / WINDOW_MS)
    // Jump a day on: the stale download is aborted, and nothing starts
    // before the target has held SETTLE_MS.
    const target = scene + 86_400_000
    await h.play(target, 0, (SETTLE_MS - 100) / 1000)
    expect(first.signal.aborted).toBe(true)
    expect(g19(h.lists)).toHaveLength(1)
    await h.play(target, 0, 0.2)
    expect(g19(h.lists)).toHaveLength(2)
    expect(g19(h.lists)[1].hourMs).toBe(target)
  })

  test('at 3600x only every 1024th window plays, a few seconds of wall time apart', async () => {
    const h = harness()
    const rate = 3600
    expect(windowStride(rate)).toBe(1024)
    const scene = Date.UTC(2026, 9, 1)
    await h.play(scene, rate, 120, { stepMs: 50 })
    const loads = g19(h.loads)
    expect(loads.length).toBeGreaterThan(10)
    for (const c of loads) expect(c.window % 1024).toBe(0)
    // 120 s at ~5.7 s a window, plus the one started mid-way.
    expect(loads.length).toBeLessThanOrEqual(Math.ceil(120_000 / windowWallMs(1024, rate)) + 2)
    for (const gap of gaps(loads).slice(1)) expect(gap).toBeGreaterThanOrEqual(windowWallMs(1024, rate) - 50)
  })

  test("an hour is listed once when finished, again after its last key while it isn't", async () => {
    const past = harness()
    const scene = Date.UTC(2026, 10, 10, 6, 10)
    await past.play(scene, 4, 60)
    // 60 s at 4x is 12 windows, all in one finished hour: one listing.
    expect(g19(past.lists)).toHaveLength(1)
    expect(g19(past.loads).length).toBeGreaterThanOrEqual(12)

    const live = harness()
    await live.play(NOW, 1, 90)
    const lists = g19(live.lists)
    expect(lists[0].startAfter).toBeNull()
    expect(lists.length).toBeGreaterThan(1)
    for (const c of lists.slice(1)) expect(c.startAfter).toMatch(/^GLM-L2-LCFA\/2026\/317\/12\//)
  })

  test("a window missing from a finished hour's listing is empty: no download", async () => {
    const h = harness({ auto: false })
    const scene = Date.UTC(2026, 10, 10, 6, 10)
    await h.play(scene, 0, 0.1)
    for (const c of h.lists) c.resolve([] as never)
    await h.play(scene, 0, 30)
    expect(h.loads).toHaveLength(0)
    expect(h.lists).toHaveLength(2)
  })

  test('returns the same array every tick', () => {
    const h = harness()
    const args = { clockMs: NOW - 60_000, stride: 1, rate: 1, wallMs: 0, nowMs: NOW, fetch: true }
    expect(h.feed.tick(args)).toBe(h.feed.tick({ ...args, wallMs: 16 }))
  })

  test('a batch plays once both satellites have the window, each flash from the nearer', async () => {
    const h = harness({ auto: false })
    const scene = Date.UTC(2026, 10, 10, 6, 10)
    const w = scene / WINDOW_MS
    await h.play(scene, 0, 0.1)
    for (const c of h.lists) c.resolve([keyFor(c.sat, w)] as never)
    let batches = await h.play(scene, 0, 0.1)
    const [east, west] = SATELLITES.map((sat) => h.loads.find((c) => c.sat === sat)!)
    east.resolve(batchFor(east.sat, east.key, w * WINDOW_MS, [-80, -130]) as never)
    batches = await h.play(scene, 0, 0.1)
    expect(batches).toHaveLength(0)
    west.resolve(batchFor(west.sat, west.key, w * WINDOW_MS, [-80, -130]) as never)
    batches = await h.play(scene, 0, 0.1)
    expect(batches.map((b) => [b.key.includes('_G19_'), [...b.owned]])).toEqual([
      [true, [1, 0]],
      [false, [0, 1]],
    ])
    expect(glmKeyWindow(batches[0].key)).toBe(w)
  })

  test('deactivate drops in-flight downloads and keeps what is loaded', async () => {
    const h = harness({ auto: false })
    const scene = Date.UTC(2026, 10, 10, 6, 10)
    const w = scene / WINDOW_MS
    await h.play(scene, 0, 0.1)
    for (const c of h.lists) c.resolve([keyFor(c.sat, w), keyFor(c.sat, w + 1)] as never)
    await h.play(scene, 0, 0.1)
    for (const c of h.loads) c.resolve(batchFor(c.sat, c.key, w * WINDOW_MS) as never)
    // Paused a while, then playing into the window's last quarter: the next one starts.
    await h.play(scene, 0, 10)
    await h.play(scene + WINDOW_MS - 4000, 1, 0.2)
    const inFlight = h.loads.filter((c) => c.window === w + 1)
    expect(inFlight).toHaveLength(2)
    h.feed.deactivate()
    for (const c of inFlight) expect(c.signal.aborted).toBe(true)
    for (const c of inFlight) c.resolve(batchFor(c.sat, c.key, (w + 1) * WINDOW_MS) as never)
    const batches = await h.play(scene, 0, 0.1, { fetch: false })
    expect(batches.map((b) => glmKeyWindow(b.key))).toEqual([w, w])
  })
})
