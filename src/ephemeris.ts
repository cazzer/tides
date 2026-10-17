import {
  EclipticGeoMoon,
  KM_PER_AU,
  MakeTime,
  SiderealTime,
  SunPosition,
} from 'astronomy-engine'

export type Vec3 = [number, number, number]

export const EARTH_ORBIT_RADIUS = 50
const MOON_UNITS_PER_KM = 10 / 384400
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

// The Moon's mean longitude keeps its prime meridian facing the Earth's mean
// direction; the true orbit's wobble around it is the libration.
export function moonSpin(t: number): number {
  const T = MakeTime(new Date(t)).tt / 36525
  return (218.3164477 + 481267.88123421 * T) * DEG
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
