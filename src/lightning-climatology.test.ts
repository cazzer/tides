import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  CLIM_CELLS,
  CLIM_H,
  CLIM_W,
  COVER_H,
  COVER_W,
  DENSITY_F0,
  cellAreaKm2,
  cellCentre,
  cellOf,
  decodeFlashDensity,
  decodeLightningClimatology,
  densityOf,
  encodeFlashDensity,
  flashDensityAt,
  globalFlashRate,
  guessedDensity,
  landAt,
  LIGHTNING_BYTES,
  monthBlend,
  seasonFactor,
  staticCover,
  syntheticClimatology,
  syntheticClimatologyBytes,
} from './lightning-climatology'

const EARTH_AREA_KM2 = 4 * Math.PI * 6371.0088 ** 2

describe('the lightning climatology asset', () => {
  test('is 12 months, land and coverage at 2.5°, and the static cover at 1°, no header', () => {
    expect(LIGHTNING_BYTES).toBe(14 * 144 * 72 + 360 * 180)
    expect(LIGHTNING_BYTES).toBe(209_952)
    expect(() => decodeLightningClimatology(new Uint8Array(LIGHTNING_BYTES - 1))).toThrow(/209952/)
    expect(() => decodeLightningClimatology(new Uint8Array(199_584))).toThrow()
    expect(() => decodeLightningClimatology(new Uint8Array(LIGHTNING_BYTES))).not.toThrow()
  })

  test('the density encoding round-trips to within a byte step', () => {
    expect(encodeFlashDensity(0)).toBe(0)
    expect(encodeFlashDensity(2)).toBe(255)
    expect(encodeFlashDensity(50)).toBe(255)
    // A step is ln(1 + FMAX / F0) / 255 ≈ 3% of F + F0.
    for (const f of [0.0005, 0.001, 0.01, 0.05, 0.3, 1, 2]) {
      const back = decodeFlashDensity(encodeFlashDensity(f))
      expect(Math.abs(back - f)).toBeLessThanOrEqual(0.016 * (f + DENSITY_F0))
    }
    for (let b = 1; b < 256; b++) expect(decodeFlashDensity(b)).toBeGreaterThan(decodeFlashDensity(b - 1))
  })

  test('every plane decodes from where the layout puts it, bottom row first, columns from 180° W', () => {
    const bytes = syntheticClimatologyBytes({
      density: (lat, lon, m) => (lat > 0 && lon < 0 ? 0.1 * (m + 1) : 0),
      land: (lat) => (lat > 0 ? 1 : 0),
      coverage: (_lat, lon) => (lon > 0 ? 1 : 0),
      cover: (lat, lon) => (lat < 0 && lon > 90 ? 0.6 : 0.2),
    })
    const clim = decodeLightningClimatology(bytes)
    expect(clim.monthly).toHaveLength(12)
    expect(clim.monthly[3][cellOf(45, -100)]).toBeCloseTo(0.4, 1)
    expect(clim.monthly[3][cellOf(-45, -100)]).toBe(0)
    expect(clim.monthly[3][cellOf(45, 100)]).toBe(0)
    // Row 0 is the south, column 0 starts at 180° W.
    expect(cellOf(-89, -179)).toBe(0)
    expect(cellOf(89, 179)).toBe(CLIM_CELLS - 1)
    expect(cellOf(0, 180)).toBe(cellOf(0, -180))
    expect(landAt(clim, 30, 10)).toBe(1)
    expect(landAt(clim, -30, 10)).toBe(0)
    expect(clim.coverage[cellOf(10, 50)]).toBe(1)
    expect(clim.coverage[cellOf(10, -50)]).toBe(0)
    expect(staticCover(clim, -20, 120)).toBeCloseTo(0.6, 2)
    expect(staticCover(clim, 20, 120)).toBeCloseTo(0.2, 2)
    expect(clim.cover.length).toBe(COVER_W * COVER_H)
    expect(clim.cover[0]).toBe(Math.round(0.2 * 255))
  })

  test('cells cover the sphere', () => {
    let area = 0
    for (let y = 0; y < CLIM_H; y++) area += cellAreaKm2(y) * CLIM_W
    expect(area / EARTH_AREA_KM2).toBeCloseTo(1, 9)
  })

  test("months mix linearly between their middles: a month's middle is its own, and there's no step at its end", () => {
    const clim = syntheticClimatology({ density: (_lat, _lon, m) => 0.01 * (m + 1) })
    const at = (ms: number) => flashDensityAt(clim, 0, 0, ms)
    const plane = (m: number) => clim.monthly[m][cellOf(0, 0)]
    // Mid-March, from the 1st's midnight: 15.5 of 31 days.
    expect(at(Date.UTC(2031, 2, 16, 12))).toBeCloseTo(plane(2), 6)
    for (let m = 0; m < 12; m++) {
      const edge = Date.UTC(2031, m + 1, 1)
      expect(Math.abs(at(edge - 1) - at(edge))).toBeLessThan(1e-6)
      // Half way between the months at the boundary.
      expect(at(edge)).toBeCloseTo((plane(m) + plane((m + 1) % 12)) / 2, 6)
    }
    // A year's end wraps December to January.
    const b = monthBlend(Date.UTC(2031, 11, 31, 23))
    expect([b.m0, b.m1]).toEqual([11, 0])
  })

  test('the global flash rate of a flat climatology is its density over the sphere', () => {
    const clim = syntheticClimatology({ density: 0.01 })
    const f = clim.monthly[0][0]
    expect(globalFlashRate(clim)).toBeCloseTo((f * EARTH_AREA_KM2) / 86_400, 6)
    expect(globalFlashRate(clim, 6)).toBeCloseTo(globalFlashRate(clim), 6)
  })
})

