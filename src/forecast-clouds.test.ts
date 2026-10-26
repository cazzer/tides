import { describe, expect, test, vi } from 'vitest'
import {
  CALIBRATION_RANGE,
  coverAt,
  coverCalibration,
  COVER_PAST_DAYS,
  coverRequestBody,
  createCoverGridSource,
  FORECAST_RETRY_MAX_MS,
  FORECAST_RETRY_MS,
  FORECAST_STALE_MAX_MS,
  FORECAST_TAU_MS,
  forecastAlpha,
  GRID_LATS,
  GRID_LONS,
  GRID_POINTS,
  leadWeight,
  parseCoverGrid,
  retryDelayMs,
  sampleCover,
  structureRank,
  synthesiseForecast,
  zonalDriftDegPerHour,
  alphaQuantiles,
  DRIFT_MAX_MS,
  driftPx,
  mixUniform,
  resampleWeight,
  layersAt,
  sampleCoverSmooth,
  type FetchBackoff,
} from './forecast-clouds'
import { FORECAST_TTL_MS, HOUR_MS, OUT_H, OUT_W } from './real-clouds'

const NOW = Date.UTC(2026, 9, 18, 15, 30)
const START = Date.UTC(2026, 9, 17)

/** An Open-Meteo multi-location response: `value(point, hour)` in percent. */
function response(
  value: (i: number, h: number) => number | null = (i, h) => (i + h) % 101,
  hours = 48
) {
  return Array.from({ length: GRID_POINTS }, (_, i) => ({
    // Snapped to a model grid, as Open-Meteo does.
    latitude: GRID_LATS[Math.floor(i / 36)] + 0.06,
    longitude: GRID_LONS[i % 36] - 0.1,
    hourly: {
      time: Array.from({ length: hours }, (_, h) => START / 1000 + h * 3600),
      cloud_cover: Array.from({ length: hours }, (_, h) => value(i, h)),
    },
  }))
}

/** response() with the low, mid and high layers too, in percent. */
function layeredResponse(
  layer: (key: 'low' | 'mid' | 'high', i: number, h: number) => number | null,
  hours = 48
) {
  return response(undefined, hours).map((point, i) => ({
    ...point,
    hourly: {
      ...point.hourly,
      cloud_cover_low: Array.from({ length: hours }, (_, h) => layer('low', i, h)),
      cloud_cover_mid: Array.from({ length: hours }, (_, h) => layer('mid', i, h)),
      cloud_cover_high: Array.from({ length: hours }, (_, h) => layer('high', i, h)),
    },
  }))
}

describe('coverRequestBody', () => {
  test('every grid point, hourly cover and its layers from two days back for a week, in unix time', () => {
    const body = coverRequestBody()
    const lats = body.get('latitude')!.split(',').map(Number)
    const lons = body.get('longitude')!.split(',').map(Number)
    expect(lats).toHaveLength(GRID_POINTS)
    expect(lons).toHaveLength(GRID_POINTS)
    expect([lats[0], lons[0], lats[1], lons[1], lats[36]]).toEqual([85, -180, 85, -170, 75])
    expect(lats[GRID_POINTS - 1]).toBe(-85)
    expect(lons[GRID_POINTS - 1]).toBe(170)
    expect(body.get('hourly')).toBe('cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high')
    expect(body.get('forecast_days')).toBe('7')
    expect(body.get('past_days')).toBe('2')
    expect(COVER_PAST_DAYS).toBe(2)
    expect(body.get('timeformat')).toBe('unixtime')
  })
})

