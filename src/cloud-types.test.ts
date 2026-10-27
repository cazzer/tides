import { describe, expect, test } from 'vitest'
import {
  type CloudLook,
  dailyTimeOfLon,
  IR_DECK_OPACITY,
  IR_THIN_OPACITY,
  IR_WEIGHT,
  lookOf,
  NEUTRAL_LOOK,
  refineWithIr,
  TYPE_H,
  TYPE_LOOKS,
  TYPE_W,
  type TypeShares,
  typeGridImage,
  typeShape,
  typeTexelLat,
  typeTexelLon,
  TYPE_TOP_KM,
  liftedThicknessKm,
  typedColumn,
  typedTopKm,
  typedTops,
  typedTopsTexel,
  TYPED_LIFT_SHARES,
  TYPED_TOPS_KM,
  typeTopKm,
  visibleShares,
} from './cloud-types'
import {
  cloudColumn,
  cloudShape,
  cloudTopKm,
  CLOUD_UNITS_PER_KM,
  MAX_CLOUD_TOP_KM,
  maxTopKm,
  TERRAIN_DISPLACEMENT,
} from './cloud-layer'
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

  test('moves a warm, opaque top\'s mid and high cloud to low, split as the model splits it', () => {
    // Opaque, short of a deck's opacity.
    const opacity = IR_THIN_OPACITY[1]
    const deck = smoothstep(IR_DECK_OPACITY[0], IR_DECK_OPACITY[1], opacity)
    const s = refineWithIr(mixed, 1.5, opacity, 1)
    expect(s[0]).toBeCloseTo(mixed[0] * (1 - IR_WEIGHT), 9)
    expect(s[2]).toBeCloseTo(mixed[2] * (1 - IR_WEIGHT), 9)
    // The low cloud it takes, split as the model splits it, but for what
    // the opacity says is a deck.
    const low = mixed[1] + mixed[3]
    expect(s[1]).toBeCloseTo(mixed[1] * (1 - IR_WEIGHT) + IR_WEIGHT * (1 - deck) * (mixed[1] / low), 9)
    expect(s[3]).toBeCloseTo(mixed[3] * (1 - IR_WEIGHT) + IR_WEIGHT * ((1 - deck) * (mixed[3] / low) + deck), 9)
    // With no low cloud in the model, a warm top is a deck.
    const high = refineWithIr([1, 0, 0, 0], 1.5, opacity, 1)
    expect(high[1]).toBe(0)
    expect(high[3]).toBeCloseTo(IR_WEIGHT, 9)
  })

  test('leaves a warm top that lets light through to the model (thin cirrus reads warm)', () => {
    for (const opacity of [0.1, 0.3, 0.5]) expect(refineWithIr(mixed, 1.5, opacity, 1)).toEqual(mixed)
    expect(refineWithIr([1, 0, 0, 0], 2, 0.3, 1)).toEqual([1, 0, 0, 0])
  })

  test('takes a warm, near-opaque top for a deck, whatever the model splits its low cloud as', () => {
    // A model's cirrus over a few broken cumulus: the NE Pacific's
    // stratocumulus as the model has it.
    const model: TypeShares = [0.85, 0.15, 0, 0]
    const deck = refineWithIr(model, 2, IR_DECK_OPACITY[1], 1)
    expect(deck[3]).toBeCloseTo(IR_WEIGHT, 9)
    expect(deck[1]).toBeCloseTo(model[1] * (1 - IR_WEIGHT), 9)
    // Short of near opaque, the model's split, as for broken trade cumulus.
    const broken = refineWithIr(model, 2, IR_DECK_OPACITY[0], 1)
    expect(broken[1]).toBeGreaterThan(0.6)
    expect(broken[3]).toBeCloseTo(0, 9)
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

describe('typed tops (tides-tvr.4.3, tides-tvr.4.9)', () => {
  const asShares = (v: ReturnType<typeof visibleShares>): TypeShares => [v.cirrus, v.cumulus, v.alto, v.stratus]
  /** Half a step of the tops' bytes (km). */
  const HALF_STEP = TYPED_TOPS_KM / 510
  /** A map texel as the blend writes it: its height r, opacity alpha and
   * coverage, and its tops' texel for these (unrefined) shares. */
  interface Texel {
    r: number
    alpha: number
    coverage: number
    tops: [top: number, lift: number, typed: number]
  }
  function texel(
    shares: TypeShares,
    confidence: number,
    alpha: number,
    r: number,
    coverage: number,
    measured: boolean
  ): Texel {
    const trust = measured ? coverage : 0
    const refined = refineWithIr(shares, r * MAX_CLOUD_TOP_KM, alpha, trust)
    return { r, alpha, coverage, tops: typedTopsTexel(refined, confidence, alpha, r, trust) }
  }
  /** The typed column the march reads from a texel, km over the ground's
   * base. */
  function column(t: Texel, measured: boolean, grey = 0.3) {
    const c = typedColumn(t.alpha, t.r, t.coverage, measured, t.tops, grey, TERRAIN_DISPLACEMENT)
    const km = (y: number) => (y - c.ground) / CLOUD_UNITS_PER_KM
    return { ...c, baseKm: km(c.base), topKm: km(c.top) }
  }
  /** The untyped column's top (km) for a texel's map channels. */
  const untypedTopKm = (t: Texel, measured: boolean) =>
    cloudTopKm(t.r, t.coverage, t.alpha, measured ? 1 : 0) * cloudShape(t.alpha)
  /** Texels filtered together, every channel alike: weights ws. */
  const mixTexels = (ts: Texel[], ws: number[]): Texel => {
    const at = (get: (t: Texel) => number) => ts.reduce((sum, t, i) => sum + ws[i] * get(t), 0)
    return {
      r: at((t) => t.r),
      alpha: at((t) => t.alpha),
      coverage: at((t) => t.coverage),
      tops: [at((t) => t.tops[0]), at((t) => t.tops[1]), at((t) => t.tops[2])],
    }
  }
  /** A mip's 2x2 averages of two texels. */
  const squares = (a: Texel, b: Texel) =>
    [[a, a, b, b], [a, b, b, b], [a, a, a, b]].map((square) => mixTexels(square, [0.25, 0.25, 0.25, 0.25]))
  const sound = (c: ReturnType<typeof column>, measured: boolean, what: string) => {
    expect(c.base, what).toBeGreaterThanOrEqual(c.ground)
    expect(c.top, what).toBeGreaterThanOrEqual(c.base)
    expect(c.topKm, what).toBeLessThanOrEqual(maxTopKm(measured) + 1e-9)
  }
  const forecast = (shares: TypeShares, alpha: number, confidence = 1) =>
    column(texel(shares, confidence, alpha, 0, 0, false), false)
  const measuredAt = (shares: TypeShares, alpha: number, topKm: number) =>
    column(texel(shares, 1, alpha, topKm / MAX_CLOUD_TOP_KM, 1, true), true)
  const CIRRUS: TypeShares = [1, 0, 0, 0]
  const SHARES: TypeShares[] = [
    CIRRUS,
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
    [0.25, 0.25, 0.25, 0.25],
    [0.6, 0, 0, 0.4],
    [0, 0.3, 0, 0.7],
  ]
  const ALPHAS = [0, 0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.65, 0.7, 0.8, 0.9, 1]
  const MAP_TEXELS: [r: number, coverage: number, measured: boolean][] = [
    // Unmeasured textures carry no height nor trust.
    [0, 0, false],
    ...[0, 0.05, 0.2, 0.35, 0.5, 0.7, 0.9, 1].flatMap((r) =>
      [0.3, 1].map((coverage): [number, number, boolean] => [r, coverage, true])
    ),
  ]

  test('never draws the untyped column between a deck and a lifted layer beside it (alpha 0.9)', () => {
    const mixes: [string, (s: number) => TypeShares][] = [
      ['cirrus and stratus', (s) => [s, 0, 0, 1 - s]],
      ['alto and stratus', (s) => [0, 0, s, 1 - s]],
    ]
    const alpha = 0.9
    for (const [name, mix] of mixes) {
      for (const measured of [false, true]) {
        for (const confidence of [1, 0.5]) {
          const what = `${name} ${measured ? 'measured' : 'forecast'} ${confidence}`
          const at = (k: number) =>
            measured
              ? texel(mix(k / 100), confidence, alpha, 10 / MAX_CLOUD_TOP_KM, 1, true)
              : texel(mix(k / 100), confidence, alpha, 0, 0, false)
          // The one pair of neighbouring shares where the base leaves the
          // ground.
          const onsets: [Texel, Texel][] = []
          for (let k = 0; k < 100; k++) {
            const [a, b] = [at(k), at(k + 1)]
            const [ca, cb] = [column(a, measured), column(b, measured)]
            if (ca.base === ca.ground && cb.base > cb.ground) {
              onsets.push([a, b])
            }
          }
          expect(onsets, what).toHaveLength(1)
          const [deck, lifted] = onsets[0]
          const sides = [column(deck, measured).topKm, column(lifted, measured).topKm]
          const [low, high] = [Math.min(...sides), Math.max(...sides)]
          // The untyped column there stands well over both, so drawing it
          // would fail below. A measured top is the untyped one either side,
          // so only the base could go wrong there, and the base stays between.
          if (!measured) expect(untypedTopKm(deck, measured), what).toBeGreaterThan(high + 0.5)
          const filtered = [
            ...Array.from({ length: 101 }, (_, i) => mixTexels([deck, lifted], [1 - i / 100, i / 100])),
            ...squares(deck, lifted),
          ]
          for (const t of filtered) {
            const c = column(t, measured)
            expect(c.topKm, what).toBeLessThanOrEqual(high + 0.5)
            expect(c.topKm, what).toBeGreaterThanOrEqual(low - 0.5)
            expect(c.baseKm, what).toBeLessThanOrEqual(column(lifted, measured).baseKm + 1e-9)
            sound(c, measured, what)
          }
        }
      }
    }
  })

  test('leaves the column exactly as untyped with no confidence', () => {
    for (const shares of SHARES) {
      for (const alpha of ALPHAS) {
        for (const [r, coverage, measured] of [[0, 0, false], [0.4, 1, true], [0.8, 0.5, true]] as const) {
          const t = texel(shares, 0, alpha, r, coverage, measured)
          expect(t.tops[1]).toBe(0)
          expect(t.tops[2]).toBe(0)
          for (const grey of [0, 0.3, 1]) {
            const untyped = cloudColumn(alpha, cloudTopKm(r, coverage, alpha, measured ? 1 : 0), grey, TERRAIN_DISPLACEMENT)
            // Whatever R and G hold where B says untyped.
            for (const tops of [t.tops, [0, 0, 0], [1, 1, 0], [0.3, 0.9, 0]] as const) {
              expect(typedColumn(alpha, r, coverage, measured, tops, grey, TERRAIN_DISPLACEMENT)).toEqual({
                ground: untyped.base,
                ...untyped,
              })
            }
          }
        }
      }
    }
  })

  test('writes the top over the lift, both within the bytes, and B typed or not', () => {
    for (const shares of SHARES) {
      for (const confidence of [0, 0.3, 1]) {
        for (const alpha of ALPHAS) {
          for (const [r, coverage, measured] of MAP_TEXELS) {
            const [top, lift, typed] = texel(shares, confidence, alpha, r, coverage, measured).tops
            const what = `${shares} ${confidence} ${alpha} ${r} ${coverage}`
            expect(lift, what).toBeGreaterThanOrEqual(0)
            expect(top, what).toBeGreaterThanOrEqual(lift)
            expect(top, what).toBeLessThanOrEqual(1)
            expect(typed, what).toBe(confidence > 0 ? 1 : 0)
            for (const channel of [top, lift]) expect(Number.isInteger(channel * 255)).toBe(true)
          }
        }
      }
    }
  })

  test('reads back the column it wrote, to within half a byte', () => {
    for (const shares of SHARES) {
      for (const confidence of [0.3, 1]) {
        for (const alpha of ALPHAS) {
          for (const [r, coverage, measured] of MAP_TEXELS) {
            const trust = measured ? coverage : 0
            const refined = refineWithIr(shares, r * MAX_CLOUD_TOP_KM, alpha, trust)
            const exact = typedTops(refined, confidence, alpha, r, trust)
            const c = column(texel(shares, confidence, alpha, r, coverage, measured), measured)
            const what = `${shares} ${confidence} ${alpha} ${r} ${coverage}`
            expect(Math.abs(c.topKm - exact.topKm), what).toBeLessThanOrEqual(HALF_STEP + 1e-9)
            expect(Math.abs(c.baseKm - exact.liftKm), what).toBeLessThanOrEqual(HALF_STEP + 1e-9)
          }
        }
      }
    }
  })

  test("lifts thin forecast cirrus to a layer from 6.8 km to 8, well off the ground", () => {
    const c = forecast(CIRRUS, 0.3)
    expect(c.baseKm).toBeCloseTo(6.8, 1)
    expect(c.topKm).toBeCloseTo(8, 1)
    for (const alpha of [0.02, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5]) {
      const thin = forecast(asShares(visibleShares(0, 0, 0.6)), alpha)
      expect(thin.baseKm).toBeGreaterThanOrEqual(5)
      // Its own top, to within half a byte.
      expect(Math.abs(thin.topKm - typedTopKm(CIRRUS, alpha, 0, 0))).toBeLessThanOrEqual(HALF_STEP + 1e-9)
      // As deep as the untyped column, or a lifted layer, whichever is less,
      // to within the top's and the lift's half bytes.
      const untyped = cloudTopKm(0, 0, alpha, 0) * cloudShape(alpha)
      expect(Math.abs(thin.topKm - thin.baseKm - Math.min(untyped, liftedThicknessKm(alpha)))).toBeLessThanOrEqual(
        2 * HALF_STEP + 1e-9
      )
    }
    // Opaque, off the ground too.
    expect(forecast(CIRRUS, 0.9).baseKm).toBeGreaterThan(4)
  })

  test('lifts measured opaque cirrus off the ground, to its measured top', () => {
    const c = measuredAt(CIRRUS, 0.9, 10)
    expect(c.baseKm).toBeGreaterThanOrEqual(5)
    expect(c.topKm).toBeLessThanOrEqual(10 + HALF_STEP)
    for (const topKm of [9, 9.5, 10]) {
      for (const alpha of [0.7, 0.8, 0.9, 1]) {
        expect(measuredAt(CIRRUS, alpha, topKm).baseKm).toBeGreaterThanOrEqual(5)
      }
    }
    // Thin, its whole measured height but a layer.
    const thin = measuredAt(CIRRUS, 0.4, 10)
    expect(thin.baseKm).toBeGreaterThan(7.5)
    expect(thin.topKm).toBeCloseTo(10, 1)
  })

  test('stands deep convection on the ground, as tall as measured', () => {
    for (const alpha of [0.8, 1]) {
      const c = measuredAt([0, 1, 0, 0], alpha, 12)
      expect(c.base).toBe(c.ground)
      // A cumulus's dome, its share of the measured top.
      expect(c.topKm).toBeCloseTo(12 * typeShape('cumulus', alpha), 1)
    }
  })

  test('lifts a forecast alto deck to a layer from 2 km to 5', () => {
    const c = forecast([0, 0, 1, 0], 0.8)
    expect(c.baseKm).toBeCloseTo(2, 1)
    expect(c.topKm).toBeCloseTo(5, 1)
  })

  test("stands a forecast frame's stratocumulus deck 1.5 to 2.2 km tall, on the ground", () => {
    // The NE Pacific's: low cloud of a deck's cover, a little cirrus over it
    // or none, as a forecast frame has it (no measured heights).
    for (const [low, high] of [[0.8, 0], [0.9, 0], [1, 0], [0.9, 0.05]]) {
      const v = visibleShares(low, 0, high)
      expect(v.confidence).toBe(1)
      for (const alpha of [0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
        const c = forecast(asShares(v), alpha)
        expect(c.topKm).toBeGreaterThanOrEqual(1.5)
        expect(c.topKm).toBeLessThanOrEqual(2.2)
        expect(c.base).toBe(c.ground)
      }
    }
    // Where untyped it stood up to 8.5 km.
    expect(cloudTopKm(0, 0, 1, 0) * cloudShape(1)).toBeGreaterThan(6)
  })

  test('never stands a top over the tallest the map can give, nor a base under the ground or over its top', () => {
    for (const shares of SHARES) {
      for (const confidence of [0, 0.3, 0.7, 1]) {
        for (const alpha of ALPHAS) {
          for (const [r, coverage, measured] of MAP_TEXELS) {
            sound(column(texel(shares, confidence, alpha, r, coverage, measured), measured), measured, `${shares} ${alpha} ${r}`)
          }
        }
      }
    }
    expect(Math.max(...Object.values(TYPE_TOP_KM), typeTopKm('cumulus', 1))).toBeLessThan(maxTopKm(false))
  })

  test('holds up where texels are filtered together, whatever their tops', () => {
    const clear = (shares: TypeShares, measured: boolean) => texel(shares, 1, 0, 0, measured ? 1 : 0, measured)
    const pairs: [string, Texel, Texel, boolean][] = [
      // A forecast deck's opaque edge (lowered most) beside clear air.
      ['stratus deck edge', texel([0, 0, 0, 1], 1, 1, 0, 0, false), clear([0, 0, 0, 1], false), false],
      ['stratus deck by an untyped gap', texel([0, 0, 0, 1], 1, 1, 0, 0, false), texel(CIRRUS, 0, 0, 0, 0, false), false],
      ['cirrus edge', texel(CIRRUS, 1, 0.3, 0, 0, false), clear(CIRRUS, false), false],
      ['opaque cirrus by clear', texel(CIRRUS, 1, 0.9, 0, 0, false), texel(CIRRUS, 0, 0, 0, 0, false), false],
      ['opaque cirrus by untyped cloud', texel(CIRRUS, 1, 0.9, 0, 0, false), texel(CIRRUS, 0, 0.9, 0, 0, false), false],
      ['lifted cirrus by a lowered deck', texel(CIRRUS, 1, 0.3, 0, 0, false), texel([0, 0, 0, 1], 1, 1, 0, 0, false), false],
      ['lifted alto by a lowered deck', texel([0, 0, 1, 0], 1, 0.8, 0, 0, false), texel([0, 0, 0, 1], 1, 0.6, 0, 0, false), false],
      ['measured cirrus by deep convection', texel(CIRRUS, 1, 0.9, 10 / 16, 1, true), texel([0, 1, 0, 0], 1, 1, 0.75, 1, true), true],
      ['measured cirrus edge', texel(CIRRUS, 1, 0.4, 13 / 16, 1, true), clear(CIRRUS, true), true],
      ['measured cirrus by untyped cloud', texel(CIRRUS, 1, 0.4, 13 / 16, 1, true), texel(CIRRUS, 0, 1, 0.9, 1, true), true],
      ['the highest lift by opaque cloud', { r: 0, alpha: 0.2, coverage: 0, tops: [1, 1, 1] }, texel([0, 0, 0, 1], 1, 1, 0, 0, false), false],
    ]
    for (const [name, a, b, measured] of pairs) {
      for (const w of [0, 0.1, 0.25, 0.375, 0.5, 0.625, 0.75, 0.9, 1]) {
        sound(column(mixTexels([a, b], [1 - w, w]), measured), measured, `${name} at ${w}`)
      }
      for (const t of squares(a, b)) sound(column(t, measured), measured, `${name} mip`)
    }
  })

  test('keeps the top continuous over the shares, only the base stepping where a column is lifted', () => {
    const mixes: [string, (s: number) => TypeShares][] = [
      ['cirrus and stratus', (s) => [s, 0, 0, 1 - s]],
      ['alto and stratus', (s) => [0, 0, s, 1 - s]],
      ['cirrus and cumulus', (s) => [s, 1 - s, 0, 0]],
    ]
    for (const [name, mix] of mixes) {
      for (const alpha of [0.3, 0.5, 0.7, 0.9, 1]) {
        for (const confidence of [0.25, 0.5, 1]) {
          for (const measured of [false, true]) {
            let prev: ReturnType<typeof column> | null = null
            let steps = 0
            for (let k = 0; k <= 100; k++) {
              const t = measured
                ? texel(mix(k / 100), confidence, alpha, 10 / MAX_CLOUD_TOP_KM, 1, true)
                : texel(mix(k / 100), confidence, alpha, 0, 0, false)
              const c = column(t, measured)
              const what = `${name} ${alpha} ${confidence} ${measured} at ${k / 100}`
              if (prev) {
                // A quarter of a km over a hundredth of the shares at most,
                // give or take the rounding to a byte.
                const most = 0.25 + 2 * HALF_STEP
                expect(Math.abs(c.topKm - prev.topKm), what).toBeLessThanOrEqual(most)
                if (Math.abs(c.baseKm - prev.baseKm) > most) {
                  // Only where it goes from the ground to lifted, at the
                  // onset of the lift.
                  expect(prev.base === prev.ground !== (c.base === c.ground), what).toBe(true)
                  steps++
                }
              }
              prev = c
            }
            expect(steps, `${name} ${alpha} ${confidence} ${measured}`).toBeLessThanOrEqual(1)
          }
        }
      }
    }
    expect(TYPED_LIFT_SHARES[0]).toBe(0.5)
  })

  test('keeps a lowered top on the ground, and lowers a share of it at most', () => {
    // Opaque cumulus heaps, untyped 8.5 km tall.
    const c = forecast([0, 1, 0, 0], 0.6)
    expect(c.base).toBe(c.ground)
    expect(c.topKm).toBeCloseTo(typeTopKm('cumulus', 0.6) * typeShape('cumulus', 0.6), 1)
    // A thin edge whose own top would be taller stays as it was.
    const edge = forecast([0, 0, 0, 1], 0.1)
    expect(Math.abs(edge.topKm - cloudTopKm(0, 0, 0.1, 0) * cloudShape(0.1))).toBeLessThanOrEqual(HALF_STEP + 1e-9)
    expect(typedTopKm([1, 0, 0, 0], 0.5, 0, 0)).toBeCloseTo(TYPE_TOP_KM.cirrus * typeShape('cirrus', 0.5), 12)
  })
})
