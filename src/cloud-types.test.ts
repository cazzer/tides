import { describe, expect, test } from 'vitest'
import {
  type CloudLook,
  dailyTimeOfLon,
  IR_WEIGHT,
  lookOf,
  NEUTRAL_LOOK,
  refineWithIr,
  TYPE_H,
  TYPE_LOOKS,
  TYPE_W,
  type TypeShares,
  typeGridImage,
  typeTexelLat,
  typeTexelLon,
  visibleShares,
} from './cloud-types'
import { DETAIL_INTERIOR } from './renderers/cloudShaders'
import { GRID_LATS, GRID_LONS, GRID_POINTS, type CoverGrid } from './forecast-clouds'
import { DAY_MS, HOUR_MS, smoothstep } from './real-clouds'

const START = Date.UTC(2026, 9, 24)

/** A grid with layers from `layer(key, lat, lon, hour)` (0..1). */
function grid(
  layer: (key: 'low' | 'mid' | 'high', lat: number, lon: number, h: number) => number,
  hours = 24
): CoverGrid {
  const make = (key: 'low' | 'mid' | 'high') =>
    Float32Array.from({ length: hours * GRID_POINTS }, (_, k) => {
      const h = Math.floor(k / GRID_POINTS)
      const i = k % GRID_POINTS
      return layer(key, GRID_LATS[Math.floor(i / 36)], GRID_LONS[i % 36], h)
    })
  return {
    startMs: START,
    hours,
    cover: new Float32Array(hours * GRID_POINTS),
    layers: { low: make('low'), mid: make('mid'), high: make('high') },
  }
}

/** Layers the same everywhere and always. */
const uniform = (low: number, mid: number, high: number) =>
  grid((key) => (key === 'low' ? low : key === 'mid' ? mid : high))

/** RGBA of texel (x, y), y from the bottom. */
const texel = (image: Uint8Array, x: number, y: number) => [...image.subarray((y * TYPE_W + x) * 4, (y * TYPE_W + x) * 4 + 4)]

describe('visibleShares', () => {
  test('a high overcast is all cirrus, seen with full confidence', () => {
    expect(visibleShares(0.8, 0.6, 1)).toEqual({ cirrus: 1, cumulus: 0, alto: 0, stratus: 0, confidence: 1 })
  })

  test('broken low cloud on its own is cumulus', () => {
    const s = visibleShares(0.3, 0, 0)
    expect(s.cumulus).toBeCloseTo(1)
    expect(s.stratus).toBeCloseTo(0)
    expect(s.confidence).toBe(1)
  })

  test('a low deck is stratus', () => {
    const s = visibleShares(0.95, 0, 0)
    expect(s.stratus).toBeCloseTo(1)
    expect(s.cumulus).toBeCloseTo(0)
  })

  test('a clear sky has no confidence', () => {
    expect(visibleShares(0, 0, 0)).toEqual({ cirrus: 0, cumulus: 0, alto: 0, stratus: 0, confidence: 0 })
    expect(visibleShares(0.01, 0, 0.005).confidence).toBe(0)
  })

  test('layers hide what is under them, and the shares sum to 1', () => {
    // Mid shows through the half the high leaves, an overcast low through
    // the quarter both leave.
    const s = visibleShares(1, 0.5, 0.5)
    expect(s.cirrus).toBeCloseTo(0.5)
    expect(s.alto).toBeCloseTo(0.25)
    expect(s.stratus).toBeCloseTo(0.25)
    expect(s.cumulus).toBeCloseTo(0)
    const t = visibleShares(0.6, 0.3, 0.2)
    expect(t.cirrus + t.alto + t.cumulus + t.stratus).toBeCloseTo(1)
  })
})