describe('parseCoverGrid', () => {
  test('a valid response', () => {
    const grid = parseCoverGrid(response())
    expect(grid.startMs).toBe(START)
    expect(grid.hours).toBe(48)
    expect(grid.cover[3 * GRID_POINTS + 10]).toBeCloseTo(0.13)
    // Without layers (a grid stored before tides-tvr.4.1): untyped.
    expect(grid.layers).toBeNull()
  })

  test('a response with layers', () => {
    const grid = parseCoverGrid(
      layeredResponse((key, i, h) => (key === 'low' ? 10 : key === 'mid' ? 20 : (i + h) % 101))
    )
    expect(grid.cover[3 * GRID_POINTS + 10]).toBeCloseTo(0.13)
    expect(grid.layers!.low[5 * GRID_POINTS + 7]).toBeCloseTo(0.1)
    expect(grid.layers!.mid[5 * GRID_POINTS + 7]).toBeCloseTo(0.2)
    expect(grid.layers!.high[3 * GRID_POINTS + 10]).toBeCloseTo(0.13)
  })

  test('layers missing at one point, the wrong length or full of gaps leave the cover, untyped', () => {
    const missing = layeredResponse(() => 50)
    delete (missing[100].hourly as Partial<(typeof missing)[0]['hourly']>).cloud_cover_mid
    const short = layeredResponse(() => 50)
    short[3].hourly.cloud_cover_high.pop()
    const gappy = layeredResponse((key, i) => (key === 'low' && i < 70 ? null : 50))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const json of [missing, short, gappy]) {
      const grid = parseCoverGrid(json)
      expect(grid.layers).toBeNull()
      expect(grid.cover[3 * GRID_POINTS + 10]).toBeCloseTo(0.13)
    }
    warn.mockRestore()
  })

  test("fills a layer's odd missing value with its row mean at that hour", () => {
    const grid = parseCoverGrid(layeredResponse((key, i, h) => (key === 'high' && h === 2 && i === 80 ? null : 30)))
    expect(grid.layers!.high[2 * GRID_POINTS + 80]).toBeCloseTo(0.3)
  })

  test.each([
    ['an error object', { error: true, reason: 'Too many locations' }, /Too many locations/],
    ['not an array', { hourly: {} }, /not an array/],
    ['the wrong number of points', response().slice(1), /647 locations/],
    [
      'points out of order',
      (() => {
        const r = response()
        ;[r[0], r[1]] = [r[1], r[0]]
        return r
      })(),
      /location 0 is not near/,
    ],
    [
      'irregular times',
      (() => {
        const r = response()
        r[0].hourly.time[5] += 60
        return r
      })(),
      /not hourly/,
    ],
    [
      'times differing between points',
      (() => {
        const r = response()
        r[3].hourly.time = r[3].hourly.time.map((t) => t + 3600)
        return r
      })(),
      /different times/,
    ],
    [
      'fewer values than hours',
      (() => {
        const r = response()
        r[7].hourly.cloud_cover.pop()
        return r
      })(),
      /47 values for 48 hours/,
    ],
    ['too few hours', response(undefined, 12), /only 12 hours/],
    ['more than 10% missing', response((i) => (i < 70 ? null : 50)), /missing or out of range/],
  ])('refuses %s', (_, json, reason) => {
    expect(() => parseCoverGrid(json)).toThrow(reason)
  })

  test('fills the odd missing value with its row mean at that hour', () => {
    // Row 2 (points 72-107) is 40% except two holes; one value is out of range.
    const grid = parseCoverGrid(
      response((i, h) => (h === 5 && (i === 80 || i === 81) ? null : i === 90 && h === 6 ? 140 : 40))
    )
    expect(grid.cover[5 * GRID_POINTS + 80]).toBeCloseTo(0.4)
    expect(grid.cover[6 * GRID_POINTS + 90]).toBeCloseTo(0.4)
  })
})

test('coverAt: linear between hours, null outside the grid', () => {
  const grid = parseCoverGrid(response((i, h) => (h % 2 ? 60 : 20)))
  expect(coverAt(grid, START + 2 * HOUR_MS)![0]).toBeCloseTo(0.2)
  expect(coverAt(grid, START + 2.5 * HOUR_MS)![0]).toBeCloseTo(0.4)
  expect(coverAt(grid, START - 1)).toBeNull()
  expect(coverAt(grid, START + 47 * HOUR_MS)).not.toBeNull()
  expect(coverAt(grid, START + 47 * HOUR_MS + 1)).toBeNull()
})

test('layersAt: linear between hours, null outside the grid or without layers', () => {
  const grid = parseCoverGrid(layeredResponse((key, i, h) => (key === 'low' ? (h % 2 ? 60 : 20) : key === 'mid' ? 5 : 70)))
  const at = layersAt(grid, START + 2.5 * HOUR_MS)!
  expect(at.low[0]).toBeCloseTo(0.4)
  expect(at.mid[GRID_POINTS - 1]).toBeCloseTo(0.05)
  expect(at.high[300]).toBeCloseTo(0.7)
  expect(layersAt(grid, START - 1)).toBeNull()
  expect(layersAt(grid, START + 47 * HOUR_MS + 1)).toBeNull()
  expect(layersAt(parseCoverGrid(response()), START + HOUR_MS)).toBeNull()
})

