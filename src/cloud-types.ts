// What kind of cloud the real-weather clouds are (tides-tvr.4.1): Open-Meteo's
// low, mid and high cloud cover (./forecast-clouds.ts) as a small per-frame
// "type grid" the GPU blends alongside the frames (renderers/cloudBlend.ts).
// The satellites' map stays the where-cloud; this only says what it is.
//
// From above, a layer shows where the layers over it leave gaps. With the
// layers overlapping at random, high cloud covers H of the sky, mid shows
// through the rest, M (1 - H), and low through what's left, L (1 - M)(1 - H).
// Normalised, those are the shares of each kind in what a camera above sees:
// high is cirrus, mid alto, and low splits into cumulus where it is broken
// and stratus (stratocumulus included) where it is a deck. The grid's
// confidence fades to 0 where the model has next to no cloud, so a clear
// cell's leftover type never decides anything.
//
// The grid is TYPE_W x TYPE_H RGBA8, bottom row first like a CloudImage: R
// cirrus, G cumulus, B alto, A confidence, stratus the rest of RGB's share.
// Pure; the build is renderers/cloudPipeline.ts.
import { gridCovers, layersAt, sampleCoverSmooth, type CoverGrid, type CoverLayers } from './forecast-clouds'
import { DAY_MS, HOUR_MS, smoothstep } from './real-clouds'
import {
  cloudColumn,
  cloudShape,
  cloudTopKm,
  CLOUD_UNITS_PER_KM,
  MAX_CLOUD_TOP_KM,
  maxTopKm,
  MIN_MEASURED_TOP_KM,
} from './cloud-layer'

/** The type grid: 2.5° texels, equirectangular like the cloud map. */
export const TYPE_W = 144
export const TYPE_H = 72
/** Visible cloud (0..1) at which the confidence starts and is full. */
export const TYPE_CONFIDENCE_EDGES = [0.02, 0.15] as const
/** Low cover from which it stops reading as broken cumulus and is a deck. */
export const CUMULUS_BROKEN_EDGES = [0.45, 0.85] as const
/** Local solar time of the daily composite's satellites' overpass (VIIRS on
 * Suomi NPP and MODIS on Terra cross the equator at about 13:30 and 10:30;
 * the afternoon one, as VIIRS is what the composite uses since 2015). */
export const OVERPASS_LOCAL_HOURS = 13.5

export interface CloudTypeShares {
  cirrus: number
  cumulus: number
  alto: number
  stratus: number
  /** 0..1: how far to trust the shares (0 where there is next to no cloud). */
  confidence: number
}

/** The shares of each kind in the cloud seen from above, from low, mid and
 * high cover (0..1); they sum to 1, or are all 0 where nothing shows. */
export function visibleShares(low: number, mid: number, high: number): CloudTypeShares {
  const vHigh = high
  const vMid = mid * (1 - high)
  const vLow = low * (1 - mid) * (1 - high)
  const total = vHigh + vMid + vLow
  const confidence = smoothstep(TYPE_CONFIDENCE_EDGES[0], TYPE_CONFIDENCE_EDGES[1], total)
  if (!(total > 0)) return { cirrus: 0, cumulus: 0, alto: 0, stratus: 0, confidence: 0 }
  const lowShare = vLow / total
  const broken = 1 - smoothstep(CUMULUS_BROKEN_EDGES[0], CUMULUS_BROKEN_EDGES[1], low)
  return {
    cirrus: vHigh / total,
    cumulus: lowShare * broken,
    alto: vMid / total,
    stratus: lowShare * (1 - broken),
    confidence,
  }
}

/** Centre of a type grid texel: column x from the west, row y from the
 * bottom (south), as the grid is stored. */
export const typeTexelLon = (x: number) => -180 + ((x + 0.5) / TYPE_W) * 360
export const typeTexelLat = (y: number) => -90 + ((y + 0.5) / TYPE_H) * 180

