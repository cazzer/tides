// Earth's horizon map (tides-zmw.4): how high the terrain stands around each
// point, in a few compass directions, baked offline from the elevation map
// (./earth-dem.ts) by scripts/build-earth-horizon.mjs. The ground's shader
// (renderers/groundShadow.ts) reads it for the Sun's shadow (is the Sun above
// the horizon toward it?) and for sky occlusion (how much of the sky a
// valley sees). Pure, so the build, the tests and the renderer share it;
// sunVisibility() and skyVisibility() mirror the shader's maths.
//
// Each angle is the highest elevation, above the local horizontal, of the
// ground within HORIZON_RADIUS_KM along a great circle, at the relief's
// exaggeration eRef (displacement scale over sea-level radius, scene units).
// Ignoring the Earth's curvature, tan(angle) is proportional to the
// exaggeration (the steepest sightline is the same one at any), so the shader
// takes the map to its own exaggeration by scaling the tangent (horizonTangentScale()).
//
// A file is gzip over: the magic "EHZ1", width and height (uint16, little
// endian), the number of directions and bits per angle (uint8), eRef
// (float32), then one plane per direction of one byte per texel (rows north
// first, columns from −180° east, as the DEM): the angle, 0 to 90° in
// 2^bits − 1 even steps. Direction d points 360° · d / directions clockwise
// from north, so the second points north-east.

import { EARTH_RADIUS_KM } from './cloud-layer'
import { gunzip, type DemLevel } from './earth-dem'

const MAGIC = 'EHZ1'
const HEADER_BYTES = 14

/** The shipped map's shape and search (the build's and the tests' defaults). */
export const HORIZON_WIDTH = 1024
export const HORIZON_DIRECTIONS = 8
export const HORIZON_BITS = 6
/** How far the bake looks for higher ground, and its first, shortest step. */
export const HORIZON_RADIUS_KM = 300
export const HORIZON_FIRST_KM = 19.5
export const HORIZON_STEPS = 16

/** Half the width of the Sun's soft shadow edge, in elevation (radians): 2°. */
export const HORIZON_SOFTNESS = (2 * Math.PI) / 180
/** The steepest horizon the shader will take a tangent of (just under 90°). */
export const HORIZON_MAX_ANGLE = 1.56

export interface EarthHorizon {
  width: number
  height: number
  directions: number
  bits: number
  /** The exaggeration the angles are at: displacement scale / sea-level radius. */
  eRef: number
  /** Quantised angles, one plane of width × height per direction. */
  angles: Uint8Array
}

export interface HorizonBakeOptions {
  directions?: number
  bits?: number
  radiusKm?: number
  firstKm?: number
  steps?: number
  eRef: number
}

/**
 * Bakes `level` (heights in displacement units, rows north first, columns
 * wrapping at 180°) into a horizon map of its own size. For each texel, each
 * direction's great circle is sampled (bilinear) at `steps` geometric
 * distances from `firstKm` to `radiusKm`; the steepest rise is the angle.
 * Every texel of a row shares its great circles' offsets, so those are
 * worked out once a row; a circle that passes over a pole comes down the far
 * meridian, as it should.
 */
export function bakeHorizon(level: DemLevel, options: HorizonBakeOptions): EarthHorizon {
  const {
    directions = HORIZON_DIRECTIONS,
    bits = HORIZON_BITS,
    radiusKm = HORIZON_RADIUS_KM,
    firstKm = HORIZON_FIRST_KM,
    steps = HORIZON_STEPS,
    eRef,
  } = options
  const { width: W, height: H, data } = level
  const top = (1 << bits) - 1
  const angles = new Uint8Array(directions * W * H)
  const arcs = Array.from(
    { length: steps },
    (_, s) => (firstKm * (radiusKm / firstKm) ** (steps > 1 ? s / (steps - 1) : 0)) / EARTH_RADIUS_KM
  )
  const best = new Float64Array(W)
  for (let j = 0; j < H; j++) {
    const lat = Math.PI / 2 - ((j + 0.5) / H) * Math.PI
    const sinLat = Math.sin(lat)
    const cosLat = Math.cos(lat)
    const row = data.subarray(j * W, (j + 1) * W)
    for (let d = 0; d < directions; d++) {
      const azimuth = (2 * Math.PI * d) / directions
      best.fill(0)
      for (const arc of arcs) {
        const sinLat2 = sinLat * Math.cos(arc) + cosLat * Math.sin(arc) * Math.cos(azimuth)
        const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)))
        const dLon = Math.atan2(Math.sin(azimuth) * Math.sin(arc) * cosLat, Math.cos(arc) - sinLat * sinLat2)
        const fy = Math.min(H - 1, Math.max(0, ((Math.PI / 2 - lat2) / Math.PI) * H - 0.5))
        const y0 = Math.floor(fy)
        const y1 = Math.min(H - 1, y0 + 1)
        const ty = fy - y0
        const dx = (dLon / (2 * Math.PI)) * W
        const bx = Math.floor(dx)
        const tx = dx - bx
        const r0 = data.subarray(y0 * W, (y0 + 1) * W)
        const r1 = data.subarray(y1 * W, (y1 + 1) * W)
        const scale = eRef / arc
        const w00 = (1 - tx) * (1 - ty)
        const w01 = tx * (1 - ty)
        const w10 = (1 - tx) * ty
        const w11 = tx * ty
        for (let i = 0; i < W; i++) {
          const x0 = (((i + bx) % W) + W) % W
          const x1 = x0 + 1 === W ? 0 : x0 + 1
          const h = w00 * r0[x0] + w01 * r0[x1] + w10 * r1[x0] + w11 * r1[x1]
          const rise = (h - row[i]) * scale
          if (rise > best[i]) best[i] = rise
        }
      }
      const plane = d * W * H + j * W
      for (let i = 0; i < W; i++) angles[plane + i] = Math.round((Math.atan(best[i]) / (Math.PI / 2)) * top)
    }
  }
  return { width: W, height: H, directions, bits, eRef, angles }
}

