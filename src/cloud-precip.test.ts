import { describe, expect, test } from 'vitest'
import {
  decodePrecip,
  encodePrecip,
  PRECIP_DARK_BASE,
  PRECIP_DARK_FULL_MM_H,
  PRECIP_DARK_TOP,
  PRECIP_MAX_MM_H,
  precipDarkening,
  precipFromFrames,
  precipGridImage,
  precipWetness,
} from './cloud-precip'
import { TYPE_H, TYPE_W } from './cloud-types'
import { GRID_LATS, GRID_POINTS, type CoverGrid } from './forecast-clouds'
import { HOUR_MS } from './real-clouds'

const START = Date.UTC(2026, 9, 24)

/** Rain north of the equator, showers everywhere, snow south of it (mm/h),
 * from START for a day. */
function grid(): CoverGrid {
  const hours = 24
  const field = (value: (lat: number) => number) =>
    Float32Array.from({ length: hours * GRID_POINTS }, (_, k) => value(GRID_LATS[Math.floor((k % GRID_POINTS) / 36)]))
  return {
    startMs: START,
    hours,
    cover: new Float32Array(hours * GRID_POINTS),
    layers: null,
    precip: {
      rain: field((lat) => (lat > 0 ? 4 : 0)),
      showers: field(() => 1),
      snow: field((lat) => (lat < 0 ? 9 : 0)),
    },
  }
}

const texel = (image: Uint8Array, x: number, y: number) => [...image.subarray((y * TYPE_W + x) * 4, (y * TYPE_W + x) * 4 + 4)]

/** A frame's precipitation grid the same everywhere: RGBA bytes. */
const uniform = (rgba: number[]) => Uint8Array.from({ length: TYPE_W * TYPE_H * 4 }, (_, i) => rgba[i % 4])

describe('encodePrecip / decodePrecip', () => {
  test('round trip within a byte step', () => {
    for (const mmH of [0.01, 0.1, 0.3, 1, 2.5, 7, 13, 19.9]) {
      const e = encodePrecip(mmH)
      expect(mmH).toBeGreaterThanOrEqual(decodePrecip(Math.max(0, e - 0.5) / 255))
      expect(mmH).toBeLessThanOrEqual(decodePrecip((e + 0.5) / 255))
    }
    for (let e = 0; e < 256; e++) expect(encodePrecip(decodePrecip(e / 255))).toBe(e)
  })

  test('dry is 0, heavier than PRECIP_MAX_MM_H clamps, and it never runs backwards', () => {
    expect(encodePrecip(0)).toBe(0)
    expect(decodePrecip(0)).toBe(0)
    expect(encodePrecip(-1)).toBe(0)
    expect(encodePrecip(PRECIP_MAX_MM_H)).toBe(255)
    expect(encodePrecip(80)).toBe(255)
    expect(decodePrecip(1)).toBe(PRECIP_MAX_MM_H)
    let last = -1
    for (let mmH = 0; mmH <= 25; mmH += 0.05) {
      const e = encodePrecip(mmH)
      expect(e).toBeGreaterThanOrEqual(last)
      last = e
    }
  })

  test('drizzle keeps its steps: a tenth of a mm/h is not dry', () => {
    expect(encodePrecip(0.1)).toBeGreaterThan(10)
  })
})

describe('precipGridImage', () => {
  test('null without precipitation', () => {
    expect(precipGridImage({ ...grid(), precip: null }, () => START)).toBeNull()
  })

  test('rain, showers and snow in R, G and B, bottom row first, A 255 where covered', () => {
    const image = precipGridImage(grid(), () => START + HOUR_MS)!
    expect(image).toHaveLength(TYPE_W * TYPE_H * 4)
    // The top rows are the north: rain, no snow.
    expect(texel(image, 10, TYPE_H - 1)).toEqual([encodePrecip(4), encodePrecip(1), 0, 255])
    // The bottom rows the south: snow, no rain.
    expect(texel(image, 10, 0)).toEqual([0, encodePrecip(1), encodePrecip(9), 255])
  })

  test("columns whose time the grid doesn't cover are all 0", () => {
    const image = precipGridImage(grid(), (lon) => (lon < 0 ? START : START - HOUR_MS))!
    expect(texel(image, 0, TYPE_H - 1)[3]).toBe(255)
    expect(texel(image, TYPE_W - 1, TYPE_H - 1)).toEqual([0, 0, 0, 0])
    expect(texel(image, TYPE_W - 1, 0)).toEqual([0, 0, 0, 0])
  })
})

