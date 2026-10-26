// Earth's horizon map (tides-zmw.4): how high the terrain stands around each
// point, in a few compass directions, baked offline from the elevation map
// (./earth-dem.ts) by scripts/build-earth-horizon.mjs. The ground's shader
// (renderers/groundShadow.ts) reads it for the Sun's shadow (is the Sun above
// the horizon toward it?) and for sky occlusion (how much of the sky a
// valley sees). Pure, so the build, the tests and the renderer share it;
// sunAzimuth(), sunVisibility() and skyVisibility() mirror the shader's
// maths.
//
// Each angle is the highest elevation, above the local horizontal, of the
// ground within HORIZON_RADIUS_KM along a great circle, at the relief's
// exaggeration eRef (displacement scale over sea-level radius, scene units),
// over the curved Earth: ground an arc γ away sits γ/2 lower in tangent, up
// to 1.35° at 300 km, which would otherwise raise a horizon over most plains
// and darken them ahead of the sea at dusk. Angles are rounded down, so
// ground that rises less than a step reads as flat.
//
// The shader takes the map to its own exaggeration by scaling the tangent
// (horizonTangentScale()). Without curvature that is exact (the steepest
// sightline is the same one at any exaggeration); with it, the curvature
// term γ/2 is scaled too, so away from eRef the map's curvature is off by
// (k − 1)·γ/2 and its steepest sightline may be another. Exact at the
// exaggeration the ground is drawn at (k = 1).
//
// Two maps ship, both encoded at HORIZON_BAKE_RELIEF (their eRef, the gain
// that spends the bits), which differ only in the exaggeration their
// curvature is exact at (eCurve): earth-horizon-1k.bin at 12x and
// earth-horizon-1k-true.bin at true scale (tides-zmw.21). The 12x map read
// at 1x stood far horizons too high by up to (1 − 1/12)·γ/2, 1.24° at
// 300 km (p50 0.12°, p99 0.49°, max 1.09° over the map), where true-scale
// horizons are themselves ~0.5° (p90): twice as many shadowing texels as
// there should be. The format holds each direction's steepest angle but not
// how far off it stood, so the shader can't take the curvature out again,
// and the steepest sightline moves with the exaggeration besides (nearer
// ridges win at 1x). A page takes the map nearer its relief
// (horizonCurveRelief()); only that one is fetched.
//
// A file is gzip over: the magic "EHZ1", width and height (uint16, little
// endian), the number of directions and bits per angle (uint8), eRef
// (float32), then one plane per direction of one byte per texel (rows north
// first, columns from −180° east, as the DEM): the angle, 0 to 90° in
// 2^bits − 1 even steps. Direction d points 360° · d / directions clockwise
// from north, so the second points north-east.

import { EARTH_RADIUS_KM, type Vec3 } from './cloud-layer'
import { gunzip, type DemLevel } from './earth-dem'
import { RELIEF } from './relief'

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

/** The relief (./relief.ts) the shipped maps' angles are encoded at: eRef
 * is this relief's displacement over the sea-level radius (6 bits over 0 to
 * 90° at 12x is ~0.12° at 1x). Decoupled from DEFAULT_RELIEF, so a new
 * default needs no new encoding. */
export const HORIZON_BAKE_RELIEF = 12
/** The reliefs the shipped maps' curvature is exact at (their eCurve):
 * earth-horizon-1k.bin's and earth-horizon-1k-true.bin's. */
export const HORIZON_CURVE_RELIEF = 12
export const HORIZON_TRUE_CURVE_RELIEF = 1

/**
 * The relief whose map (HORIZON_CURVE_RELIEF's or HORIZON_TRUE_CURVE_RELIEF's)
 * a ground drawn at `relief` reads. Read at relief d, a map exact at c
 * misplaces a far horizon by γ/2 · |d/c − 1|: the two are even at their
 * harmonic mean (~1.85x), true scale's map below it.
 */
export function horizonCurveRelief(relief: number): number {
  const even = 2 / (1 / HORIZON_CURVE_RELIEF + 1 / HORIZON_TRUE_CURVE_RELIEF)
  return relief < even ? HORIZON_TRUE_CURVE_RELIEF : HORIZON_CURVE_RELIEF
}

/** The relief the 2° edge was tuned at, and its value there and at 1x. */
const SOFTNESS_RELIEF = 12
const SOFTNESS_12 = (2 * Math.PI) / 180
const SOFTNESS_1 = (0.5 * Math.PI) / 180