describe('typeGridImage', () => {
  test('null without layers', () => {
    expect(typeGridImage({ ...uniform(0, 0, 0), layers: null }, () => START)).toBeNull()
  })

  test('TYPE_W x TYPE_H RGBA: cirrus, cumulus, alto, confidence', () => {
    const image = typeGridImage(uniform(0, 1, 0), () => START)!
    expect(image).toHaveLength(TYPE_W * TYPE_H * 4)
    expect(texel(image, 10, 10)).toEqual([0, 0, 255, 255])
    expect(texel(typeGridImage(uniform(0.3, 0, 0), () => START)!, 0, 0)).toEqual([0, 255, 0, 255])
  })

  test('bottom row first: south at row 0', () => {
    const image = typeGridImage(
      grid((key, lat) => (lat > 0 ? (key === 'high' ? 1 : 0) : key === 'low' ? 0.95 : 0)),
      () => START
    )!
    expect(typeTexelLat(0)).toBe(-88.75)
    // Stratus: no cirrus, cumulus or alto, full confidence.
    expect(texel(image, 5, 0)).toEqual([0, 0, 0, 255])
    expect(texel(image, 5, TYPE_H - 1)).toEqual([255, 0, 0, 255])
  })

  test('texel centres line up with the grid: a lone cell peaks symmetrically about its centre', () => {
    // Thin high cloud only in the cell centred on 5°N 0°E.
    const image = typeGridImage(
      grid((key, lat, lon) => (key === 'high' && lat === 5 && lon === 0 ? 0.15 : 0)),
      () => START
    )!
    const conf = (x: number, y: number) => texel(image, x, y)[3]
    // 0° falls between columns 71 and 72, 5°N between rows 37 and 38.
    expect(typeTexelLon(71)).toBe(-1.25)
    expect(typeTexelLon(72)).toBe(1.25)
    expect([typeTexelLat(37), typeTexelLat(38)]).toEqual([3.75, 6.25])
    const peak = conf(71, 37)
    expect(peak).toBeGreaterThan(150)
    expect([conf(72, 37), conf(71, 38), conf(72, 38)]).toEqual([peak, peak, peak])
    expect(conf(70, 37)).toBeLessThan(peak)
    expect(conf(75, 37)).toBe(0)
  })

  test('wraps across 180°', () => {
    // High cloud only along the column of cells centred on 180°.
    const image = typeGridImage(
      grid((key, _lat, lon) => (key === 'high' && lon === -180 ? 0.1 : 0)),
      () => START
    )!
    expect(typeTexelLon(0)).toBe(-178.75)
    expect(typeTexelLon(TYPE_W - 1)).toBe(178.75)
    expect(texel(image, 0, 30)[3]).toBeGreaterThan(0)
    expect(texel(image, 0, 30)).toEqual(texel(image, TYPE_W - 1, 30))
  })

  test('beyond the outer rows, the poles keep the outer rows', () => {
    const image = typeGridImage(
      grid((key, lat) => (key === 'high' ? (lat === 85 ? 0.08 : 0) : key === 'low' ? (lat === -85 ? 0.06 : 0) : 0)),
      () => START
    )!
    // 88.75° and 86.25° are both beyond 85°: the same.
    expect(texel(image, 20, TYPE_H - 1)).toEqual(texel(image, 20, TYPE_H - 2))
    expect(texel(image, 20, TYPE_H - 1)[3]).toBe(Math.round(255 * smoothstep(0.02, 0.15, 0.08)))
    expect(texel(image, 20, 0)).toEqual(texel(image, 20, 1))
    expect(texel(image, 20, 0)[1]).toBe(255)
  })

  test('linear in time between hours', () => {
    // High cover rising from 0 to 10% over the first hour.
    const rising = grid((key, _lat, _lon, h) => (key === 'high' ? Math.min(h, 1) * 0.1 : 0))
    const half = typeGridImage(rising, () => START + HOUR_MS / 2)!
    expect(texel(half, 50, 30)[3]).toBe(Math.round(255 * smoothstep(0.02, 0.15, 0.05)))
    expect(texel(typeGridImage(rising, () => START)!, 50, 30)[3]).toBe(0)
  })

  test('a time for each column; columns the grid does not cover are untyped', () => {
    const rising = grid((key, _lat, _lon, h) => (key === 'high' ? Math.min(h, 1) * 0.1 : 0))
    const image = typeGridImage(rising, (lon) => (lon < 0 ? START + HOUR_MS : lon < 90 ? START : START - HOUR_MS))!
    expect(texel(image, 10, 30)[3]).toBe(Math.round(255 * smoothstep(0.02, 0.15, 0.1)))
    expect(texel(image, 80, 30)[3]).toBe(0)
    const covered = typeGridImage(uniform(0.3, 0, 0), (lon) => (lon < 90 ? START : START - HOUR_MS))!
    expect(texel(covered, 80, 30)).toEqual([0, 255, 0, 255])
    expect(texel(covered, TYPE_W - 1, 30)).toEqual([0, 0, 0, 0])
  })
})