describe('precipFromFrames', () => {
  test('no grid either side: null', () => {
    expect(precipFromFrames(null, null, 0.5, 10, 20)).toBeNull()
    expect(precipFromFrames(uniform([0, 0, 0, 0]), null, 0.5, 10, 20)).toBeNull()
  })

  test("one frame without a grid doesn't thin the other's rates, at any mix", () => {
    const wet = uniform([encodePrecip(4), encodePrecip(1), encodePrecip(0.5), 255])
    for (const mix of [0.01, 0.3, 0.7, 1]) {
      const p = precipFromFrames(null, wet, mix, 40, -70)!
      expect(p.rain).toBeCloseTo(decodePrecip(encodePrecip(4) / 255), 5)
      expect(p.showers).toBeCloseTo(decodePrecip(encodePrecip(1) / 255), 5)
      expect(p.snow).toBeCloseTo(decodePrecip(encodePrecip(0.5) / 255), 5)
    }
    expect(precipFromFrames(null, wet, 0, 40, -70)).toBeNull()
    const p = precipFromFrames(wet, null, 0.4, 40, -70)!
    expect(p.rain).toBeCloseTo(decodePrecip(encodePrecip(4) / 255), 5)
  })

  test('two frames mix in their encoded bytes, as the GPU does', () => {
    const a = uniform([100, 0, 0, 255])
    const b = uniform([200, 0, 0, 255])
    expect(precipFromFrames(a, b, 0.5, -20, 100)!.rain).toBeCloseTo(decodePrecip(150 / 255), 5)
    expect(precipFromFrames(a, b, 0, -20, 100)!.rain).toBeCloseTo(decodePrecip(100 / 255), 5)
    // A covered dry frame does pull towards dry.
    const dry = uniform([0, 0, 0, 255])
    expect(precipFromFrames(a, dry, 0.5, -20, 100)!.rain).toBeCloseTo(decodePrecip(50 / 255), 5)
  })

  test('bilinear between texel centres, wrapping across 180° and clamped at the poles', () => {
    const image = new Uint8Array(TYPE_W * TYPE_H * 4)
    for (let y = 0; y < TYPE_H; y++) {
      image[(y * TYPE_W) * 4] = 200
      image[(y * TYPE_W + TYPE_W - 1) * 4] = 100
      for (let x = 0; x < TYPE_W; x++) image[(y * TYPE_W + x) * 4 + 3] = 255
    }
    // 180° is half way between the last column's centre and the first's.
    expect(precipFromFrames(image, null, 0, 0, 180)!.rain).toBeCloseTo(decodePrecip(150 / 255), 5)
    expect(precipFromFrames(image, null, 0, 0, -180)!.rain).toBeCloseTo(decodePrecip(150 / 255), 5)
    const west = precipFromFrames(image, null, 0, 0, 179.999)!.rain
    const east = precipFromFrames(image, null, 0, 0, -179.999)!.rain
    expect(Math.abs(west - east)).toBeLessThan(0.01)
    // On the first column's centre.
    expect(precipFromFrames(image, null, 0, 0, -180 + 1.25)!.rain).toBeCloseTo(decodePrecip(200 / 255), 5)
    expect(precipFromFrames(image, null, 0, 89.9, -180 + 1.25)!.rain).toBeCloseTo(decodePrecip(200 / 255), 5)
    expect(precipFromFrames(image, null, 0, -90, -180 + 1.25)!.rain).toBeCloseTo(decodePrecip(200 / 255), 5)
  })
})