/**
 * The type grid for a frame, or null when the grid has no layers. timeOfLon
 * says when the frame shows each longitude (one time for a geostationary or
 * forecast frame, the overpass for a daily composite); columns whose time the
 * grid doesn't cover are untyped (all 0). The layers are resampled at the
 * texel centres with smoothstep-weighted bilinear, then turned into shares.
 */
export function typeGridImage(
  grid: CoverGrid,
  timeOfLon: (lonDeg: number) => number
): Uint8Array<ArrayBuffer> | null {
  if (!grid.layers) return null
  const out = new Uint8Array(TYPE_W * TYPE_H * 4)
  // Usually one time for every column.
  const atTime = new Map<number, CoverLayers | null>()
  for (let x = 0; x < TYPE_W; x++) {
    const lon = typeTexelLon(x)
    const t = timeOfLon(lon)
    let layers = atTime.get(t)
    if (layers === undefined) {
      layers = layersAt(grid, t)
      atTime.set(t, layers)
    }
    if (!layers) continue
    for (let y = 0; y < TYPE_H; y++) {
      const lat = typeTexelLat(y)
      const s = visibleShares(
        sampleCoverSmooth(layers.low, lat, lon),
        sampleCoverSmooth(layers.mid, lat, lon),
        sampleCoverSmooth(layers.high, lat, lon)
      )
      const i = (y * TYPE_W + x) * 4
      out[i] = Math.round(255 * s.cirrus)
      out[i + 1] = Math.round(255 * s.cumulus)
      out[i + 2] = Math.round(255 * s.alto)
      out[i + 3] = Math.round(255 * s.confidence)
    }
  }
  return out
}

/**
 * When a daily composite (dated dayMs, its UTC midnight) shows a longitude:
 * the satellite's afternoon overpass there, taken within that UTC day (west
 * of 157.5°W the overpass of the local day before, early in the UTC day), or
 * noon where the grid doesn't cover that.
 */
export function dailyTimeOfLon(grid: CoverGrid, dayMs: number): (lonDeg: number) => number {
  const noon = dayMs + DAY_MS / 2
  return (lonDeg) => {
    const hours = (((OVERPASS_LOCAL_HOURS - lonDeg / 15) % 24) + 24) % 24
    const t = dayMs + hours * HOUR_MS
    return gridCovers(grid, t) ? t : noon
  }
}

// How each kind looks up close (tides-tvr.4.2), drawn by the cloud shell at
// the hit (renderers/cloudTypeGlsl.ts, renderers/cloudShaders.ts) from the
// blended type grid. Every number here is the shader's.

/** Shares of cirrus, cumulus, alto and stratus, in the grid's order (R, G,
 * B, and the rest). */
export type TypeShares = readonly [cirrus: number, cumulus: number, alto: number, stratus: number]

// The satellites' infrared says what the model can't: how cold and how
// opaque the top over a point is now. A cold top that lets light through is
// cirrus; a deep, opaque one is towering cumulus (opaque tops of 6-9 km are
// as often frontal nimbostratus or altostratus, so they are left to the
// model); a warm, opaque one is low cloud: a deck (stratocumulus) where it
// is near opaque, else cumulus or stratus as the model has it. A warm top
// that lets light through is left to the model too: thin cirrus reads warm,
// the ground's warmth showing through it. Where the satellites see (trust),
// the refinement takes IR_WEIGHT of the shares that far.
export const IR_WEIGHT = 0.7
/** Top height (km) from which a top reads as cold enough for cirrus. */
export const IR_COLD_KM = [5.5, 8] as const
/** Top height (km) from which an opaque top reads as a towering cumulus. */
export const IR_DEEP_KM = [9, 12] as const
/** Top height (km) under which a top reads as low cloud (as 1 minus). */
export const IR_WARM_KM = [3, 4.5] as const
/** Opacity under which a top lets enough light through to be thin. */
export const IR_THIN_OPACITY = [0.5, 0.75] as const
/** Opacity from which a warm top reads as a deck, whatever the model's split
 * of its low cloud (the NE Pacific's stratocumulus, under a model's cirrus,
 * would otherwise go to its few broken cumulus). */