/**
 * Half the width of the Sun's soft shadow edge, in elevation (radians), for
 * ground drawn at `relief`: 2° at 12x and above, as tuned there (tides-zmw.4),
 * down to 0.5° at true scale (tides-zmw.21), linear in the relief between.
 * Most true-scale horizons are under 2°, so the 12x edge (which also ramps
 * a horizon's shadow in over its own width) left them weak and mushy. The
 * map's blur, in angle, scales with the tangents; the Sun's half-width
 * (0.27°) doesn't, hence the floor.
 */
export function horizonSoftness(relief: number): number {
  const r = Math.min(relief, SOFTNESS_RELIEF)
  return SOFTNESS_12 + ((SOFTNESS_12 - SOFTNESS_1) * (r - SOFTNESS_RELIEF)) / (SOFTNESS_RELIEF - 1)
}

/** This page's soft edge: horizonSoftness(RELIEF), 2° at the default. */
export const HORIZON_SOFTNESS = horizonSoftness(RELIEF)
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
  /** False bakes over a flat Earth (the tangent transform is then exact). */
  curvature?: boolean
  /** The exaggeration the curvature drop is exact at (eRef if absent): the
   * drop is baked as γ/2 · eRef / eCurve, so the shader's tangent scale
   * (horizonTangentScale(), eDrawn / eRef) takes it to γ/2 exactly where the
   * ground is drawn at eCurve. */
  eCurve?: number
}

/**
 * Bakes `level` (heights in displacement units, rows north first, columns
 * wrapping at 180°) into a horizon map of its own size. For each texel, each
 * direction's great circle is sampled (bilinear) at `steps` geometric
 * distances from `firstKm` to `radiusKm`; the steepest rise over the
 * Earth's curve is the angle, rounded down to a step.
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
    curvature = true,
    eCurve = eRef,
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
        const drop = curvature ? (arc / 2) * (eRef / eCurve) : 0
        const w00 = (1 - tx) * (1 - ty)
        const w01 = tx * (1 - ty)
        const w10 = (1 - tx) * ty
        const w11 = tx * ty
        for (let i = 0; i < W; i++) {
          const x0 = (((i + bx) % W) + W) % W
          const x1 = x0 + 1 === W ? 0 : x0 + 1
          const h = w00 * r0[x0] + w01 * r0[x1] + w10 * r1[x0] + w11 * r1[x1]
          const rise = (h - row[i]) * scale - drop
          if (rise > best[i]) best[i] = rise
        }
      }
      const plane = d * W * H + j * W
      for (let i = 0; i < W; i++) angles[plane + i] = Math.floor((Math.atan(best[i]) / (Math.PI / 2)) * top)
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

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(...a)
  return [a[0] / l, a[1] / l, a[2] / l]
}

/**
 * The Sun's azimuth, radians clockwise from north (0 to 2π), at the ground
 * point `up` (a unit vector), both in the ground mesh's frame (north +Y), by
 * the shader's steps: east is +Y × up, north up × east. Overhead, where it
 * has none, 0.
 */
export function sunAzimuth(sun: Vec3, up: Vec3): number {
  const east = normalize(cross([0, 1, 0], up))
  const x = dot(sun, east)
  const y = dot(sun, cross(up, east))
  if (x * x + y * y <= 1e-12) return 0
  const azimuth = Math.atan2(x, y)
  return azimuth < 0 ? azimuth + 2 * Math.PI : azimuth
}

/**
 * The share of the Sun's light reaching the ground (the shader's): the
 * horizon toward the Sun's azimuth (radians clockwise from north),
 * interpolated between the directions either side, against its elevation
 * (radians), over a soft edge HORIZON_SOFTNESS either side. A horizon of a
 * step (`bits`' quantum) or less never shadows, and one starts to only over
 * the next HORIZON_SOFTNESS, so flat ground and ground rising under a step
 * keep their light to the terminator, as the sea does.
 */
export function sunVisibility(
  angles: ArrayLike<number>,
  k: number,
  azimuth: number,
  elevation: number,
  bits = HORIZON_BITS
): number {
  const n = angles.length
  const bin = ((((azimuth / (2 * Math.PI)) * n) % n) + n) % n
  const i0 = Math.floor(bin) % n
  const t = bin - Math.floor(bin)
  const horizon = scaledAngle(angles[i0] * (1 - t) + angles[(i0 + 1) % n] * t, k)
  const w = HORIZON_SOFTNESS
  const lit = smoothstep(horizon - w, horizon + w, elevation)
  const quantum = k * horizonAngle(1, bits)
  return 1 + (lit - 1) * smoothstep(quantum, quantum + w, horizon)
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
