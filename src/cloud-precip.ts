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
// Pure; the build is renderers/cloudPipeline.ts.
import { precipitationAt, sampleCoverSmooth, type CoverGrid, type CoverPrecip, type PrecipRate } from './forecast-clouds'
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

/** A grid's RGBA (0..1) at a point, bilinear between texel centres as a
 * LinearFilter samples it: wrapping across 180°, clamped at the poles. */
function sampleGrid(grid: Uint8Array, latDeg: number, lonDeg: number): [number, number, number, number] {
  const fx = (((lonDeg + 180) / 360) * TYPE_W - 0.5 + TYPE_W) % TYPE_W
  const x0 = Math.floor(fx)
  const x1 = (x0 + 1) % TYPE_W
  const wx = fx - x0
  const fy = Math.min(TYPE_H - 1, Math.max(0, ((latDeg + 90) / 180) * TYPE_H - 0.5))
  const y0 = Math.min(TYPE_H - 2, Math.floor(fy))
  const y1 = y0 + 1
  const wy = fy - y0
  const out: [number, number, number, number] = [0, 0, 0, 0]
  for (let c = 0; c < 4; c++) {
    const at = (x: number, y: number) => grid[(y * TYPE_W + x) * 4 + c] / 255
    const bottom = at(x0, y0) * (1 - wx) + at(x1, y0) * wx
    const top = at(x0, y1) * (1 - wx) + at(x1, y1) * wx
    out[c] = bottom * (1 - wy) + top * wy
  }
  return out
}

/**
 * The precipitation at a point between two frames' grids, mix of the way from
 * a to b: the CPU's copy of the GPU blend (a frame without a grid counts as
 * all 0). Null where neither has data there.
 */
export function precipFromFrames(
  a: Uint8Array | null,
  b: Uint8Array | null,
  mix: number,
  latDeg: number,
  lonDeg: number
): PrecipRate | null {
  const none = [0, 0, 0, 0]
  const sa = a ? sampleGrid(a, latDeg, lonDeg) : none
  const sb = b ? sampleGrid(b, latDeg, lonDeg) : none
  const [r, g, bl, alpha] = sa.map((v, c) => (1 - mix) * v + mix * sb[c])
  if (!(alpha > 0)) return null
  return { rain: decodePrecip(r / alpha), showers: decodePrecip(g / alpha), snow: decodePrecip(bl / alpha) }
}