describe('dailyTimeOfLon', () => {
  const g = uniform(0, 0, 0)
  const day = START

  test("the afternoon overpass's UTC time within the composite's day", () => {
    const at = dailyTimeOfLon({ ...g, hours: 48 }, day)
    expect(at(0)).toBe(day + 13.5 * HOUR_MS)
    expect(at(90)).toBe(day + 7.5 * HOUR_MS)
    expect(at(180)).toBe(day + 1.5 * HOUR_MS)
    // West of 157.5°W the overpass of the local day before, early in the UTC day.
    expect(at(-165)).toBe(day + 0.5 * HOUR_MS)
    expect(at(-150)).toBe(day + 23.5 * HOUR_MS)
  })

  test("noon where the grid doesn't cover the overpass", () => {
    // A grid from 06:00 to 18:00 of the day.
    const at = dailyTimeOfLon({ ...g, startMs: day + 6 * HOUR_MS, hours: 13 }, day)
    expect(at(0)).toBe(day + 13.5 * HOUR_MS)
    expect(at(180)).toBe(day + DAY_MS / 2)
  })
})

describe('refineWithIr', () => {
  const sum = (s: TypeShares) => s[0] + s[1] + s[2] + s[3]
  // A mixed cell: some of every kind, cumulus and stratus 1:2.
  const mixed: TypeShares = [0.3, 0.1, 0.4, 0.2]

  test('leaves the shares as they are where the satellites don\'t see', () => {
    for (const km of [1, 7, 11]) expect(refineWithIr(mixed, km, 0.3, 0)).toEqual(mixed)
  })

  test('takes a cold top that lets light through for cirrus', () => {
    const s = refineWithIr(mixed, 9, 0.3, 1)
    expect(s[0]).toBeCloseTo(mixed[0] + IR_WEIGHT * (1 - mixed[0]), 9)
    // Opaque at the same height, it isn't.
    expect(refineWithIr(mixed, 9, 0.9, 1)[0]).toBeCloseTo(mixed[0], 9)
  })

  test('takes a deep, opaque top for towering cumulus', () => {
    const s = refineWithIr(mixed, 13, 0.95, 1)
    expect(s[1]).toBeCloseTo(mixed[1] + IR_WEIGHT * (1 - mixed[1]), 9)
  })

  test('leaves an opaque mid-height top (frontal cloud as often) to the model', () => {
    expect(refineWithIr(mixed, 7, 0.95, 1)).toEqual(mixed.map((x) => expect.closeTo(x, 9)))
  })

  test('moves a warm top\'s mid and high cloud to low, split as the model splits it', () => {
    const s = refineWithIr(mixed, 1.5, 0.8, 1)
    expect(s[0]).toBeCloseTo(mixed[0] * (1 - IR_WEIGHT), 9)
    expect(s[2]).toBeCloseTo(mixed[2] * (1 - IR_WEIGHT), 9)
    expect(s[3] / s[1]).toBeCloseTo(mixed[3] / mixed[1], 9)
    // With no low cloud in the model, a warm top is a deck.
    const high = refineWithIr([1, 0, 0, 0], 1.5, 0.8, 1)
    expect(high[1]).toBe(0)
    expect(high[3]).toBeCloseTo(IR_WEIGHT, 9)
  })

  test('keeps the shares summing to 1, each between 0 and 1, pulled at most IR_WEIGHT', () => {
    for (const km of [0, 2, 3.5, 5, 6.5, 8, 9.5, 11, 14, 16]) {
      for (const opacity of [0, 0.4, 0.6, 0.8, 1]) {
        for (const trust of [0, 0.5, 1]) {
          for (const s of [mixed, [1, 0, 0, 0], [0, 0, 0, 1], [0, 0.5, 0.5, 0]] as TypeShares[]) {
            const r = refineWithIr(s, km, opacity, trust)
            expect(sum(r)).toBeCloseTo(1, 9)
            for (let i = 0; i < 4; i++) {
              expect(r[i]).toBeGreaterThanOrEqual(-1e-12)
              expect(r[i]).toBeLessThanOrEqual(1 + 1e-12)
              // What a share loses is at most the pull's.
              expect(r[i]).toBeGreaterThanOrEqual(s[i] * (1 - IR_WEIGHT * trust) - 1e-12)
            }
          }
        }
      }
    }
  })
})