test('sampleCoverSmooth: through the cell centres, flat at them, continuous across 180°', () => {
  const values = Float32Array.from({ length: GRID_POINTS }, (_, i) => (i % 36) + Math.floor(i / 36) * 100)
  expect(sampleCoverSmooth(values, 85, -180)).toBeCloseTo(0)
  expect(sampleCoverSmooth(values, 75, -170)).toBeCloseTo(101)
  // Half way the same as linear; a quarter of the way less far.
  expect(sampleCoverSmooth(values, 80, -175)).toBeCloseTo(sampleCover(values, 80, -175))
  expect(sampleCoverSmooth(values, 85, -177.5)).toBeCloseTo(0.15625)
  expect(Math.abs(sampleCoverSmooth(values, 0, 179.999) - sampleCoverSmooth(values, 0, -179.999))).toBeLessThan(0.01)
  expect(sampleCoverSmooth(values, -89, 0)).toBeCloseTo(sampleCoverSmooth(values, -85, 0))
})

test('sampleCover: continuous across 180°, clamped beyond the outer rows', () => {
  const values = Float32Array.from({ length: GRID_POINTS }, (_, i) => (i % 36) + Math.floor(i / 36) * 100)
  const west = sampleCover(values, 0, 179.999)
  const east = sampleCover(values, 0, -179.999)
  expect(Math.abs(west - east)).toBeLessThan(0.01)
  expect(sampleCover(values, 89, 0)).toBeCloseTo(sampleCover(values, 85, 0))
  expect(sampleCover(values, -89, 0)).toBeCloseTo(sampleCover(values, -85, 0))
  expect(sampleCover(values, 80, -180)).toBeCloseTo(50)
})

test('leadWeight', () => {
  expect(leadWeight(0)).toBe(0)
  expect(leadWeight(FORECAST_TAU_MS)).toBeCloseTo(1 - 1 / Math.E)
  expect(leadWeight(HOUR_MS)).toBeLessThan(leadWeight(2 * HOUR_MS))
  expect(leadWeight(10 * FORECAST_TAU_MS)).toBeGreaterThan(0.99)
})

describe('forecastAlpha', () => {
  test('the observation as is when the cover holds', () => {
    expect(forecastAlpha(0.7, 0.5, 0.5, 1, 0)).toBeCloseTo(0.7)
  })
  test('thinned with falling cover, gone with none', () => {
    expect(forecastAlpha(0.8, 0.6, 0.3, 1, 0)).toBeCloseTo(0.4)
    expect(forecastAlpha(0.8, 0.6, 0, 0, 0)).toBe(0)
  })
  test('grown only where the synthetic cloud is', () => {
    expect(forecastAlpha(0.2, 0.2, 0.6, 0, 0)).toBeCloseTo(0.2)
    expect(forecastAlpha(0.2, 0.2, 0.6, 1, 0)).toBeCloseTo(0.6)
  })
  test('all synthetic at full weight', () => {
    expect(forecastAlpha(0.9, 0.5, 0.5, 0.25, 1)).toBeCloseTo(0.25)
  })
})

test('zonalDriftDegPerHour: trades west, westerlies east, still at the poles', () => {
  expect(zonalDriftDegPerHour(10)).toBeLessThan(0)
  expect(zonalDriftDegPerHour(50)).toBeGreaterThan(0)
  expect(zonalDriftDegPerHour(-50)).toBeCloseTo(zonalDriftDegPerHour(50))
  expect(zonalDriftDegPerHour(-10)).toBeCloseTo(zonalDriftDegPerHour(10))
  expect(Math.abs(zonalDriftDegPerHour(90))).toBeLessThan(1e-9)
  // About 4.2 m/s at 60°: 0.27°/h.
  expect(zonalDriftDegPerHour(60)).toBeCloseTo(0.275, 2)
})

