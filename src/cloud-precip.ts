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

/** The rate (mm/h) at which a layer is as dark as rain makes it, past which
 * a heavier rate looks the same: on the 10° grid's smoothed rates a mean of
 * 1 mm/h is a heavy front (at one hour, 80% of the cloud was under 0.1 and
 * 1.4% over 1), so the darkening shows where it rains, not only in the
 * rarest storms. */
export const PRECIP_DARK_FULL_MM_H = 1
/** How much of its light a wet layer's top loses at the full rate, seen
 * from above: slightly, as the sun still lights it. */
export const PRECIP_DARK_TOP = 0.1
/** And its base, seen from under it: more, as a rain cloud's base is dark,
 * but still slight (the deck's base reads about 8% darker under a heavy
 * front, where 0.3 gave a barely visible 5%). */
export const PRECIP_DARK_BASE = 0.5

/** The rate ramp in the encoded space: e = sqrt(rate / PRECIP_MAX_MM_H). */
const PRECIP_DARK_FULL = Math.sqrt(PRECIP_DARK_FULL_MM_H / PRECIP_MAX_MM_H)

/**
 * How wet a column is, 0..1: the CPU's copy of the typed shell's cloudWet()
 * times the type texel's confidence. texel is the blended precipitation
 * texel as sampled (RGBA 0..1, RGB premultiplied by A), shares the column's
 * cirrus, cumulus, alto and stratus. 0 exactly where dry or there is no data.
 */
export function precipWetness(
  texel: readonly [number, number, number, number],
  shares: readonly [number, number, number, number],
  confidence: number
): number {
  const a = texel[3]
  if (!(a > 0)) return 0
  const ramp = (c: number) => smoothstep(0, PRECIP_DARK_FULL, Math.min(c / a, 1))
  const [cirrus, cumulus, alto, stratus] = shares
  return confidence * a * Math.max(ramp(texel[0]) * (alto + stratus), ramp(texel[1]) * cumulus, ramp(texel[2]) * (1 - cirrus))
}

/** What a hit's light is multiplied by at wetness wet and depth (0 the top
 * seen from above, 1 the base from under it). */
export function precipDarkening(wet: number, depth: number): number {
  return 1 - wet * (PRECIP_DARK_TOP + (PRECIP_DARK_BASE - PRECIP_DARK_TOP) * depth)
}
