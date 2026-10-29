// The tides demo's sums (tides-zec.4): the Moon's and the Sun's tide-raising
// pull on Earth and the equilibrium tide they raise, from true distances in
// km. The scene squeezes the Moon to ~10 units and the Sun to 50, so its
// distances would make the Sun's share ~2e5 rather than ~0.46; only its
// directions are used here (sceneTideDirections).
//
// A body of mass M at distance d pulls a point at R·p̂ from Earth's centre
// with GM/|d û − R p̂|²; minus the pull on the centre, to first order in R/d
// that leaves the tidal acceleration (GM R/d³)·(3(p̂·û)û − p̂). In units of
// the Moon's at its mean distance, k = (GM/GM☾)·(384,400 km/d)³, so
// k ≈ 1 for the Moon and ≈ 0.46 for the Sun. The sea's equilibrium surface
// under it stands h = H·k·(3/2)·(cos²θ − 1/3) above the mean, θ the body's
// zenith angle, with H = (GM☾/GM⊕)·R⁴/d³ ≈ 0.357 m at the Moon's mean
// distance (Cartwright, Tides: A Scientific History, ch. 13; the Love-number
// corrections for the yielding solid Earth are left out).

import {
  Body,
  GeoMoon,
  GeoVector,
  KM_PER_AU,
  MassProduct,
  RotateVector,
  Rotation_EQJ_EQD,
  SiderealTime,
  type Vector,
} from 'astronomy-engine'
import * as THREE from 'three'
import { earthPosition, moonOffset } from '../ephemeris'
import type { Location } from '../store'

/** The Moon's mean distance (semi-major axis), km. */
export const MOON_MEAN_KM = 384_400
/** Earth's mean radius, km. */
export const EARTH_RADIUS_KM = 6371
/** GM☉ / GM☾. */
export const SUN_MOON_GM = MassProduct(Body.Sun) / MassProduct(Body.Moon)
/** The Moon's equilibrium tide coefficient at its mean distance, metres: the
 * sea right under it stands H above the mean, and −H/2 along the limb. */
export const H_MOON_MEAN_M =
  (MassProduct(Body.Moon) / MassProduct(Body.Earth)) * (EARTH_RADIUS_KM ** 4 / MOON_MEAN_KM ** 3) * 1000
/** How much taller the drawn tide shell is than the true tide. */
export const TIDE_EXAGGERATION = 1e6
/** The marked spot with no pin: on the equator under the Moon at the daily
 * step's start (demos/tides.ts). */
export const TIDES_DEFAULT_SPOT = { lat: 0, lon: -62.4 }

const DEG = Math.PI / 180

export interface TidePulls {
  /** Centre-to-centre distances, km. */
  moonKm: number
  sunKm: number
  /** Tide-raising strength in units of the Moon's at its mean distance. */
  moon: number
  sun: number
  /** The combined tide's range (high minus low along the Moon–Sun great
   * circle) in the same units: k_m + k_s when lined up, |k_m − k_s| when
   * square. */
  range: number
}

function geoBodies(date: Date): { moon: Vector; sun: Vector } {
  return { moon: GeoMoon(date), sun: GeoVector(Body.Sun, date, true) }
}

export function tidePulls(t: number): TidePulls {
  const { moon, sun } = geoBodies(new Date(t))
  const moonKm = moon.Length() * KM_PER_AU
  const sunKm = sun.Length() * KM_PER_AU
  const km = (MOON_MEAN_KM / moonKm) ** 3
  const ks = SUN_MOON_GM * (MOON_MEAN_KM / sunKm) ** 3
  const cosPsi = (moon.x * sun.x + moon.y * sun.y + moon.z * sun.z) / (moon.Length() * sun.Length())
  const cos2Psi = 2 * cosPsi * cosPsi - 1
  const range = Math.sqrt(Math.max(0, km * km + ks * ks + 2 * km * ks * cos2Psi))
  return { moonKm, sunKm, moon: km, sun: ks, range }
}

/**
 * The tidal acceleration at the surface point `p` (unit) from a body in
 * direction `u` (unit) with strength `k`: k·(3(p·u)u − p), into `out`.
 */
export function tidalAccel(p: THREE.Vector3, u: THREE.Vector3, k: number, out: THREE.Vector3): THREE.Vector3 {
  const c = p.dot(u)
  return out.copy(u).multiplyScalar(3 * c).sub(p).multiplyScalar(k)
}

/** The equilibrium tide (metres above the mean) where the Moon's and the
 * Sun's zenith angles have cosines `cosMoon`, `cosSun`. */
export function equilibriumHeight(cosMoon: number, cosSun: number, pulls: Pick<TidePulls, 'moon' | 'sun'>): number {
  return (
    H_MOON_MEAN_M *
    1.5 *
    (pulls.moon * (cosMoon * cosMoon - 1 / 3) + pulls.sun * (cosSun * cosSun - 1 / 3))
  )
}

/** The equilibrium tide at a latitude and longitude (deg) at `t`, metres,
 * worked in the true equator of date, apart from the scene. */
export function spotTide(latDeg: number, lonDeg: number, t: number): number {
  const date = new Date(t)
  const rotation = Rotation_EQJ_EQD(date)
  const { moon, sun } = geoBodies(date)
  const m = RotateVector(rotation, moon)
  const s = RotateVector(rotation, sun)
  const phi = latDeg * DEG
  const h = SiderealTime(date) * 15 * DEG + lonDeg * DEG
  const px = Math.cos(phi) * Math.cos(h)
  const py = Math.cos(phi) * Math.sin(h)
  const pz = Math.sin(phi)
  const cosMoon = (px * m.x + py * m.y + pz * m.z) / m.Length()
  const cosSun = (px * s.x + py * s.y + pz * s.z) / s.Length()
  return equilibriumHeight(cosMoon, cosSun, tidePulls(t))
}

export function tidesSpot(location: Location | null): { lat: number; lon: number; pinned: boolean } {
  return location
    ? { lat: location.lat, lon: location.lon, pinned: true }
    : { ...TIDES_DEFAULT_SPOT, pinned: false }
}

/** The unit directions from Earth's centre to the Moon and to the Sun in the
 * system view's scene axes. */
export function sceneTideDirections(t: number, outMoon: THREE.Vector3, outSun: THREE.Vector3): void {
  outMoon.fromArray(moonOffset(t)).normalize()
  const [x, y, z] = earthPosition(t)
  outSun.set(-x, -y, -z).normalize()
}