test('structureRank is uniform and keeps the order', () => {
  const alpha = new Uint8Array(OUT_W * OUT_H)
  for (let p = 0; p < alpha.length; p++) alpha[p] = Math.floor(((p % OUT_W) * 255) / OUT_W)
  const rank = structureRank(alpha)
  let low = 0
  for (const r of rank) if (r < 16384) low++
  expect(low / rank.length).toBeCloseTo(0.25, 1)
  const row = 600 * OUT_W
  expect(rank[row + 600]).toBeLessThan(rank[row + 1800])
})

test('structureRank orders a cloudless region into patches, not one tie', () => {
  // The west half has no cloud at all.
  const alpha = new Uint8Array(OUT_W * OUT_H)
  for (let p = 0; p < alpha.length; p++) alpha[p] = p % OUT_W < OUT_W / 2 ? 0 : 128 + (p % 97)
  const rank = structureRank(alpha)
  const clear: number[] = []
  for (let y = 100; y < OUT_H - 100; y += 37) {
    for (let x = 100; x < OUT_W / 2 - 100; x += 41) clear.push(rank[y * OUT_W + x])
  }
  const lo = Math.min(...clear)
  const hi = Math.max(...clear)
  // Spread over most of the half of the ranks the clear region holds.
  expect(hi - lo).toBeGreaterThan(0.3 * 65535)
  expect(new Set(clear).size).toBeGreaterThan(clear.length / 4)
})

test('drift is capped and gentle from one latitude to the next', () => {
  expect(driftPx(50, 48 * HOUR_MS)).toBe(driftPx(50, DRIFT_MAX_MS))
  expect(driftPx(50, 120 * HOUR_MS)).toBe(driftPx(50, DRIFT_MAX_MS))
  const lead = 120 * HOUR_MS
  let steepest = 0
  for (let y = 0; y + 1 < OUT_H; y++) {
    const lat = (row: number) => 90 - ((row + 0.5) / OUT_H) * 180
    steepest = Math.max(steepest, Math.abs(driftPx(lat(y + 1), lead) - driftPx(lat(y), lead)))
  }
  expect(steepest).toBeLessThan(1)
})

test('resampling cross-fades away and back, keeping a rank uniform', () => {
  expect(resampleWeight(DRIFT_MAX_MS)).toBe(0)
  expect(resampleWeight(DRIFT_MAX_MS + 24 * HOUR_MS)).toBeCloseTo(1)
  expect(resampleWeight(DRIFT_MAX_MS + 48 * HOUR_MS)).toBeCloseTo(0)
  for (const b of [0.2, 0.5]) {
    let low = 0
    let n = 0
    for (let i = 0; i < 100; i++) {
      for (let j = 0; j < 100; j++) {
        const u = mixUniform((i + 0.5) / 100, (j + 0.5) / 100, b)
        if (u < 0.25) low++
        n++
      }
    }
    expect(low / n).toBeCloseTo(0.25, 2)
  }
})

