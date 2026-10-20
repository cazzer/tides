import { readFileSync } from 'node:fs'
import { describe, expect, test, vi } from 'vitest'
import { DEFAULT_KP, geomagneticNorthPole, ovalTable } from './aurora'
import {
  blendOvalTable,
  createOvationFeed,
  fitOvation,
  OVATION_FADE_MS,
  OVATION_MARGIN_MS,
  OVATION_REFRESH_MS,
  OVATION_RETRY_MS,
  OVATION_SETTLE_MS,
  OVATION_WANT_MS,
  ovationWeight,
  parseOvation,
  type OvationFit,
} from './aurora-ovation'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

// SWPC's ovation_aurora_latest.json of 2026-10-20 03:17Z (quiet: observed Kp
// 1.0), with the 0 % points left out.
const QUIET = JSON.parse(
  readFileSync(new URL('./__fixtures__/swpc-ovation.json', import.meta.url), 'utf8')
)

describe('parseOvation', () => {
  test('reads the times and the grid; missing points are 0', () => {
    const g = parseOvation(QUIET)
    expect(g.observedMs).toBe(Date.UTC(2026, 9, 20, 3, 17))
    expect(g.forecastMs).toBe(Date.UTC(2026, 9, 20, 4, 42))
    // [290, 60, 12] in the file; [0, 30, *] is not.
    expect(g.values[290 * 181 + 60 + 90]).toBe(12)
    expect(g.values[30 + 90]).toBe(0)
  })

  test('rejects a file without times or points', () => {
    expect(() => parseOvation(null)).toThrow()
    expect(() => parseOvation({ ...QUIET, 'Forecast Time': 'soon' })).toThrow()
    expect(() => parseOvation({ ...QUIET, coordinates: [] })).toThrow()
  })
})

/** A synthetic nowcast: a ring of `peak` % between geomagnetic latitudes
 * `from` and `to`, built around the same dipole the fit uses. */
function ring(from: number, to: number, peak: number, at: number) {
  const pole = geomagneticNorthPole(at)
  const coordinates: [number, number, number][] = []
  const toRad = Math.PI / 180
  const p = [
    Math.cos(pole.lat * toRad) * Math.cos(pole.lon * toRad),
    Math.cos(pole.lat * toRad) * Math.sin(pole.lon * toRad),
    Math.sin(pole.lat * toRad),
  ]
  for (let lon = 0; lon < 360; lon++) {
    for (let lat = -90; lat <= 90; lat++) {
      const v = [
        Math.cos(lat * toRad) * Math.cos(lon * toRad),
        Math.cos(lat * toRad) * Math.sin(lon * toRad),
        Math.sin(lat * toRad),
      ]
      const mlat = Math.abs(Math.asin(v[0] * p[0] + v[1] * p[1] + v[2] * p[2])) / toRad
      if (mlat >= from && mlat <= to) coordinates.push([lon, lat, peak])
    }
  }
  const iso = (ms: number) => new Date(ms).toISOString().replace('.000', '')
  return parseOvation({
    'Observation Time': iso(at - 90 * MINUTE),
    'Forecast Time': iso(at),
    coordinates,
  })
}

describe('fitOvation', () => {
  const at = Date.UTC(2026, 2, 20, 0)

  test('a quiet night fits a quiet Kp, brightest around midnight', () => {
    const fit = fitOvation(parseOvation(QUIET))
    expect(fit.peak).toBeGreaterThan(10)
    expect(fit.kp).toBeGreaterThan(0.5)
    expect(fit.kp).toBeLessThan(2)
    const intensity = (h: number) => fit.table[h * 4 + 3]
    expect(intensity(23)).toBeGreaterThan(intensity(11))
    for (let h = 0; h < 24; h++) {
      const [diffuse, eq, pole] = fit.table.slice(h * 4, h * 4 + 3)
      expect(diffuse).toBeLessThanOrEqual(eq)
      expect(eq).toBeLessThanOrEqual(pole - 1)
      expect(diffuse).toBeGreaterThan(55)
      expect(pole).toBeLessThan(85)
    }
  })

  test('recovers a band placed in geomagnetic coordinates', () => {
    const fit = fitOvation(ring(58, 66, 60, at))
    for (let h = 0; h < 24; h++) {
      const [diffuse, eq, pole] = fit.table.slice(h * 4, h * 4 + 3)
      expect(Math.abs(diffuse - 58)).toBeLessThan(1)
      expect(Math.abs(eq - 58)).toBeLessThan(1)
      expect(Math.abs(pole - 66)).toBeLessThan(1)
    }
    // A diffuse edge near 58° at midnight is active (Gussenhoven: Kp 4-5).
    expect(fit.kp).toBeGreaterThan(3.5)
    expect(fit.kp).toBeLessThan(5.5)
  })

  test('a lower oval fits a higher Kp', () => {
    expect(fitOvation(ring(50, 60, 90, at)).kp).toBeGreaterThan(fitOvation(ring(60, 70, 90, at)).kp)
  })

  test('an empty nowcast falls back to the Kp model at Kp 0, dimly', () => {
    const fit = fitOvation(
      parseOvation({
        'Observation Time': '2026-03-19T22:30:00Z',
        'Forecast Time': '2026-03-20T00:00:00Z',
        coordinates: [[0, 0, 1]],
      })
    )
    expect(fit.kp).toBe(0)
    expect(Array.from(fit.table.filter((_, i) => i % 4 !== 3))).toEqual(
      Array.from(ovalTable(0).filter((_, i) => i % 4 !== 3))
    )
  })
})

