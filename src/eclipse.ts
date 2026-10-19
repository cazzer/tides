import * as THREE from 'three'
import {
  Body,
  GeoMoon,
  GeoVector,
  KM_PER_AU,
  RotateVector,
  Rotation_EQJ_ECT,
} from 'astronomy-engine'
import { eclipticToScene } from './ephemeris'

// Eclipse shadows come from the true geometry in kilometres, never from the
// compressed scene: there the Moon is 10 units from a 3-unit Earth and the Sun
// 50 units away, so any cone traced between the drawn bodies is wrong. Only
// directions carry over: a texel's true position is rebuilt from its direction
// in its body's frame (which is how the texture is placed), so the shadow
// lands on the same geography it does in reality.
//
// The shader in renderers/eclipseShadow.ts mirrors surfacePoint() and
// sunVisibleFraction(); keep them in step.

export const SUN_RADIUS_KM = 696_000
export const MOON_RADIUS_KM = 1_737.4
// WGS84. The texture's latitudes are geodetic, so a texel at latitude φ goes
// on the ellipsoid there; on a sphere the umbra lands ~20 km off at
// mid-latitudes, ~25 s at a fixed place.
export const EARTH_EQUATORIAL_RADIUS_KM = 6_378.137
export const EARTH_ECCENTRICITY_SQ = 0.00669438
// Earth's shadow on the Moon as NASA's lunar eclipse tables draw it (Danjon):
// the equatorial radius times 0.998340 for the oblateness, then 1/85 more for
// the atmosphere. Chauvenet's 2% widening of both cones puts the contacts
// 0.5–2 min off those tables.
export const EARTH_SHADOW_RADIUS_KM =
  EARTH_EQUATORIAL_RADIUS_KM * 0.99834 * (1 + 1 / 85)

// Fraction of the Sun's disc hidden by the occluder's disc. Angular radii and
// the separation of their centres, in any one unit; the discs are treated as
// flat (both are under 1°) and the Sun's as uniformly bright.
export function coveredFraction(
  sunRadius: number,
  occluderRadius: number,
  separation: number
): number {
  // In units of the Sun's radius, so the shader's float32 keeps its digits.
  const r = occluderRadius / sunRadius
  const d = separation / sunRadius
  if (d >= 1 + r) return 0
  if (d <= Math.abs(r - 1)) return r >= 1 ? 1 : r * r
  // The lens where the discs overlap, over the Sun's area π.
  const a = Math.acos(clamp((d * d + 1 - r * r) / (2 * d), -1, 1))
  const b = Math.acos(clamp((d * d + r * r - 1) / (2 * d * r), -1, 1))
  const k = Math.sqrt(
    Math.max(0, (-d + 1 + r) * (d + 1 - r) * (d - 1 + r) * (d + 1 + r))
  )
  return clamp((a + r * r * b - 0.5 * k) / Math.PI, 0, 1)
}

const toSun = new THREE.Vector3()
const toOccluder = new THREE.Vector3()

// Fraction of the Sun's disc visible from `point` past an occluding sphere.
// Positions in km, in one frame.
export function sunVisibleFraction(
  point: THREE.Vector3,
  sun: THREE.Vector3,
  occluder: THREE.Vector3,
  occluderRadiusKm: number
): number {
  toSun.subVectors(sun, point)
  toOccluder.subVectors(occluder, point)
  const sunDistance = toSun.length()
  const occluderDistance = toOccluder.length()
  const sunRadius = Math.asin(SUN_RADIUS_KM / sunDistance)
  const occluderRadius = Math.asin(
    Math.min(1, occluderRadiusKm / occluderDistance)
  )
  // From the chord between the unit directions: acos(dot) loses the small
  // angles that matter here (to ~0.02° in float32).
  toSun.divideScalar(sunDistance)
  toOccluder.divideScalar(occluderDistance)
  const separation =
    2 * Math.asin(Math.min(1, toSun.distanceTo(toOccluder) / 2))
  return 1 - coveredFraction(sunRadius, occluderRadius, separation)
}