describe('synthesis', () => {
  const pixels = OUT_W * OUT_H
  const hash = (p: number) => (Math.imul(p, 2654435761) >>> 0) / 4294967296
  const uniformRank = () => {
    const rank = new Uint16Array(pixels)
    for (let p = 0; p < pixels; p++) rank[p] = (p * 40503) & 0xffff
    return rank
  }
  /** Mostly thin cloud, some thick: alpha = 255 r². */
  const skewed = () => {
    const observed = new Uint8ClampedArray(pixels * 4)
    for (let p = 0; p < pixels; p++) observed[p * 4 + 1] = Math.floor(255 * hash(p) ** 2)
    return observed
  }
  const LONG = 30 * FORECAST_TAU_MS
  const alphas = (rgba: Uint8ClampedArray, fromRow = 0, toRow = OUT_H) => {
    const values: number[] = []
    for (let p = fromRow * OUT_W; p < toRow * OUT_W; p += 7) values.push(rgba[p * 4 + 1])
    return values
  }
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length / 255
  const quartiles = (v: number[]) => {
    const sorted = [...v].sort((a, b) => a - b)
    return [0.25, 0.5, 0.75].map((f) => sorted[Math.floor(f * sorted.length)])
  }
  const synthesise = (
    observed: Uint8ClampedArray,
    c0: Float32Array,
    ct: Float32Array,
    { rank = uniformRank(), leadMs = LONG, calibration = 1 } = {}
  ) => {
    const out = new Uint8ClampedArray(pixels * 4)
    synthesiseForecast(
      { observed, quantiles: alphaQuantiles(observed), c0, ct, rank, leadMs, calibration },
      out
    )
    return out
  }

  test('at unchanged cover, synthetic cloud has the observation\'s alpha distribution', () => {
    const observed = skewed()
    const cover = new Float32Array(GRID_POINTS).fill(0.5)
    const out = synthesise(observed, cover, cover)
    expect(Math.abs(mean(alphas(out)) - mean(alphas(observed)))).toBeLessThan(0.01)
    const [a, b] = [quartiles(alphas(out)), quartiles(alphas(observed))]
    a.forEach((q, i) => expect(Math.abs(q - b[i])).toBeLessThanOrEqual(3))
    expect([out[0], out[2], out[3]]).toEqual([0, 0, 255])
  })

  test('more forecast cover, more cloud; and the grid is north up', () => {
    const observed = skewed()
    const c0 = new Float32Array(GRID_POINTS).fill(0.3)
    const ct = Float32Array.from(c0)
    ct.fill(0.8, 0, 36)
    const out = synthesise(observed, c0, ct)
    expect(mean(alphas(out, 0, 32))).toBeGreaterThan(mean(alphas(out, OUT_H - 32)) + 0.2)
  })

  test('synthetic cloud drifts east in the westerlies and west in the trades', () => {
    const x0 = 1000
    const rank = new Uint16Array(pixels)
    for (let y = 0; y < OUT_H; y++) rank[y * OUT_W + x0] = 65535
    // 2% thick cloud, the rest clear: only the top rank is cloud.
    const observed = new Uint8ClampedArray(pixels * 4)
    for (let p = 0; p < pixels; p++) observed[p * 4 + 1] = hash(p) < 0.02 ? 255 : 0
    const cover = new Float32Array(GRID_POINTS).fill(0.3)
    const out = synthesise(observed, cover, cover, { rank, leadMs: DRIFT_MAX_MS })
    const cloudAt = (lat: number) => {
      const y = Math.round(((90 - lat) / 180) * OUT_H - 0.5)
      let best = 0
      for (let x = 1; x < OUT_W; x++) if (out[(y * OUT_W + x) * 4 + 1] > out[(y * OUT_W + best) * 4 + 1]) best = x
      return { x: best, expected: driftPx(lat, DRIFT_MAX_MS) }
    }
    const west = cloudAt(50)
    expect(west.x).toBeGreaterThan(x0)
    expect(Math.abs(west.x - x0 - west.expected)).toBeLessThan(2)
    const trades = cloudAt(-10)
    expect(trades.x).toBeLessThan(x0)
    expect(Math.abs(trades.x - x0 - trades.expected)).toBeLessThan(2)
  })

  test('the observation passes through at no lead and unchanged cover', () => {
    const observed = new Uint8ClampedArray(pixels * 4)
    for (let p = 0; p < pixels; p++) observed[p * 4 + 1] = p % 256
    const cover = new Float32Array(GRID_POINTS).fill(0.5)
    const out = synthesise(observed, cover, cover, { leadMs: 0, calibration: 0.8 })
    expect(out[1001 * 4 + 1]).toBe(1001 % 256)
  })

  test('calibration scales cover to the observed alpha, within bounds', () => {
    const observed = (a: number) => new Uint8ClampedArray(pixels * 4).fill(Math.round(a * 255))
    const cover = (c: number) => new Float32Array(GRID_POINTS).fill(c)
    expect(coverCalibration(observed(0.5), cover(0.5))).toBeCloseTo(1, 2)
    expect(coverCalibration(observed(0.45), cover(0.5))).toBeCloseTo(0.9, 2)
    expect(coverCalibration(observed(0.1), cover(0.9))).toBe(CALIBRATION_RANGE[0])
    expect(coverCalibration(observed(0.9), cover(0.4))).toBe(CALIBRATION_RANGE[1])
    expect(coverCalibration(observed(0.5), cover(0))).toBe(1)
  })

  test('a long forecast at the observed cover keeps the observed mean alpha', () => {
    const observed = skewed()
    const cover = new Float32Array(GRID_POINTS).fill(0.66)
    const calibration = coverCalibration(observed, cover)
    for (const leadMs of [24 * HOUR_MS, 5 * 24 * HOUR_MS]) {
      const out = synthesise(observed, cover, cover, { leadMs, calibration })
      expect(Math.abs(mean(alphas(out)) - mean(alphas(observed)))).toBeLessThan(0.035)
    }
  })
})