export const IR_DECK_OPACITY = [0.7, 0.9] as const

/**
 * The shares s refined by the infrared over a point: its top's height
 * (topKm), opacity (0..1) and how far the satellites see it (trust, 0..1).
 * Still sums to 1; only moves shares between kinds, so it never raises the
 * confidence, and with no trust it leaves them as they are.
 */
export function refineWithIr(s: TypeShares, topKm: number, opacity: number, trust: number): TypeShares {
  const w = IR_WEIGHT * trust
  const cold = smoothstep(IR_COLD_KM[0], IR_COLD_KM[1], topKm)
  const deep = smoothstep(IR_DEEP_KM[0], IR_DEEP_KM[1], topKm)
  const warm = 1 - smoothstep(IR_WARM_KM[0], IR_WARM_KM[1], topKm)
  const thin = 1 - smoothstep(IR_THIN_OPACITY[0], IR_THIN_OPACITY[1], opacity)
  const deck = smoothstep(IR_DECK_OPACITY[0], IR_DECK_OPACITY[1], opacity)
  // Low cloud keeps the model's split between cumulus and stratus (with no
  // low share at all, a deck), but for a near-opaque top, which is a deck.
  const low = s[1] + s[3]
  const [modelCumulus, modelStratus] = low > 1e-3 ? [s[1] / low, s[3] / low] : [0, 1]
  const lowCumulus = modelCumulus * (1 - deck)
  const lowStratus = modelStratus * (1 - deck) + deck
  const toCirrus = cold * thin
  const toCumulus = deep * (1 - thin)
  const toLow = warm * (1 - thin)
  // What the IR takes from every share, toward what it says: at most w, as
  // warm tops are never cold or deep.
  const keep = 1 - w * (toCirrus + toCumulus + toLow)
  return [
    s[0] * keep + w * toCirrus,
    s[1] * keep + w * (toCumulus + toLow * lowCumulus),
    s[2] * keep,
    s[3] * keep + w * toLow * lowStratus,
  ]
}

/** The knobs of a cloud's look at the hit. */
export interface CloudLook {
  /** The tops' tilt per unit of their slope over the map (RELIEF). */
  relief: number
  /** How much an octave large on screen erodes inside a cloud
   * (DETAIL_INTERIOR). */
  interior: number
  /** How much the detail erodes the opacity (DETAIL_EDGE). */
  edge: number
  /** The detail's tilt of the tops (DETAIL_RELIEF). */
  grain: number
  /** How far the detail is stretched east-west (0..1 of CIRRUS_STRETCH). */
  stretch: number
  /** How much taller cloud toward the Sun shades the top. */
  occ: number
  /** How much of the darkening down its column the underside keeps. */
  under: number
  /** The opacity's scale. */
  alpha: number
}

/** The look of tides-tvr.3, untyped clouds' and stratus's: the shader's own
 * defines. */
export const NEUTRAL_LOOK: Readonly<CloudLook> = {
  relief: 1.2,
  interior: 0.15,
  edge: 0.8,
  grain: 0.35,
  stretch: 0,
  occ: 1,
  under: 1,
  alpha: 1,
}

/**
 * Each kind's look. Cumulus: steeper, lumpier tops whose inside erodes more,
 * at heaps and towers' scale: mostly from the grain (the detail's tilt) and
 * the erosion, which up close are what shows, rather than holes in the
 * inside (an interior of 0.45 pitted it as tides-tvr.3 set out to stop).
 * Stratus: the smooth deck of tides-tvr.3. Alto: a little flatter and
 * smoother. Cirrus: thin streaks drawn out east-west along the jet, barely
 * tilted, hardly shading itself or its underside, and a little more
 * see-through.
 */
