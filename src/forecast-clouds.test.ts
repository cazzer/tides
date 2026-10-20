import { describe, expect, test, vi } from 'vitest'
import {
  CALIBRATION_RANGE,
  coverAt,
  coverCalibration,
  coverRequestBody,
  createCoverGridSource,
  FORECAST_RETRY_MS,
  FORECAST_TAU_MS,
  forecastAlpha,
  GRID_LATS,
  GRID_LONS,
  GRID_POINTS,
  leadWeight,
  parseCoverGrid,
  sampleCover,
  structureRank,
  synthesiseForecast,
  zonalDriftDegPerHour,
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

describe('coverRequestBody', () => {
  test('every grid point, hourly cover from yesterday for a week, in unix time', () => {
    const body = coverRequestBody()
    const lats = body.get('latitude')!.split(',').map(Number)
    const lons = body.get('longitude')!.split(',').map(Number)
    expect(lats).toHaveLength(GRID_POINTS)
    expect(lons).toHaveLength(GRID_POINTS)
    expect([lats[0], lons[0], lats[1], lons[1], lats[36]]).toEqual([85, -180, 85, -170, 75])
    expect(lats[GRID_POINTS - 1]).toBe(-85)
    expect(lons[GRID_POINTS - 1]).toBe(170)
    expect(body.get('hourly')).toBe('cloud_cover')
    expect(body.get('forecast_days')).toBe('7')
    expect(body.get('past_days')).toBe('1')
    expect(body.get('timeformat')).toBe('unixtime')
  })
})

describe('parseCoverGrid', () => {
  test('a valid response', () => {
    const grid = parseCoverGrid(response())
    expect(grid.startMs).toBe(START)
    expect(grid.hours).toBe(48)
    expect(grid.cover[3 * GRID_POINTS + 10]).toBeCloseTo(0.13)
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
  // 10 m/s at 60° is about 0.65°/h.
  expect(zonalDriftDegPerHour(60)).toBeCloseTo(0.647, 2)
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

describe('synthesis', () => {
  const pixels = OUT_W * OUT_H
  const uniformRank = () => {
    const rank = new Uint16Array(pixels)
    for (let p = 0; p < pixels; p++) rank[p] = (p * 40503) & 0xffff
    return rank
  }

  test('synthetic cloud covers the forecast fraction', () => {
    const out = new Uint8ClampedArray(pixels * 4)
    synthesiseForecast(
      {
        observed: new Uint8ClampedArray(pixels * 4),
        c0: new Float32Array(GRID_POINTS),
        ct: new Float32Array(GRID_POINTS).fill(0.3),
        rank: uniformRank(),
        leadMs: 30 * FORECAST_TAU_MS,
      },
      out
    )
    let sum = 0
    for (let p = 0; p < pixels; p++) sum += out[p * 4 + 1]
    expect(sum / pixels / 255).toBeGreaterThan(0.28)
    expect(sum / pixels / 255).toBeLessThan(0.32)
    expect([out[0], out[2], out[3]]).toEqual([0, 0, 255])
  })

  test('the observation passes through at no lead and unchanged cover', () => {
    const observed = new Uint8ClampedArray(pixels * 4)
    for (let p = 0; p < pixels; p++) observed[p * 4 + 1] = p % 256
    const cover = new Float32Array(GRID_POINTS).fill(0.5)
    const out = new Uint8ClampedArray(pixels * 4)
    synthesiseForecast({ observed, c0: cover, ct: cover, rank: uniformRank(), leadMs: 0 }, out)
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
})

describe('createCoverGridSource', () => {
  function setup({ stored = null as { fetchedAt: number; body: unknown } | null, fails = false } = {}) {
    let now = NOW
    const fetchJson = vi.fn(async () => {
      if (fails) throw new Error('offline')
      return response()
    })
    const writeStored = vi.fn<(fetchedAt: number, body: unknown) => Promise<void>>(async () => {})
    const source = createCoverGridSource({
      fetchJson,
      readStored: async () => stored,
      writeStored,
      now: () => now,
    })
    const get = () => source.get(START + HOUR_MS, START + 40 * HOUR_MS)
    return {
      source,
      fetchJson,
      writeStored,
      get,
      advance: (ms: number) => {
        now += ms
      },
    }
  }

  test('one fetch for everyone waiting, stored for next time', async () => {
    const { fetchJson, writeStored, get } = setup()
    const [a, b] = await Promise.all([get(), get()])
    expect(a).not.toBeNull()
    expect(b).toBe(a)
    expect(fetchJson).toHaveBeenCalledTimes(1)
    expect(writeStored).toHaveBeenCalledWith(NOW, expect.any(Array))
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
    const fresh = setup({ stored: { fetchedAt: NOW - HOUR_MS, body: response() } })
    expect(await fresh.get()).not.toBeNull()
    expect(fresh.fetchJson).not.toHaveBeenCalled()
    const stale = setup({ stored: { fetchedAt: NOW - FORECAST_TTL_MS, body: response() } })
    await stale.get()
    expect(stale.fetchJson).toHaveBeenCalledTimes(1)
  })

  test('an invalid stored body is ignored', async () => {
    const { fetchJson, get } = setup({ stored: { fetchedAt: NOW, body: { nope: 1 } } })
    expect(await get()).not.toBeNull()
    expect(fetchJson).toHaveBeenCalledTimes(1)
  })

  test('a failed fetch backs off, and a stale grid serves meanwhile', async () => {
    const { fetchJson, get, advance } = setup({
      stored: { fetchedAt: NOW - 5 * HOUR_MS, body: response() },
      fails: true,
    })
    expect(await get()).not.toBeNull()
    advance(FORECAST_RETRY_MS - 1)
    await get()
    expect(fetchJson).toHaveBeenCalledTimes(1)
    advance(1)
    await get()
    expect(fetchJson).toHaveBeenCalledTimes(2)
  })

  test('null when nothing usable covers the times', async () => {
    const offline = setup({ fails: true })
    expect(await offline.get()).toBeNull()
    const { source } = setup()
    expect(await source.get(START, START + 60 * HOUR_MS)).toBeNull()
  })
})