export interface EclipseBodies {
  sun: THREE.Vector3 // geocentric, km, scene axes
  moon: THREE.Vector3 // geocentric, km, scene axes
}

// Geocentric Sun (apparent, i.e. with aberration, as eclipse predictions use)
// and Moon, in km along the scene's axes (ecliptic of date, +Y north).
export function eclipseBodies(
  t: number,
  out: EclipseBodies = { sun: new THREE.Vector3(), moon: new THREE.Vector3() }
): EclipseBodies {
  const date = new Date(t)
  const toEcliptic = Rotation_EQJ_ECT(date)
  eclipticToScene(
    RotateVector(toEcliptic, GeoVector(Body.Sun, date, true)),
    out.sun
  ).multiplyScalar(KM_PER_AU)
  eclipticToScene(
    RotateVector(toEcliptic, GeoMoon(date)),
    out.moon
  ).multiplyScalar(KM_PER_AU)
  return out
}

export type ShadedBody = 'earth' | 'moon'

// What shading one body needs: its shape, and the Sun and the occluder
// relative to its centre, in km along the scene's axes.
export interface EclipseShading {
  bodyRadius: number // equatorial, km
  bodyEccentricitySq: number
  sun: THREE.Vector3
  occluder: THREE.Vector3
  occluderRadius: number // km
  // False while no point on the body can be in even the penumbra.
  active: boolean
}

export function createEclipseShading(body: ShadedBody): EclipseShading {
  const earth = body === 'earth'
  return {
    bodyRadius: earth ? EARTH_EQUATORIAL_RADIUS_KM : MOON_RADIUS_KM,
    bodyEccentricitySq: earth ? EARTH_ECCENTRICITY_SQ : 0,
    sun: new THREE.Vector3(),
    occluder: new THREE.Vector3(),
    occluderRadius: earth ? MOON_RADIUS_KM : EARTH_SHADOW_RADIUS_KM,
    active: false,
  }
}

// Penumbral contact needs the Moon within ~1.6° of the Sun (solar) or ~1.9°
// of the anti-Sun (lunar), seen from the Earth's centre.
const ACTIVE_ANGLE = (3 * Math.PI) / 180
const bodies: EclipseBodies = {
  sun: new THREE.Vector3(),
  moon: new THREE.Vector3(),
}

export function updateEclipseShading(
  shading: EclipseShading,
  body: ShadedBody,
  t: number
): EclipseShading {
  const { sun, moon } = eclipseBodies(t, bodies)
  const angle = sun.angleTo(moon)
  if (body === 'earth') {
    shading.sun.copy(sun)
    shading.occluder.copy(moon)
    shading.active = angle < ACTIVE_ANGLE
  } else {
    shading.sun.subVectors(sun, moon)
    shading.occluder.copy(moon).negate()
    shading.active = Math.PI - angle < ACTIVE_ANGLE
  }
  return shading
}

// The true surface point (km from the body's centre, scene axes) under the
// texel whose direction in the body's frame (+Y the pole, as on the sphere
// geometry) is `local`; that direction's latitude is read as geodetic.
export function surfacePoint(
  shading: EclipseShading,
  local: THREE.Vector3,
  orientation: THREE.Quaternion,
  out = new THREE.Vector3()
): THREE.Vector3 {
  const e2 = shading.bodyEccentricitySq
  out.copy(local).normalize()
  const n = shading.bodyRadius / Math.sqrt(1 - e2 * out.y * out.y)
  out.set(out.x * n, out.y * n * (1 - e2), out.z * n)
  return out.applyQuaternion(orientation)
}

// Visible fraction of the Sun at a point from surfacePoint().
export function shadingAt(
  shading: EclipseShading,
  point: THREE.Vector3
): number {
  if (!shading.active) return 1
  return sunVisibleFraction(
    point,
    shading.sun,
    shading.occluder,
    shading.occluderRadius
  )
}

function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x))
}