describe('createCoverGridSource', () => {
  /** Storage shared by every source (tab) made from it. */
  function storage(stored: { fetchedAt: number; body: unknown } | null = null) {
    return { stored, backoff: null as FetchBackoff | null }
  }

  function setup({
    store = storage(),
    fails = false,
    startAt = NOW,
    fetch = async (): Promise<unknown> => {
      if (fails) throw new Error('offline')
      return response()
    },
    exclusive = <T,>(fn: () => Promise<T>) => fn(),
  } = {}) {
    let now = startAt
    const fetchJson = vi.fn(fetch)
    const source = createCoverGridSource({
      fetchJson,
      readStored: async () => store.stored,
      writeStored: async (fetchedAt, body) => {
        store.stored = { fetchedAt, body }
      },
      readBackoff: async () => store.backoff,
      writeBackoff: async (backoff) => {
        store.backoff = backoff
      },
      exclusive,
      now: () => now,
    })
    const get = () => source.get(START + HOUR_MS, START + 40 * HOUR_MS)
    const peek = () => source.peek(START + HOUR_MS, START + 40 * HOUR_MS)
    return {
      source,
      store,
      fetchJson,
      get,
      peek,
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  test('one fetch for everyone waiting, stored for next time', async () => {
    const { fetchJson, store, get } = setup()
    const [a, b] = await Promise.all([get(), get()])
    expect(a).not.toBeNull()
    expect(b).toBe(a)
    expect(fetchJson).toHaveBeenCalledTimes(1)
    expect(store.stored?.fetchedAt).toBe(NOW)
  })

  test('a fresh grid is never fetched again', async () => {
    const { fetchJson, get, advance } = setup()
    await get()
    advance(FORECAST_TTL_MS - 1)
    await get()
    expect(fetchJson).toHaveBeenCalledTimes(1)
    advance(1)
    await get()
    expect(fetchJson).toHaveBeenCalledTimes(2)
  })

  test('a fresh stored grid saves the fetch; a stale one is refetched', async () => {
    const fresh = setup({ store: storage({ fetchedAt: NOW - HOUR_MS, body: response() }) })
    expect(await fresh.get()).not.toBeNull()
    expect(fresh.fetchJson).not.toHaveBeenCalled()
    const stale = setup({ store: storage({ fetchedAt: NOW - FORECAST_TTL_MS, body: response() }) })
    await stale.get()
    expect(stale.fetchJson).toHaveBeenCalledTimes(1)
  })

  test('a grid another tab stored is used instead of fetching', async () => {
    const store = storage()
    const first = setup({ store })
    await first.get()
    // A second tab whose copy has gone stale finds the first tab's newer one.
    const second = setup({ store, startAt: NOW - FORECAST_TTL_MS })
    await second.get()
    expect(second.fetchJson).toHaveBeenCalledTimes(1)
    first.advance(FORECAST_TTL_MS)
    store.stored = { fetchedAt: NOW + FORECAST_TTL_MS - 60_000, body: response() }
    await first.get()
    expect(first.fetchJson).toHaveBeenCalledTimes(1)
  })

  test('invalid or future-dated stored grids are ignored', async () => {
    const invalid = setup({ store: storage({ fetchedAt: NOW, body: { nope: 1 } }) })
    expect(await invalid.get()).not.toBeNull()
    expect(invalid.fetchJson).toHaveBeenCalledTimes(1)
    const future = setup({ store: storage({ fetchedAt: NOW + HOUR_MS, body: response() }) })
    await future.get()
    expect(future.fetchJson).toHaveBeenCalledTimes(1)
  })

  test('failures back off exponentially, a stale grid serving meanwhile', async () => {
    const { fetchJson, get, advance, store } = setup({
      store: storage({ fetchedAt: NOW - 5 * HOUR_MS, body: response() }),
      fails: true,
    })
    expect(await get()).not.toBeNull()
    expect(store.backoff).toEqual({ failures: 1, retryAt: NOW + FORECAST_RETRY_MS })
    advance(FORECAST_RETRY_MS - 1)
    await get()
    expect(fetchJson).toHaveBeenCalledTimes(1)
    advance(1)
    await get()
    expect(fetchJson).toHaveBeenCalledTimes(2)
    expect(store.backoff?.failures).toBe(2)
    advance(2 * FORECAST_RETRY_MS - 1)
    await get()
    expect(fetchJson).toHaveBeenCalledTimes(2)
    expect(retryDelayMs(20)).toBe(FORECAST_RETRY_MAX_MS)
  })

  test('the backoff survives a reload', async () => {
    const store = storage()
    store.backoff = { failures: 3, retryAt: NOW + HOUR_MS }
    const { fetchJson, get } = setup({ store })
    expect(await get()).toBeNull()
    await get()
    expect(fetchJson).not.toHaveBeenCalled()
  })

  test('a stored backoff is bounded by the longest delay', async () => {
    const store = storage()
    store.backoff = { failures: 3, retryAt: NOW + 100 * HOUR_MS }
    const { fetchJson, get, advance } = setup({ store })
    await get()
    advance(FORECAST_RETRY_MAX_MS)
    await get()
    expect(fetchJson).toHaveBeenCalledTimes(1)
  })

  test('a success clears the backoff', async () => {
    const store = storage()
    store.backoff = { failures: 3, retryAt: NOW - 1 }
    const { get } = setup({ store })
    expect(await get()).not.toBeNull()
    expect(store.backoff).toBeNull()
  })

  test('null when nothing usable covers the times', async () => {
    const offline = setup({ fails: true })
    expect(await offline.get()).toBeNull()
    const { source } = setup()
    expect(await source.get(START, START + 60 * HOUR_MS)).toBeNull()
  })

  // The cloud types' way in (tides-tvr.4.1): never waits on the network.
  describe('peek', () => {
    /** A fetch that hangs until released. */
    function hung() {
      let release: (body: unknown) => void = () => {}
      const fetch = () => new Promise<unknown>((resolve) => (release = resolve))
      return { fetch, release: (body: unknown) => release(body) }
    }

    test('with no grid anywhere: null at once, the fetch started for next time', async () => {
      const h = hung()
      const { fetchJson, peek } = setup({ fetch: h.fetch })
      expect(await peek()).toBeNull()
      // In the background, after the storage and backoff reads.
      await vi.waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1))
      h.release(response())
      await vi.waitFor(async () => expect(await peek()).not.toBeNull())
      expect(fetchJson).toHaveBeenCalledTimes(1)
    })

    test('a stale stored grid serves while its refresh hangs', async () => {
      const h = hung()
      const { fetchJson, peek } = setup({
        store: storage({ fetchedAt: NOW - FORECAST_TTL_MS - HOUR_MS, body: response() }),
        fetch: h.fetch,
      })
      const grid = await peek()
      expect(grid).not.toBeNull()
      await vi.waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(1))
      expect(await peek()).toBe(grid)
      expect(fetchJson).toHaveBeenCalledTimes(1)
    })

    test("another tab's lock held by a hung fetch doesn't hold it up", async () => {
      const { fetchJson, peek } = setup({
        store: storage({ fetchedAt: NOW - FORECAST_TTL_MS - HOUR_MS, body: response() }),
        exclusive: () => new Promise<never>(() => {}),
      })
      expect(await peek()).not.toBeNull()
      expect(fetchJson).not.toHaveBeenCalled()
    })

    test('a fresh grid in memory: no storage read, no fetch', async () => {
      const { fetchJson, get, peek, store } = setup()
      const grid = await get()
      store.stored = null
      expect(await peek()).toBe(grid)
      expect(fetchJson).toHaveBeenCalledTimes(1)
    })

    test('nothing past FORECAST_STALE_MAX_MS, nor a grid not covering the times', async () => {
      const old = setup({
        store: storage({ fetchedAt: NOW - FORECAST_STALE_MAX_MS, body: response() }),
        fails: true,
      })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(await old.peek()).toBeNull()
      const fresh = setup({ store: storage({ fetchedAt: NOW - HOUR_MS, body: response() }) })
      expect(await fresh.source.peek(START - HOUR_MS, START)).toBeNull()
      expect(await fresh.source.peek(START, START + 47 * HOUR_MS)).not.toBeNull()
      vi.restoreAllMocks()
    })
  })
})
