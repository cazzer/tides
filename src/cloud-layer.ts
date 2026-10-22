// The cloud layer's geometry (tides-y2e): where the clouds sit above the
// ground, how high their tops reach, and where a sunbeam meets them. The GLSL
// in renderers/cloudShaders.ts mirrors these functions; keep them in step.
//
// Altitudes are scene units above the sea-level sphere, in the Earth's local
// frame (the cloud and ground meshes share it). The scene is compressed, so
// heights are exaggerated: terrain by the bump map's displacement scale, cloud
// tops by CLOUD_UNITS_PER_KM. Lighting (sunset colour, the horizon dip) uses
// true kilometres instead, since those effects don't scale with the scene.
import { MAX_CLOUD_TOP_KM } from './geo-clouds'

export { MAX_CLOUD_TOP_KM }

export const EARTH_RADIUS_KM = 6371

/** The ground's displacementScale: scene units at bump-map white. */
export const TERRAIN_DISPLACEMENT = 0.075
/** The brightest grey (Himalaya) of the bump map the relief layer reads,
 * earth-bump.jpg (4k, high quality); bounds the cloud layer. */
export const TERRAIN_MAX_GREY = 219 / 255
/** The same for the flat layer's map, earth-bump-2k.jpg (low quality), whose
 * smaller size averages the peaks down. */
export const TERRAIN_MAX_GREY_FLAT = 206 / 255
/** Kilometres of elevation per unit of bump-map grey (geo-clouds' 1/39 per level). */
export const TERRAIN_KM_PER_GREY = 255 / 39

/** Gap between the (smoothed) ground and a cloud's base. */
export const CLOUD_CLEARANCE = 0.006
/** Cloud-top exaggeration: about 9x the true scale (terrain is about 25x). */
export const CLOUD_UNITS_PER_KM = 0.004
/** Lowest top a measured cloud gets; daytime low cloud reads ~0 from IR. */
export const MIN_MEASURED_TOP_KM = 1

/** Highest a cloud top can reach: the outer bound of the relief march. */
export const CLOUD_LAYER_TOP =
  TERRAIN_DISPLACEMENT * TERRAIN_MAX_GREY + CLOUD_CLEARANCE + CLOUD_UNITS_PER_KM * MAX_CLOUD_TOP_KM

/** The low-quality path's single flat shell: just clear of the highest
 * ground (tides-7oi), at a typical low-cloud top. */
export const CLOUD_FLAT_ALTITUDE =
  TERRAIN_DISPLACEMENT * TERRAIN_MAX_GREY_FLAT + CLOUD_CLEARANCE + CLOUD_UNITS_PER_KM * 1.5

/** Where no satellite measured a top: thicker (brighter) cloud, taller tops. */
export function defaultTopKm(alpha: number): number {
  return 1.5 + 7 * alpha * alpha
}

/** The tallest top a texture can give, which bounds the relief march. */
export function maxTopKm(measured: boolean): number {
  return measured ? MAX_CLOUD_TOP_KM : defaultTopKm(1)
}

/**
 * Cloud-top height above the ground (km) from a texel: r = measured height
 * (0..1 of MAX_CLOUD_TOP_KM), coverage = how far r can be trusted (0..1),
 * alpha = cloud opacity. measured = 0 for textures that carry no heights.
 */