export const TYPE_LOOKS: Readonly<Record<'cirrus' | 'cumulus' | 'alto' | 'stratus', Readonly<CloudLook>>> = {
  cirrus: { relief: 0.3, interior: 0.35, edge: 0.9, grain: 0.1, stretch: 1, occ: 0.25, under: 0.3, alpha: 0.85 },
  cumulus: { relief: 1.8, interior: 0.3, edge: 1.2, grain: 0.8, stretch: 0, occ: 1, under: 1, alpha: 1 },
  alto: { relief: 0.9, interior: 0.2, edge: 0.7, grain: 0.25, stretch: 0, occ: 1, under: 1, alpha: 1 },
  stratus: NEUTRAL_LOOK,
}

/** How far cirrus's detail is drawn out east-west, as the scale of its noise
 * across the pole axis, in the clouds' frame: east-west at the equator, less
 * so toward the poles, where the stretch lies along the ground every way
 * alike. */
export const CIRRUS_STRETCH = 4
/** The stretch share over which the detail goes from round to stretched: the
 * two are drawn and mixed between, which costs a second evaluation. */
export const STRETCH_EDGES = [0.25, 0.4] as const
/** |sin latitude| over which the stretch fades out toward the poles, where
 * it no longer reads as east-west (about 55° to 75°). */
export const STRETCH_POLE_EDGES = [0.82, 0.97] as const

const LOOK_KEYS = ['relief', 'interior', 'edge', 'grain', 'stretch', 'occ', 'under', 'alpha'] as const

/** The look of cloud with these shares, trusted confidence (0..1) of the
 * way from the untyped look: exactly NEUTRAL_LOOK with no confidence. */
export function lookOf(shares: TypeShares, confidence: number): CloudLook {
  const looks = [TYPE_LOOKS.cirrus, TYPE_LOOKS.cumulus, TYPE_LOOKS.alto, TYPE_LOOKS.stratus]
  const out = { ...NEUTRAL_LOOK }
  if (!(confidence > 0)) return out
  for (const key of LOOK_KEYS) {
    const typed = looks.reduce((sum, look, i) => sum + shares[i] * look[key], 0)
    out[key] = NEUTRAL_LOOK[key] + confidence * (typed - NEUTRAL_LOOK[key])
  }
  return out
}

// How high each kind stands (tides-tvr.4.3). Untyped, a top's height comes
// from its opacity where no satellite measured it (../cloud-layer.ts
// defaultTopKm(), up to 8.5 km for opaque cloud): a forecast frame's
// stratocumulus deck stood about 6 km tall. Typed, each kind has a top of
// its own where unmeasured, and where the satellites measured one, theirs,
// as untyped; and a shape of its own over its opacity, as cloudShape() is
// the untyped one: cumulus domes from thin edges, stratus and alto decks
// keep most of their height to their edges, cirrus nearly all of it.
//
// The blend (renderers/cloudBlend.ts) writes each texel's typed column into
// a second texture beside the blended map, the "tops", which the march
// (renderers/cloudShaders.ts cloudColumn()) reads at the same place and mip
// as the map: R the column's top, G how far its base stands off the ground
// (both over TYPED_TOPS_KM), B whether it is typed at all (1, or 0 where the
// types leave it alone: confidence 0, the untyped column exactly). Where it
// is lowered (a forecast frame's deck, 1.8 km rather than 6) the top is a
// share of the untyped one's and the base is on the ground; where it is
// lifted (cirrus high up rather than a veil from the ground to 8 km) the
// column is a layer as deep as liftedThicknessKm(), whether the satellites
// measured its top or not. Only cirrus and alto lift a column, where they
// are most of it; cumulus, however tall, and stratus stand on the ground.
// One layer to a column: cirrus over a deck is one slab between them.
//
// Each channel is a height, or a weight on one, so filtering (bilinear,
// mips) mixes heights: a filtered top lies between its texels' tops, a
// filtered base between their bases, and a texel only partly typed mixes
// toward the untyped column by how much. tides-tvr.4.3 put the column in the
// map's alpha as one byte, a lowered share under 128 and a lift over it, so
// a deck beside a lifted layer filtered through 128, "no change", and drew
// the full untyped column there: a wall a texel thin and kilometres taller
// than either side. No one byte can hold both ways and filter between them;
// keeping 128 out of reach either drew the wall or cracked the deck to the
// ground.

