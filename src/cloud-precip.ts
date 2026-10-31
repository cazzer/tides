// Where it rains and snows under the real-weather clouds (tides-bl3.1): the
// cover grid's hourly rain, showers and snowfall (./forecast-clouds.ts) as a
// small per-frame "precipitation grid", built and blended exactly as the type
// grid is (./cloud-types.ts, renderers/cloudBlend.ts).
//
// The grid is TYPE_W x TYPE_H RGBA8, bottom row first like a CloudImage: R
// rain, G showers, B snow (as its water), each encodePrecip of mm/h, and A
// whether the frame's time is covered (255) or not (0). The rates are thus
// premultiplied by A, as the type grid's shares are by confidence: blended
// by TYPE_FRAGMENT_SHADER (mix, texel for texel, a frame without a grid as 0)
// a covered frame's rates hold against an uncovered one instead of being
// pulled towards dry, and RGB / A gives them back. A of 0 is no data: dry.
// Frames, and texels within a frame, mix in the square-root encoding, not
// in mm/h, so a rate between two reads low: 0 and 20 mm/h at half way give
// 5, not 10.
// Pure; the build is renderers/cloudPipeline.ts.
//
// And how it shows (tides-bl3.2): a raining or snowing layer is drawn a
// little darker, its base seen from under it more than its top from above
// (precipWetness, precipDarkening; the typed shell's cloudWet(),
// renderers/cloudTypeGlsl.ts). Rain darkens the low and mid cloud (stratus
// and alto), showers the cumulus, snow all but cirrus. Dry, or untyped, the
// clouds are exactly as before.
import { precipitationAt, sampleCoverSmooth, type CoverGrid, type CoverPrecip, type PrecipRate } from './forecast-clouds'
import { smoothstep } from './real-clouds'
import { TYPE_H, TYPE_W, typeTexelLat, typeTexelLon } from './cloud-types'

/** The heaviest rate a byte holds (mm/h); heavier is clamped to it. */
export const PRECIP_MAX_MM_H = 20

/** A rate (mm/h) as a byte: square root, so drizzle keeps its steps. */
export function encodePrecip(mmH: number): number {
  const r = Math.min(PRECIP_MAX_MM_H, Math.max(0, mmH)) / PRECIP_MAX_MM_H
  return Math.round(255 * Math.sqrt(r))
}

/** A byte as 0..1 (texture-sampled, or a blend of bytes) back to mm/h. */
export function decodePrecip(byte01: number): number {
  return PRECIP_MAX_MM_H * byte01 * byte01
}

/**
 * The precipitation grid for a frame, or null when the grid has none.
 * timeOfLon says when the frame shows each longitude, as for typeGridImage;
 * columns whose time the grid doesn't cover are all 0 (no data). The rates
 * are resampled at the texel centres with smoothstep-weighted bilinear.
 */
export function precipGridImage(
  grid: CoverGrid,
  timeOfLon: (lonDeg: number) => number
): Uint8Array<ArrayBuffer> | null {
  if (!grid.precip) return null
  const out = new Uint8Array(TYPE_W * TYPE_H * 4)
  // Usually one time for every column.
  const atTime = new Map<number, CoverPrecip | null>()
  for (let x = 0; x < TYPE_W; x++) {
    const lon = typeTexelLon(x)
    const t = timeOfLon(lon)
    let precip = atTime.get(t)
    if (precip === undefined) {
      precip = precipitationAt(grid, t)
      atTime.set(t, precip)
    }
    if (!precip) continue
    for (let y = 0; y < TYPE_H; y++) {
      const lat = typeTexelLat(y)
      const i = (y * TYPE_W + x) * 4
      out[i] = encodePrecip(sampleCoverSmooth(precip.rain, lat, lon))
      out[i + 1] = encodePrecip(sampleCoverSmooth(precip.showers, lat, lon))
      out[i + 2] = encodePrecip(sampleCoverSmooth(precip.snow, lat, lon))
      out[i + 3] = 255
    }
  }
  return out
}

/** Where a point falls between the grids' texel centres, as a LinearFilter
 * samples them: wrapping across 180°, clamped at the poles. Reused by every
 * call (precipFromFrames is called often), so nothing is allocated. */
const corner = { i00: 0, i10: 0, i01: 0, i11: 0, w00: 0, w10: 0, w01: 0, w11: 0 }

function placeCorners(latDeg: number, lonDeg: number) {
  const fx = (((((lonDeg + 180) / 360) * TYPE_W - 0.5) % TYPE_W) + TYPE_W) % TYPE_W
  const x0 = Math.floor(fx)
  const x1 = (x0 + 1) % TYPE_W
  const wx = fx - x0
  const fy = Math.min(TYPE_H - 1, Math.max(0, ((latDeg + 90) / 180) * TYPE_H - 0.5))
  const y0 = Math.min(TYPE_H - 2, Math.floor(fy))
  const wy = fy - y0
  corner.i00 = (y0 * TYPE_W + x0) * 4
  corner.i10 = (y0 * TYPE_W + x1) * 4
  corner.i01 = ((y0 + 1) * TYPE_W + x0) * 4
  corner.i11 = ((y0 + 1) * TYPE_W + x1) * 4
  corner.w00 = (1 - wx) * (1 - wy)
  corner.w10 = wx * (1 - wy)
  corner.w01 = (1 - wx) * wy
  corner.w11 = wx * wy
}

/** One channel of a grid (0..1) at the placed point. */
function channelAt(grid: Uint8Array, c: number): number {
  const { i00, i10, i01, i11, w00, w10, w01, w11 } = corner
  return (grid[i00 + c] * w00 + grid[i10 + c] * w10 + grid[i01 + c] * w01 + grid[i11 + c] * w11) / 255
}