describe('lookOf', () => {
  const keys = Object.keys(NEUTRAL_LOOK) as (keyof CloudLook)[]

  test('is exactly the untyped look with no confidence, whatever the shares', () => {
    for (const s of [[1, 0, 0, 0], [0, 1, 0, 0], [0.2, 0.3, 0.1, 0.4], [0, 0, 0, 0]] as TypeShares[]) {
      expect(lookOf(s, 0)).toEqual(NEUTRAL_LOOK)
    }
  })

  test('draws stratus as tides-tvr.3 drew every cloud', () => {
    expect(lookOf([0, 0, 0, 1], 1)).toEqual(NEUTRAL_LOOK)
    expect(TYPE_LOOKS.stratus).toEqual(NEUTRAL_LOOK)
    expect(NEUTRAL_LOOK.interior).toBe(DETAIL_INTERIOR)
  })

  test('gives cumulus steeper, lumpier tops than the deck', () => {
    const cu = lookOf([0, 1, 0, 0], 1)
    for (const key of ['relief', 'interior', 'edge', 'grain'] as const) {
      expect(cu[key]).toBeGreaterThan(NEUTRAL_LOOK[key])
    }
    expect(cu.stretch).toBe(0)
  })

  test('streaks cirrus, thin, hardly shading itself or its underside', () => {
    const ci = lookOf([1, 0, 0, 0], 1)
    expect(ci.stretch).toBe(1)
    expect(ci.occ).toBeCloseTo(0.25, 12)
    expect(ci.under).toBeCloseTo(0.3, 12)
    expect(ci.alpha).toBeCloseTo(0.85, 12)
    expect(ci.relief).toBeLessThan(NEUTRAL_LOOK.relief)
  })

  test('moves each knob from the untyped look steadily with confidence', () => {
    for (const s of [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0.3, 0.3, 0.2, 0.2]] as TypeShares[]) {
      const full = lookOf(s, 1)
      let last = lookOf(s, 0)
      for (let c = 0.1; c <= 1.0001; c += 0.1) {
        const look = lookOf(s, c)
        for (const key of keys) {
          const way = Math.sign(full[key] - NEUTRAL_LOOK[key])
          expect(way * (look[key] - last[key])).toBeGreaterThanOrEqual(-1e-12)
          expect(look[key]).toBeCloseTo(NEUTRAL_LOOK[key] + c * (full[key] - NEUTRAL_LOOK[key]), 12)
        }
        last = look
      }
    }
  })
})