describe('the darkening of wet cloud (tides-bl3.2)', () => {
  type Texel = [number, number, number, number]
  type Shares = [number, number, number, number]
  // A covered texel (A 1) of rain, showers and snow in mm/h, as sampled.
  const texel = (rain: number, showers: number, snow: number, a = 1): Texel => [
    (a * encodePrecip(rain)) / 255,
    (a * encodePrecip(showers)) / 255,
    (a * encodePrecip(snow)) / 255,
    a,
  ]
  const CIRRUS: Shares = [1, 0, 0, 0]
  const CUMULUS: Shares = [0, 1, 0, 0]
  const ALTO: Shares = [0, 0, 1, 0]
  const STRATUS: Shares = [0, 0, 0, 1]

  test('is dry where there is no data, no rate, or only cirrus', () => {
    expect(precipWetness([0, 0, 0, 0], STRATUS, 1)).toBe(0)
    expect(precipWetness([0.5, 0.5, 0.5, 0], STRATUS, 1)).toBe(0)
    expect(precipWetness(texel(0, 0, 0), STRATUS, 1)).toBe(0)
    expect(precipWetness(texel(20, 20, 20), CIRRUS, 1)).toBe(0)
  })

  test('rain wets the low and mid cloud, showers the cumulus, snow all but cirrus', () => {
    expect(precipWetness(texel(8, 0, 0), STRATUS, 1)).toBeGreaterThan(0)
    expect(precipWetness(texel(8, 0, 0), ALTO, 1)).toBeGreaterThan(0)
    expect(precipWetness(texel(8, 0, 0), CUMULUS, 1)).toBe(0)
    expect(precipWetness(texel(0, 8, 0), CUMULUS, 1)).toBeGreaterThan(0)
    expect(precipWetness(texel(0, 8, 0), STRATUS, 1)).toBe(0)
    for (const shares of [CUMULUS, ALTO, STRATUS]) {
      expect(precipWetness(texel(0, 0, 8), shares, 1)).toBeGreaterThan(0)
    }
    // Mixed kinds: the wettest reading wins.
    expect(precipWetness(texel(8, 0, 0), [0, 0.5, 0, 0.5], 1)).toBeCloseTo(0.5, 2)
  })

  test('grows with the rate, full from PRECIP_DARK_FULL_MM_H', () => {
    let last = 0
    for (const rate of [0.05, 0.1, 0.2, 0.4, 0.7]) {
      const wet = precipWetness(texel(rate, 0, 0), STRATUS, 1)
      expect(wet).toBeGreaterThan(last)
      last = wet
    }
    expect(last).toBeLessThan(1)
    expect(precipWetness(texel(PRECIP_DARK_FULL_MM_H, 0, 0), STRATUS, 1)).toBeCloseTo(1, 2)
    expect(precipWetness(texel(PRECIP_MAX_MM_H, 0, 0), STRATUS, 1)).toBe(1)
  })

  test('scales with the data\'s coverage and the type\'s confidence', () => {
    const full = precipWetness(texel(PRECIP_MAX_MM_H, 0, 0), STRATUS, 1)
    // Premultiplied: half covered, the same rate, half as wet.
    expect(precipWetness(texel(PRECIP_MAX_MM_H, 0, 0, 0.5), STRATUS, 1)).toBeCloseTo(full / 2, 6)
    expect(precipWetness(texel(PRECIP_MAX_MM_H, 0, 0), STRATUS, 0.25)).toBeCloseTo(full / 4, 6)
    expect(precipWetness(texel(PRECIP_MAX_MM_H, 0, 0), STRATUS, 0)).toBe(0)
  })

  test('darkens slightly, a base more than a top, and dry not at all', () => {
    for (const depth of [0, 0.3, 1]) expect(precipDarkening(0, depth)).toBe(1)
    expect(precipDarkening(1, 0)).toBeCloseTo(1 - PRECIP_DARK_TOP, 9)
    expect(precipDarkening(1, 1)).toBeCloseTo(1 - PRECIP_DARK_BASE, 9)
    for (const wet of [0, 0.5, 1]) {
      for (const depth of [0, 0.5, 1]) expect(precipDarkening(wet, depth)).toBeGreaterThanOrEqual(1 - PRECIP_DARK_BASE - 1e-12)
    }
    expect(PRECIP_DARK_TOP).toBeLessThan(PRECIP_DARK_BASE)
    expect(PRECIP_DARK_TOP).toBeLessThanOrEqual(0.15)
    expect(PRECIP_DARK_BASE).toBeLessThanOrEqual(0.35)
  })
})