/** Channel c of a and b, mix of the way from a to b; a missing grid is 0. */
function mixedAt(a: Uint8Array | null, b: Uint8Array | null, mix: number, c: number): number {
  return (a ? (1 - mix) * channelAt(a, c) : 0) + (b ? mix * channelAt(b, c) : 0)
}

/**
 * The precipitation at a point between two frames' grids, mix of the way from
 * a to b: the CPU's copy of the GPU's mix of the two frames (a frame without
 * a grid counts as all 0). Null where neither has data there. It copies only
 * that mix: not the blender's fade from its frozen output for FADE_MS after
 * a swap (renderers/cloudBlend.ts), nor the rounding of the blended grid to
 * 8 bits.
 */
export function precipFromFrames(
  a: Uint8Array | null,
  b: Uint8Array | null,
  mix: number,
  latDeg: number,
  lonDeg: number
): PrecipRate | null {
  if (!a && !b) return null
  placeCorners(latDeg, lonDeg)
  const alpha = mixedAt(a, b, mix, 3)
  if (!(alpha > 0)) return null
  return {
    rain: decodePrecip(mixedAt(a, b, mix, 0) / alpha),
    showers: decodePrecip(mixedAt(a, b, mix, 1) / alpha),
    snow: decodePrecip(mixedAt(a, b, mix, 2) / alpha),
  }
}

/** The rate (mm/h) by which a wet layer is at least PRECIP_DARK_LIGHT dark:
 * light rain or snow already reads (tides-bl3.6). On the 10° grid's smoothed
 * rates 0.1 mm/h is light, steady rain (at one hour 80% of the cloud was
 * under it). */
export const PRECIP_DARK_ON_MM_H = 0.1
/** The rate by which it is as dark as it gets, PRECIP_DARK_HEAVY: a heavy
 * front on the grid (1.4% of the cloud over 1 mm/h, the peak ~3-8). */
export const PRECIP_DARK_HEAVY_MM_H = 3
/** How much of its light a raining or snowing base loses, seen from under
 * it: at light rates, and at heavy ones, with the rate between (in the
 * square-root encoding). The display's tone curve shrinks a cut, the more
 * the brighter the base: under the deck halving the light read 8-19% darker
 * on screen (tides-bl3.6), so the light end is 0.4 (about 13% on screen; the
 * first cut's 0.5 was its full rate's, and read 1-6%) and the heavy 0.85
 * (about 30% under the day's heaviest rain, 8 mm/h). */
export const PRECIP_DARK_LIGHT = 0.4
export const PRECIP_DARK_HEAVY = 0.85
/** A top seen from above loses this share of what its base does: the sun
 * still lights it, as satellite images keep wet tops bright. */
export const PRECIP_DARK_TOP_SHARE = 0.3
/** The depth down its column (0 a top, 1 a base) by which a hit counts as
 * a base seen from below: from under the deck the march shades a base from
 * along its path through the sides and veils, so it reads 0.3-0.8. */
export const PRECIP_DARK_BELOW_DEPTH = 0.35

const encoded = (mmH: number) => Math.sqrt(mmH / PRECIP_MAX_MM_H)

/** How dark a rate makes a layer's base, 0 dry, from its encoded byte as
 * 0..1 (sqrt(rate / PRECIP_MAX_MM_H)): up to PRECIP_DARK_LIGHT by
 * PRECIP_DARK_ON_MM_H, then on to PRECIP_DARK_HEAVY by PRECIP_DARK_HEAVY_MM_H. */
export function precipDarkOf(e: number): number {
  const on = encoded(PRECIP_DARK_ON_MM_H)
  return smoothstep(0, on, e) * (PRECIP_DARK_LIGHT + (PRECIP_DARK_HEAVY - PRECIP_DARK_LIGHT) * smoothstep(on, encoded(PRECIP_DARK_HEAVY_MM_H), e))
}

/** How dark a wet column is: through its typed layers as seen from above
 * (`layered`: rain on the low and mid cloud, showers on the cumulus, snow on
 * all but cirrus), and whatever caps it as seen from under it (`below`: a
 * raining base is dark under any cirrus over it). */
export interface PrecipWetness {
  layered: number
  below: number
}

/**
 * The CPU's copy of the typed shell's cloudWet() times the type texel's
 * confidence. texel is the blended precipitation texel as sampled (RGBA
 * 0..1, RGB premultiplied by A), shares the column's cirrus, cumulus, alto
 * and stratus. Both 0 exactly where dry or there is no data.
 */
export function precipWetness(
  texel: readonly [number, number, number, number],
  shares: readonly [number, number, number, number],
  confidence: number
): PrecipWetness {
  const a = texel[3]
  if (!(a > 0)) return { layered: 0, below: 0 }
  const [rain, showers, snow] = [0, 1, 2].map((i) => precipDarkOf(Math.min(texel[i] / a, 1)))
  const [cirrus, cumulus, alto, stratus] = shares
  const k = confidence * a
  return {
    layered: k * Math.max(rain * (alto + stratus), showers * cumulus, snow * (1 - cirrus)),
    below: k * Math.max(rain, showers, snow),
  }
}

/** What a hit's light is multiplied by for a column's wetness at depth
 * (0 the top seen from above, 1 the base from under it). */
export function precipDarkening(wet: PrecipWetness, depth: number): number {
  const b = smoothstep(0, PRECIP_DARK_BELOW_DEPTH, depth)
  return 1 - (wet.layered * PRECIP_DARK_TOP_SHARE * (1 - b) + wet.below * b)
}