/** The uncompressed file body; the build gzips it. */
export function packEarthHorizon({ width, height, directions, bits, eRef, angles }: EarthHorizon): Uint8Array {
  if (angles.length !== width * height * directions) {
    throw new Error(`Horizon ${width}×${height}×${directions} holds ${angles.length} angles`)
  }
  const out = new Uint8Array(HEADER_BYTES + angles.length)
  for (let k = 0; k < 4; k++) out[k] = MAGIC.charCodeAt(k)
  const view = new DataView(out.buffer)
  view.setUint16(4, width, true)
  view.setUint16(6, height, true)
  view.setUint8(8, directions)
  view.setUint8(9, bits)
  view.setFloat32(10, eRef, true)
  out.set(angles, HEADER_BYTES)
  return out
}

/** packEarthHorizon's inverse. Throws on a body that isn't one. */
export function unpackEarthHorizon(body: Uint8Array): EarthHorizon {
  const magic = String.fromCharCode(...body.subarray(0, 4))
  if (body.length < HEADER_BYTES || magic !== MAGIC) throw new Error('Not an Earth horizon map')
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const width = view.getUint16(4, true)
  const height = view.getUint16(6, true)
  const directions = view.getUint8(8)
  const bits = view.getUint8(9)
  const eRef = view.getFloat32(10, true)
  const n = width * height * directions
  if (body.length !== HEADER_BYTES + n) {
    throw new Error(`Earth horizon ${width}×${height}×${directions}: ${body.length} bytes, expected ${HEADER_BYTES + n}`)
  }
  return { width, height, directions, bits, eRef, angles: body.slice(HEADER_BYTES) }
}

/** A shipped horizon file, gzip and all. */
export async function decodeEarthHorizon(file: ArrayBuffer | Uint8Array): Promise<EarthHorizon> {
  return unpackEarthHorizon(await gunzip(file instanceof Uint8Array ? file : new Uint8Array(file)))
}

/** A quantised angle in radians. */
export function horizonAngle(level: number, bits: number): number {
  return (level / ((1 << bits) - 1)) * (Math.PI / 2)
}

/** Every direction's angle (radians, at the map's eRef) at texel x, y. */
export function horizonAt(map: EarthHorizon, x: number, y: number): number[] {
  const n = map.width * map.height
  return Array.from({ length: map.directions }, (_, d) => horizonAngle(map.angles[d * n + y * map.width + x], map.bits))
}

/** What the shader multiplies a stored tangent by for ground drawn at
 * `displacementScale` over a sea-level sphere of `radius`. */
export function horizonTangentScale(displacementScale: number, radius: number, eRef: number): number {
  return displacementScale / radius / eRef
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** A stored angle taken to the tangent scale k. */
function scaledAngle(angle: number, k: number): number {
  return Math.atan(k * Math.tan(Math.min(angle, HORIZON_MAX_ANGLE)))
}

/**
 * The share of the Sun's light reaching the ground (the shader's): the
 * horizon toward the Sun's azimuth (radians clockwise from north),
 * interpolated between the directions either side, against its elevation
 * (radians), over a soft edge HORIZON_SOFTNESS either side. Where the horizon
 * is flat the Sun is never shadowed, so the terminator stays where it was.
 */
export function sunVisibility(angles: ArrayLike<number>, k: number, azimuth: number, elevation: number): number {
  const n = angles.length
  const bin = ((((azimuth / (2 * Math.PI)) * n) % n) + n) % n
  const i0 = Math.floor(bin) % n
  const t = bin - Math.floor(bin)
  const horizon = scaledAngle(angles[i0] * (1 - t) + angles[(i0 + 1) % n] * t, k)
  const w = HORIZON_SOFTNESS
  const lit = smoothstep(horizon - w, horizon + w, elevation)
  return 1 + (lit - 1) * smoothstep(0, w, horizon)
}

/**
 * The share of a uniform, cosine-weighted sky the ground sees past its
 * horizons (the shader's, before its HORIZON_SKY_POWER): over each
 * direction's sector, cos² of the horizon angle.
 */
export function skyVisibility(angles: ArrayLike<number>, k: number): number {
  let sum = 0
  for (let d = 0; d < angles.length; d++) {
    const t = k * Math.tan(Math.min(angles[d], HORIZON_MAX_ANGLE))
    sum += 1 / (1 + t * t)
  }
  return sum / angles.length
}