/** The kinds, in the type grid's order (TypeShares). */
export const CLOUD_KINDS = ['cirrus', 'cumulus', 'alto', 'stratus'] as const
export type CloudKind = (typeof CLOUD_KINDS)[number]

/** Each kind's top (km above the ground) where unmeasured, but cumulus's,
 * which rises with its opacity (CUMULUS_TOP_KM). All under maxTopKm(false),
 * so a typed top is never taller than the untyped tallest. */
export const TYPE_TOP_KM: Readonly<Record<Exclude<CloudKind, 'cumulus'>, number>> = {
  cirrus: 8,
  alto: 5,
  stratus: 1.8,
}
/** Cumulus's top where unmeasured: [0] + [1] alpha², heaps to towers. */
export const CUMULUS_TOP_KM = [1.2, 2.3] as const
/** Each kind's shape over its opacity: the share of its top's height it
 * keeps at no opacity, rising to all of it from [1] to [2]. */
export const TYPE_SHAPES: Readonly<Record<CloudKind, readonly [floor: number, from: number, to: number]>> = {
  cirrus: [0.85, 0, 0.3],
  cumulus: [0.15, 0.05, 0.9],
  alto: [0.6, 0, 0.35],
  stratus: [0.6, 0, 0.35],
}

/** A kind's top (km) where unmeasured, at opacity alpha. */
export function typeTopKm(kind: CloudKind, alpha: number): number {
  return kind === 'cumulus' ? CUMULUS_TOP_KM[0] + CUMULUS_TOP_KM[1] * alpha * alpha : TYPE_TOP_KM[kind]
}

/** How much of its top's height a kind keeps at opacity alpha. */
export function typeShape(kind: CloudKind, alpha: number): number {
  const [floor, from, to] = TYPE_SHAPES[kind]
  return floor + (1 - floor) * smoothstep(from, to, alpha)
}

/**
 * The shaped top (km above the ground) of cloud with these shares (refined
 * by the infrared, refineWithIr()) at opacity alpha, over a map texel's
 * measured height r (0..1 of MAX_CLOUD_TOP_KM) trusted trust (0..1, its
 * confidence where the map is measured, else 0): each kind's own top where
 * unmeasured, the measured one as far as it is trusted, as cloudTopKm().
 */
export function typedTopKm(shares: TypeShares, alpha: number, r: number, trust: number): number {
  const measured = Math.max(r * MAX_CLOUD_TOP_KM, MIN_MEASURED_TOP_KM)
  return CLOUD_KINDS.reduce((sum, kind, i) => {
    const km = typeTopKm(kind, alpha) * (1 - trust) + measured * trust
    return sum + shares[i] * km * typeShape(kind, alpha)
  }, 0)
}

/** How deep (km) a lifted layer is at opacity alpha: [0] + [1] alpha, thin
 * cirrus to an alto deck; never deeper than the untyped column. */
export const LIFTED_THICKNESS_KM = [1, 2.5] as const
export function liftedThicknessKm(alpha: number): number {
  return LIFTED_THICKNESS_KM[0] + LIFTED_THICKNESS_KM[1] * alpha
}

/** The share of cirrus and alto from which a column is lifted ([0]), and
 * over which ([0] to [1]) a typed top taller than the untyped one rises to
 * it: on the ground it could stand no taller, so from [0] on the top is
 * the same either side, and only the base steps up. Lifted by the share
 * itself, a mixed column was a slab hung half way (an opaque 12 km top the
 * infrared reads as mostly towering cumulus, refineWithIr(), 2.7 to 5.9
 * km), and at the onset its top spiked and dipped by 2 km. */
export const TYPED_LIFT_SHARES = [0.5, 1] as const

/** The least share of its height a lowered top keeps. */
export const TYPED_LOWEST_SHARE = 0.1
/** The height (km) the tops' R and G are over: measured tops reach the map's
 * tallest. */
export const TYPED_TOPS_KM = MAX_CLOUD_TOP_KM