describe('the guess where LIS has no data', () => {
  const january = monthBlend(Date.UTC(2031, 0, 16, 12))
  const july = monthBlend(Date.UTC(2031, 6, 16, 12))

  test('flashes over land in summer, less in winter, and the seasons are opposite across the equator', () => {
    for (const lat of [45, 60, -45, -60]) {
      const summer = lat > 0 ? july : january
      const winter = lat > 0 ? january : july
      expect(guessedDensity(lat, 1, summer)).toBeGreaterThan(0.02)
      expect(guessedDensity(lat, 1, winter)).toBeGreaterThan(0)
      expect(guessedDensity(lat, 1, winter)).toBeLessThan(guessedDensity(lat, 1, summer) / 4)
    }
    expect(seasonFactor(0, january)).toBeCloseTo(seasonFactor(0, july), 9)
    expect(guessedDensity(50, 1, july) / guessedDensity(50, 0, july)).toBeCloseTo(3, 9)
  })

  test('changes smoothly through the year', () => {
    let last = guessedDensity(50, 1, monthBlend(Date.UTC(2031, 0, 1)))
    for (let h = 6; h <= 366 * 24; h += 6) {
      const g = guessedDensity(50, 1, monthBlend(Date.UTC(2031, 0, 1) + h * 3_600_000))
      expect(Math.abs(g - last)).toBeLessThan(0.0002)
      last = g
    }
  })

  test("blends from LIS's to the guess across its coverage's edge, without a step", () => {
    // LIS's density near its edge, as the guess would have it there (calibrated),
    // and a coverage ramp over 35-42.5° N (LIS has data wherever it has any coverage).
    const blend = july
    const clim = syntheticClimatology({
      density: (lat) => (lat < 42.5 ? guessedDensity(lat, 1, blend) * 1.1 : 0),
      land: 1,
      coverage: (lat) => Math.min(1, Math.max(0, (42.5 - lat) / 7.5)),
    })
    const rows: number[] = []
    for (let lat = 21.25; lat < 60; lat += 2.5) rows.push(densityOf(clim, cellOf(lat, 10), blend))
    for (let i = 1; i < rows.length; i++) {
      expect(Math.abs(rows[i] - rows[i - 1])).toBeLessThan(0.05 * Math.max(rows[i], rows[i - 1]))
    }
    // Covered: LIS's alone; beyond the ramp: the guess alone.
    const cell = cellOf(30, 10)
    expect(densityOf(clim, cell, blend)).toBeCloseTo((1 - blend.f) * clim.monthly[blend.m0][cell] + blend.f * clim.monthly[blend.m1][cell], 9)
    expect(densityOf(clim, cellOf(55, 10), blend)).toBeCloseTo(guessedDensity(56.25, 1, blend), 9)
  })
})