export function cloudTopKm(r: number, coverage: number, alpha: number, measured: number): number {
  const trust = coverage * measured
  const fromIr = Math.max(r * MAX_CLOUD_TOP_KM, MIN_MEASURED_TOP_KM)
  return defaultTopKm(alpha) * (1 - trust) + fromIr * trust
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** How much of its height a cloud's top keeps: thin edges sit low, so a
 * cloud is a dome rather than a slab. */
export function cloudShape(alpha: number): number {
  return 0.25 + 0.75 * smoothstep(0, 0.65, alpha)
}

/** A cloud column: base and top altitudes over ground of the given bump grey. */
export function cloudColumn(
  alpha: number,
  topKm: number,
  terrainGrey: number
): { base: number; top: number } {
  const base = terrainGrey * TERRAIN_DISPLACEMENT + CLOUD_CLEARANCE
  return { base, top: base + CLOUD_UNITS_PER_KM * topKm * cloudShape(alpha) }
}

export type Vec3 = [number, number, number]

/**
 * Texture coordinates of a local direction, matching THREE.SphereGeometry:
 * u = 0.5 (Greenwich) at local +X, east toward -Z; v = 1 at the north (+Y).
 */
export function directionToUv([x, y, z]: Vec3): [number, number] {
  const u = Math.atan2(z, -x) / (2 * Math.PI)
  return [u - Math.floor(u), 0.5 + Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI]
}

/**
 * Distance along a ray from radius r0, at sine-of-elevation mu, to where it
 * reaches radius r (outward). r must be at least r0.
 */
export function distanceToRadius(r0: number, mu: number, r: number): number {
  return -r0 * mu + Math.sqrt(r0 * r0 * (mu * mu - 1) + r * r)
}

/**
 * The stretch of a view ray the cloud march covers within the ship camera's
 * reach of the shell (tides-01v.8.4; cloudShaders.ts' FLIP_SIDED branch), as
 * distances along the unit `dir` from `eye` (both in the body's frame, about
 * its centre): from `near`, the near plane's distance along the ray, or from
 * where the ray comes within `outer` of the centre if that is further, to
 * where it leaves that sphere or drops below the lowest base anywhere. Null
 * when no part of the ray past the near plane comes within `outer`.
 */
export function marchSpanFromEye(
  eye: Vec3,
  dir: Vec3,
  seaLevel: number,
  outer: number,
  near: number
): { start: number; end: number } | null {
  const b = eye[0] * dir[0] + eye[1] * dir[1] + eye[2] * dir[2]
  const eye2 = eye[0] * eye[0] + eye[1] * eye[1] + eye[2] * eye[2]
  const discOuter = b * b - (eye2 - outer * outer)
  if (discOuter <= 0) return null
  const start = Math.max(-b - Math.sqrt(discOuter), near)
  let end = -b + Math.sqrt(discOuter)
  const inner = seaLevel + CLOUD_CLEARANCE
  const discInner = b * b - (eye2 - inner * inner)
  if (discInner > 0 && -b - Math.sqrt(discInner) > start) end = -b - Math.sqrt(discInner)
  return end > start ? { start, end } : null
}

/**
 * Where a sunbeam to the ground point (unit direction `ground`, at radius r0)
 * crosses the altitude `altitude` above radius `seaLevel`: the cloud that
 * would shade the point from there. Toward the Sun, by about
 * height·tan(zenith) when the Sun is high.
 */
export function shadowCaster(
  ground: Vec3,
  sun: Vec3,
  r0: number,
  seaLevel: number,
  altitude: number
): Vec3 {
  const mu = ground[0] * sun[0] + ground[1] * sun[1] + ground[2] * sun[2]
  const t = distanceToRadius(r0, mu, seaLevel + altitude)
  const p: Vec3 = [
    ground[0] * r0 + sun[0] * t,
    ground[1] * r0 + sun[1] * t,
    ground[2] * r0 + sun[2] * t,
  ]
  const len = Math.hypot(...p)
  return [p[0] / len, p[1] / len, p[2] / len]
}

/** Sine of how far below the horizon the Sun can be and still light a cloud
 * top at heightKm (true scale). */
export function horizonDipSin(heightKm: number): number {
  const c = EARTH_RADIUS_KM / (EARTH_RADIUS_KM + Math.max(0, heightKm))
  return Math.sqrt(Math.max(0, 1 - c * c))
}

/** Kasten & Young's relative air mass at sine-of-elevation mu, held at the
 * horizon's for a Sun below it. */
export function airMass(mu: number): number {
  const zenith = Math.min(90, (Math.acos(Math.max(-1, Math.min(1, mu))) * 180) / Math.PI)
  return 1 / (Math.cos((zenith * Math.PI) / 180) + 0.50572 * (96.07995 - zenith) ** -1.6364)
}

/** Vertical optical depth (red, green, blue) at sea level: Rayleigh plus a
 * little haze, softened a touch for taste. */
export const SUNLIGHT_EXTINCTION: Vec3 = [0.045, 0.1, 0.22]
const SCALE_HEIGHT_KM = 8

/** Sunset light keeps at least this much of its red's brightness: the low
 * Sun's light on cloud still glows a little, but dimmer than noon (at 1 it
 * would be the plain extinction). */
export const SUNSET_FLOOR = 0.75

/** The lowest air a grazing sunbeam can cross: haze and low cloud below it
 * block the beam, so a cloud top loses the Sun when its beam would pass
 * closer to the ground than this (km). */
export const SUNBEAM_FLOOR_KM = 2

/** Sine of how far below the cloud top's horizon the Sun can be before its
 * beam would graze SUNBEAM_FLOOR_KM: the end of a top's sunset. */
export function sunsetDipSin(heightKm: number): number {
  return horizonDipSin(Math.max(0, heightKm) - SUNBEAM_FLOOR_KM)
}

/** How much of the Sun a cloud top sees, 0..1: all of it until just before
 * sunsetDipSin, softened over about the Sun's disc and refraction. */
export function sunVisibility(mu: number, heightKm: number): number {
  return smoothstep(-0.01, 0.01, mu + sunsetDipSin(heightKm))
}

/** The height (km) where a sunbeam to a point heightKm up passes closest to
 * the ground: the point itself while the Sun is above its horizon, lower
 * once the Sun has set there. */
export function sunbeamTangentKm(mu: number, heightKm: number): number {
  const h = Math.max(0, heightKm)
  if (mu >= 0) return h
  return (EARTH_RADIUS_KM + h) * Math.sqrt(1 - mu * mu) - EARTH_RADIUS_KM
}

/** Air masses a sunbeam to a cloud top crosses beyond the overhead Sun's
 * one: Kasten & Young's above the horizon, thinned for the top's height;
 * below it, the beam grazes the ground at sunbeamTangentKm and crosses the
 * dense air on both sides of that point, so it reddens and dims fast. */
export function sunbeamAirMass(mu: number, heightKm: number): number {
  const h = Math.max(0, heightKm)
  const thin = (km: number) => Math.exp(-Math.max(0, km) / SCALE_HEIGHT_KM)
  if (mu >= 0) return (airMass(mu) - 1) * thin(h)
  const tangent = sunbeamTangentKm(mu, h)
  return (airMass(0) - 1) * thin(tangent) * (2 - thin(h - tangent))
}

/** Sunlight's colour reaching a cloud top: white with the Sun overhead,
 * reddening toward the terminator. It keeps the colour of the extinction and
 * most of its dimming (down to SUNSET_FLOOR the red is lifted back), so the
 * terminator shows a thin, dim band of warm light rather than a bright one. */
export function sunlightTint(mu: number, heightKm: number): Vec3 {
  const m = sunbeamAirMass(mu, heightKm)
  const t = SUNLIGHT_EXTINCTION.map((tau) => Math.exp(-tau * m))
  const norm = Math.max(t[0], SUNSET_FLOOR)
  return t.map((c) => c / norm) as Vec3
}

// Fine detail where the cloud map is magnified (tides-01v.2): octaves of noise
// from DETAIL_BASE_TEXELS cloud texels down, each halving the last, each
// faded out as it shrinks toward a few screen pixels so none of it sparkles.
// From further out than the map's own resolution, no octave survives.

/** The coarsest octave's wavelength, in cloud-map texels. */
export const DETAIL_BASE_TEXELS = 2
/** An octave is whole down to 1/start pixels a wave and gone by 1/end. */
export const DETAIL_FADE_START = 1 / 6
export const DETAIL_FADE_END = 1 / 3
/** Octaves for the relief march; the low-quality flat shell takes fewer. */
export const DETAIL_OCTAVES = 6
export const DETAIL_OCTAVES_FLAT = 3

/** How much of an octave of `wavelength` shows at a pixel `footprint` wide
 * (both scene units), 0..1. */
export function detailOctaveWeight(footprint: number, wavelength: number): number {
  return 1 - smoothstep(DETAIL_FADE_START, DETAIL_FADE_END, footprint / wavelength)
}

/** The weight of each octave that shows, coarsest first, for a cloud map of
 * `texel` scene units seen at `footprint`. */
export function detailOctaveWeights(footprint: number, texel: number, octaves: number): number[] {
  const weights: number[] = []
  let wavelength = DETAIL_BASE_TEXELS * texel
  for (let k = 0; k < octaves; k++) {
    const weight = detailOctaveWeight(footprint, wavelength)
    if (weight <= 0) break
    weights.push(weight)
    wavelength /= 2
  }
  return weights
}

/** A local direction turned into the clouds' own frame for a drift of
 * `turns` (uCloudShift): directionToUv of the result is the texture
 * coordinate the cloud there was painted at. The detail noise lives here. */
export function cloudFrame([x, y, z]: Vec3, turns: number): Vec3 {
  const c = Math.cos(2 * Math.PI * turns)
  const s = Math.sin(2 * Math.PI * turns)
  return [x * c - z * s, y, z * c + x * s]
}

/** The static clouds drift east at this many radians per frame. */
export const STATIC_DRIFT_PER_FRAME = 0.0001

/** Texture-u offset of the static clouds after a drift of `radians`: the
 * cloud seen at Earth u was painted at u - offset. */
export function driftOffset(radians: number): number {
  const u = radians / (2 * Math.PI)
  return u - Math.floor(u)
}
