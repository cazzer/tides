import * as THREE from 'three'
import {
  Body,
  EclipticGeoMoon,
  KM_PER_AU,
  MakeTime,
  RotateVector,
  RotationAxis,
  Rotation_EQJ_ECT,
  SiderealTime,
  SunPosition,
  Vector,
} from 'astronomy-engine'

export type Vec3 = [number, number, number]

export const EARTH_ORBIT_RADIUS = 50
// Mean obliquity at J2000. The true obliquity of date drifts about
// −0.013°/century and nods ±0.003°, so a fixed tilt is within ~0.012° over
// 1950–2100.
export const EARTH_AXIAL_TILT = 23.4393
export const MOON_UNITS_PER_KM = 10 / 384400
const DEG = Math.PI / 180

// Scene angle φ = atan2(-z, x) maps to ecliptic longitude φ + 180°, so the
// Earth's scene angle equals the Sun's geocentric longitude.
export function earthAngle(t: number): number {
  return SunPosition(new Date(t)).elon * DEG
}

export function earthPosition(t: number): Vec3 {
  const a = earthAngle(t)
  return [
    EARTH_ORBIT_RADIUS * Math.cos(a),
    0,
    -EARTH_ORBIT_RADIUS * Math.sin(a),
  ]
}

export function earthSpin(t: number): number {
  return SiderealTime(new Date(t)) * 15 * DEG + Math.PI
}

export function moonPosition(t: number): Vec3 {
  const { lat, lon, dist } = EclipticGeoMoon(new Date(t))
  const phi = (lon + 180) * DEG
  const beta = lat * DEG
  const r = dist * KM_PER_AU * MOON_UNITS_PER_KM
  const [x, y, z] = earthPosition(t)
  return [
    x + r * Math.cos(beta) * Math.cos(phi),
    y + r * Math.sin(beta),
    z - r * Math.cos(beta) * Math.sin(phi),
  ]
}

// Ecliptic of date (x toward λ = 0°, z north) to scene axes (φ = λ + 180°,
// +Y north).
function eclipticToScene(v: Vector, out: THREE.Vector3): THREE.Vector3 {
  return out.set(-v.x, v.z, v.y)
}

const moonPole = new THREE.Vector3()
const moonMeridian = new THREE.Vector3()
const moonLocalZ = new THREE.Vector3()
const moonBasis = new THREE.Matrix4()
const moonQuaternion = new THREE.Quaternion()

// IAU pole and prime meridian, so the Moon's axis follows Cassini's laws
// (precessing with its orbit's nodes) and the libration comes out right.
// Local +Y is the pole and +X is 0° longitude, matching the texture.
// Returns a shared quaternion, valid until the next call.
export function moonOrientation(t: number): THREE.Quaternion {
  const date = new Date(t)
  const { north, spin } = RotationAxis(Body.Moon, date)
  // W is measured eastward along the Moon's equator from its ascending node
  // on the J2000 equator.
  const nodeLength = Math.hypot(north.x, north.y)
  const nx = -north.y / nodeLength
  const ny = north.x / nodeLength
  const w = spin * DEG
  const meridian = new Vector(
    Math.cos(w) * nx + Math.sin(w) * -north.z * ny,
    Math.cos(w) * ny + Math.sin(w) * north.z * nx,
    Math.sin(w) * (north.x * ny - north.y * nx),
    north.t
  )
  const toEcliptic = Rotation_EQJ_ECT(date)
  eclipticToScene(RotateVector(toEcliptic, north), moonPole)
  eclipticToScene(RotateVector(toEcliptic, meridian), moonMeridian)
  // Local −Z is east (90°E on the texture), so +Z = meridian × pole.
  moonLocalZ.crossVectors(moonMeridian, moonPole)
  moonBasis.makeBasis(moonMeridian, moonPole, moonLocalZ)
  return moonQuaternion.setFromRotationMatrix(moonBasis)
}

// IAU prime meridian angle W for the Sun.
export function sunSpin(t: number): number {
  return (84.176 + 14.1844 * MakeTime(new Date(t)).tt) * DEG
}

// Local midnight, to match the locale-formatted clock.
export function monthStartAngles(year: number): number[] {
  return Array.from({ length: 12 }, (_, m) => {
    const d = new Date(0)
    d.setFullYear(year, m, 1)
    d.setHours(0, 0, 0, 0)
    return earthAngle(d.getTime())
  })
}