// The shipped asset (tides-ufyr.14.1, scripts/build-lightning-climatology.py).
describe('the shipped climatology (tides-ufyr.14.1)', () => {
  const bytes = new Uint8Array(readFileSync('src/assets/earth-lightning.bin'))
  const clim = decodeLightningClimatology(bytes)
  const yearly = (cell: number) => clim.monthly.reduce((sum, plane) => sum + plane[cell], 0) / 12
  const midMonth = (m: number) => monthBlend(Date.UTC(2031, m, 15, 12))

  test('is the layout, exactly', () => {
    expect(bytes.length).toBe(LIGHTNING_BYTES)
  })

  test("LIS's band flashes about 41 times a second, below the whole Earth's 46 (LIS/OTD)", () => {
    // Σ density x coverage x area over the band, the 12 months' mean. The
    // build reads 40.96 before the bytes and 40.99 after; a byte is a 1.5%
    // half step, so 2 fl/s is room for a rebuild, not for a class misread
    // (0.01 fl/km²/day over the band is ~30 fl/s).
    let sum = 0
    for (const plane of clim.monthly) {
      for (let y = 0; y < CLIM_H; y++) {
        const area = cellAreaKm2(y)
        for (let x = 0; x < CLIM_W; x++) sum += plane[y * CLIM_W + x] * clim.coverage[y * CLIM_W + x] * area
      }
    }
    const rate = sum / 12 / 86_400
    expect(rate).toBeGreaterThan(39)
    expect(rate).toBeLessThan(43)
  })

  test('Lake Maracaibo and the eastern Congo are in the top 1% of covered cells', () => {
    const covered: number[] = []
    for (let i = 0; i < CLIM_CELLS; i++) if (clim.coverage[i] === 1) covered.push(yearly(i))
    covered.sort((a, b) => a - b)
    const top1 = covered[Math.floor(0.99 * covered.length)]
    expect(yearly(cellOf(9.75, -71.5))).toBeGreaterThanOrEqual(top1)
    expect(yearly(cellOf(-1.25, 28.75))).toBeGreaterThanOrEqual(top1)
  })

  test('the Sahara in January, the mid-South-Pacific and Antarctica (beyond LIS) are about 0', () => {
    expect(clim.monthly[0][cellOf(25, 10)]).toBeLessThan(0.002)
    expect(yearly(cellOf(-20, -130))).toBeLessThan(0.005)
    for (let m = 0; m < 12; m++) expect(clim.monthly[m][cellOf(-80, 0)]).toBe(0)
  })

  test('land is the Sahara, not the mid-Pacific', () => {
    expect(landAt(clim, 25, 10)).toBeGreaterThan(0.95)
    expect(landAt(clim, 0, -150)).toBeLessThan(0.05)
  })

  test("LIS's coverage is the band: full at the equator, none at 70° N", () => {
    for (let lon = -178.75; lon < 180; lon += 2.5) {
      expect(clim.coverage[cellOf(0, lon)]).toBe(1)
      expect(clim.coverage[cellOf(70, lon)]).toBe(0)
      expect(clim.coverage[cellOf(-70, lon)]).toBe(0)
    }
    // LIS has density wherever it has any coverage.
    for (let i = 0; i < CLIM_CELLS; i++) if (clim.coverage[i] > 0) expect(clim.monthly[6][i] + clim.monthly[0][i]).toBeGreaterThan(0)
  })

  test("the guess is within a factor of 2 of LIS's over land at 30-37.5°, in its summer and over the year", () => {
    const compare = (inRow: (lat: number) => boolean, months: number[]) => {
      let lis = 0
      let guess = 0
      let n = 0
      for (let i = 0; i < CLIM_CELLS; i++) {
        const [lat] = cellCentre(i)
        if (!inRow(lat) || clim.coverage[i] < 1 || clim.land[i] < 0.5) continue
        for (const m of months) {
          lis += clim.monthly[m][i]
          guess += guessedDensity(lat, clim.land[i], midMonth(m))
          n++
        }
      }
      expect(n).toBeGreaterThan(100)
      return guess / lis
    }
    const north = (lat: number) => lat > 30 && lat < 37.5
    const south = (lat: number) => lat < -30 && lat > -37.5
    for (const ratio of [
      compare(north, [5, 6, 7]),
      compare(south, [11, 0, 1]),
      compare(north, [...Array(12).keys()]),
      compare(south, [...Array(12).keys()]),
    ]) {
      expect(ratio).toBeGreaterThan(0.5)
      expect(ratio).toBeLessThan(2)
    }
  })

  test('the static cover is the static clouds', () => {
    expect(clim.cover.length).toBe(COVER_W * COVER_H)
    const mean = clim.cover.reduce((a, b) => a + b, 0) / clim.cover.length / 255
    expect(mean).toBeGreaterThan(0.1)
    expect(mean).toBeLessThan(0.6)
    expect(staticCover(clim, 25, 10)).toBeLessThan(0.1)
  })
})