/**
 * The typed column the blend writes for cloud with these shares (refined by
 * the infrared, refineWithIr()) and confidence, at opacity alpha, over a map
 * texel's measured height r trusted trust (as typedTopKm()): its top and how
 * far its base is lifted (km), and whether it is typed. The top is the typed
 * one, lowered on the ground to a share of the untyped one's and never
 * raised; or, where it is mostly cirrus and alto (TYPED_LIFT_SHARES), lifted
 * so that a layer reaches it: a forecast frame's thin cirrus from 6.8 km to
 * 8, a measured opaque one to its measured top. Either way the top is
 * continuous over the shares; only the base steps. Both go confidence of the
 * way from the untyped column, linearly, so a texel's confidence filters as
 * its heights do. With no confidence, the untyped top and untyped.
 */
export function typedTops(
  shares: TypeShares,
  confidence: number,
  alpha: number,
  r: number,
  trust: number
): { topKm: number; liftKm: number; typed: boolean } {
  const untyped = cloudTopKm(r, trust, alpha, 1) * cloudShape(alpha)
  if (!(confidence > 0)) return { topKm: untyped, liftKm: 0, typed: false }
  const typed = typedTopKm(shares, alpha, r, trust)
  let top = Math.min(Math.max(typed, TYPED_LOWEST_SHARE * untyped), untyped)
  let lift = 0
  const share = shares[0] + shares[2]
  if (share >= TYPED_LIFT_SHARES[0]) {
    const rise = smoothstep(TYPED_LIFT_SHARES[0], TYPED_LIFT_SHARES[1], share)
    const lifted = Math.min(typed, untyped) + rise * Math.max(typed - untyped, 0)
    const layer = Math.min(untyped, liftedThicknessKm(alpha))
    if (lifted > layer) {
      top = lifted
      lift = lifted - layer
    }
  }
  return { topKm: untyped * (1 - confidence) + top * confidence, liftKm: confidence * lift, typed: true }
}

/** The tops' texel (R, G, B, 0..1) for typedTops(), as the blend's 8-bit
 * target rounds it. */
export function typedTopsTexel(
  shares: TypeShares,
  confidence: number,
  alpha: number,
  r: number,
  trust: number
): [top: number, lift: number, typed: number] {
  const t = typedTops(shares, confidence, alpha, r, trust)
  const byte = (km: number) => Math.round((255 * km) / TYPED_TOPS_KM) / 255
  return [byte(t.topKm), byte(t.liftKm), t.typed ? 1 : 0]
}

/**
 * The typed march's column (renderers/cloudShaders.ts cloudColumn() under
 * CLOUD_TYPED) for a map texel and its tops' texel `tops` (typedTopsTexel(),
 * or a mix of texels, filtered): the top read, mixed toward the untyped one
 * by how far the texel is untyped, no taller than the map's tallest
 * (maxTopKm()), and the base lifted by the lift read, never over the top.
 * ground is where the untyped base stands, the clearance over the ground.
 * Untyped (B 0), cloudColumn() exactly, whatever R and G hold.
 */
export function typedColumn(
  alpha: number,
  r: number,
  coverage: number,
  measured: boolean,
  tops: readonly [top: number, lift: number, typed: number],
  terrainGrey: number,
  displacement: number
): { ground: number; base: number; top: number } {
  const topKm = cloudTopKm(r, coverage, alpha, measured ? 1 : 0)
  const untyped = cloudColumn(alpha, topKm, terrainGrey, displacement)
  const ground = untyped.base
  const [t, g, w] = tops
  if (!(w > 0)) return { ground, base: ground, top: untyped.top }
  const top = Math.min(topKm * cloudShape(alpha) * (1 - w) + t * TYPED_TOPS_KM * w, maxTopKm(measured))
  const lift = Math.min(w * g * TYPED_TOPS_KM, top)
  return { ground, base: ground + CLOUD_UNITS_PER_KM * lift, top: ground + CLOUD_UNITS_PER_KM * top }
}