describe('ovationWeight and blendOvalTable', () => {
  const fit = fitOvation(parseOvation(QUIET))

  test('full across the nowcast, fading out on either side', () => {
    expect(ovationWeight(fit, fit.observedMs)).toBe(1)
    expect(ovationWeight(fit, fit.forecastMs + OVATION_MARGIN_MS)).toBe(1)
    expect(ovationWeight(fit, fit.forecastMs + OVATION_MARGIN_MS + OVATION_FADE_MS / 2)).toBeCloseTo(0.5)
    expect(ovationWeight(fit, fit.observedMs - OVATION_MARGIN_MS - OVATION_FADE_MS)).toBe(0)
    expect(ovationWeight(fit, fit.forecastMs + 10 * HOUR)).toBe(0)
  })

  test('blends the model table toward the fit', () => {
    const model = ovalTable(DEFAULT_KP)
    expect(blendOvalTable(model.slice(), fit, 0)).toEqual(model)
    expect(blendOvalTable(model.slice(), fit, 1)).toEqual(fit.table)
    const half = blendOvalTable(model.slice(), fit, 0.5)
    expect(half[0]).toBeCloseTo((model[0] + fit.table[0]) / 2, 4)
  })
})

describe('createOvationFeed', () => {
  const now = Date.UTC(2026, 9, 20, 4)
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const fit = { observedMs: now, forecastMs: now, kp: 1, peak: 10, table: new Float32Array(96) } as OvationFit

  function setup(impl?: () => Promise<OvationFit>) {
    const load = vi.fn(impl ?? (async () => fit))
    return { load, feed: createOvationFeed({ load }) }
  }

  test('loads at once near now, then refreshes while in use', async () => {
    const { load, feed } = setup()
    expect(feed.tick(now, null, 0, now)).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
    await flush()
    expect(feed.tick(now, null, 10, now)).toBe(fit)
    feed.tick(now, null, OVATION_REFRESH_MS + 10, now)
    expect(load).toHaveBeenCalledTimes(1)
    feed.tick(now, null, OVATION_REFRESH_MS + OVATION_SETTLE_MS + 10, now)
    expect(load).toHaveBeenCalledTimes(2)
  })

  test('far from now it neither loads nor drops the last fit', async () => {
    const { load, feed } = setup()
    expect(feed.tick(now - OVATION_WANT_MS - 1, null, 0, now)).toBeNull()
    expect(feed.tick(now + 2 * OVATION_WANT_MS, null, 0, now)).toBeNull()
    expect(load).not.toHaveBeenCalled()
    // A jump back to now loads for its target.
    feed.tick(now - 30 * 24 * HOUR, now, 10, now)
    await flush()
    expect(feed.tick(now - 30 * 24 * HOUR, null, 20, now)).toBe(fit)
  })

  test('failures retry after a delay; deactivate drops in-flight results', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { load, feed } = setup(async () => {
      throw new Error('offline')
    })
    feed.tick(now, null, 0, now)
    await flush()
    feed.tick(now, null, OVATION_SETTLE_MS * 2, now)
    expect(load).toHaveBeenCalledTimes(1)
    feed.tick(now, null, OVATION_RETRY_MS + 1, now)
    feed.tick(now, null, OVATION_RETRY_MS + OVATION_SETTLE_MS + 2, now)
    expect(load).toHaveBeenCalledTimes(2)
    warn.mockRestore()

    const second = setup()
    second.feed.tick(now, null, 0, now)
    second.feed.deactivate()
    await flush()
    expect(second.feed.tick(now, null, 10, now)).toBeNull()
  })
})
