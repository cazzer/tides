// The other planets, placed around the Sun at the origin without moving the
// Earth (circle of radius EARTH_ORBIT_RADIUS = 50), the Moon (10 units per
// 384 400 km) or the Sun (radius 10).
//
// Directions are true: heliocentric ecliptic-of-date longitude and latitude
// pass through eclipticToScene unchanged. Only the distance r (AU) is
// remapped by sceneDistance:
//
//   r ≤ R0 = 1.7 AU:  f(r) = 50 · r^1.1                (f(1) = 50 exactly)
//   r > R0:           f(r) = f(R0) · (1 + K · ln(r / R0))
//
// The inner power law keeps Mercury's perihelion surface 12.2 units from the
// Sun's centre (clear of its radius-10 surface) and keeps Venus and Mars off
// the Moon's orbit around the Earth (50 ± 11.6 incl. the Moon's radius). The
// log tail is C0-continuous at R0 = f⁻¹(89.6) but not C1: matching the slope
// needs K = 1.1, which puts Neptune's aphelion surface at ~379. K = 0.9 puts
// it at 327, mid-way in the 300–350 target, and leaves 20+ unit gaps
// between the outer planets.
//
// Bands [f(q) − R, f(Q) + R] in scene units, with q/Q sampled over 1900–2100
// and R the ring outer radius for Saturn and Uranus:
//
//   Mercury  12.2 –  23.1     Jupiter  169.3 – 190.3
//   Venus    31.9 –  38.2     Saturn   210.0 – 247.4
//   Mars     69.3 –  89.7     Uranus   271.2 – 298.9
//                             Neptune  315.7 – 327.1
//
// (Earth 50, Moon envelope 38.4 – 61.6.) planets.test.ts asserts all of this.

import * as THREE from 'three'
import { scaleLog } from 'd3'
import {
  Body,
  HelioVector,
  PlanetOrbitalPeriod,
  Rotation_EQJ_ECT,
  type RotationMatrix,
} from 'astronomy-engine'
import { EARTH_ORBIT_RADIUS, axisOrientation, type Vec3 } from './ephemeris'

const MS_PER_DAY = 86_400_000

const INNER_POWER = 1.1
const R0 = 1.7
const F_R0 = EARTH_ORBIT_RADIUS * R0 ** INNER_POWER
const K = 0.9

export function sceneDistance(rAu: number): number {
  if (rAu <= R0) {
    return EARTH_ORBIT_RADIUS * rAu ** INNER_POWER
  }
  return F_R0 * (1 + K * Math.log(rAu / R0))
}

// The diameter scale shared with the Sun, Earth and Moon (Moon
// 1 ↔ Sun 10); the value is used as a sphere radius.
export const sceneRadius = scaleLog()
  .domain([3474800, 1392700000])
  .range([1, 10])

export type PlanetKey =
  'mercury' | 'venus' | 'mars' | 'jupiter' | 'saturn' | 'uranus' | 'neptune'

export interface Planet {
  key: PlanetKey
  name: string
  body: Body
  /** Mean diameter, m. */
  diameter: number
  /** Sphere radius in scene units. */
  radius: number
  /** Ring plane extent in planet radii (multiples of `radius`). */
  rings?: { inner: number; outer: number }
  /** Mean sidereal orbital period, days. */
  period: number
  /** Shown until a texture loads. */
  color: string
}

function planet(
  key: PlanetKey,
  name: string,
  body: Body,
  diameter: number,
  color: string,
  rings?: Planet['rings']
): Planet {
  return {
    key,
    name,
    body,
    diameter,
    radius: sceneRadius(diameter),
    rings,
    period: PlanetOrbitalPeriod(body),
    color,
  }
}

// Ring radii are over the equatorial radius: Saturn's C ring inner edge
// (74 658 km) to A ring outer edge (136 775 km); Uranus' 6 ring (41 837 km)
// to ε ring (51 149 km).
export const PLANETS: Readonly<Record<PlanetKey, Planet>> = {
  mercury: planet('mercury', 'Mercury', Body.Mercury, 4_879_400, '#8c8680'),
  venus: planet('venus', 'Venus', Body.Venus, 12_103_600, '#e6c88f'),
  mars: planet('mars', 'Mars', Body.Mars, 6_779_000, '#c1440e'),
  jupiter: planet('jupiter', 'Jupiter', Body.Jupiter, 139_822_000, '#d8ca9d'),
  saturn: planet('saturn', 'Saturn', Body.Saturn, 116_464_000, '#e3d39b', {
    inner: 1.239,
    outer: 2.27,
  }),
  uranus: planet('uranus', 'Uranus', Body.Uranus, 50_724_000, '#9fd3dc', {
    inner: 1.637,
    outer: 2.001,
  }),
  neptune: planet('neptune', 'Neptune', Body.Neptune, 49_244_000, '#4b70dd'),
}

/** Ordered outward from the Sun. */
export const PLANET_KEYS = Object.keys(PLANETS) as readonly PlanetKey[]

// Heliocentric EQJ (AU) → ecliptic of date → scene, with the length remapped
// by sceneDistance. Writes into `out`.
function heliocentricScene(
  body: Body,
  date: Date,
  rot: RotationMatrix,
  out: Float32Array | Vec3,
  offset: number
): void {
  const { x, y, z } = HelioVector(body, date)
  const r = rot.rot
  const ex = r[0][0] * x + r[1][0] * y + r[2][0] * z
  const ey = r[0][1] * x + r[1][1] * y + r[2][1] * z
  const ez = r[0][2] * x + r[1][2] * y + r[2][2] * z
  const rAu = Math.hypot(ex, ey, ez)
  const s = sceneDistance(rAu) / rAu
  // eclipticToScene: (x, y, z) → (−x, z, y)
  out[offset] = -ex * s
  out[offset + 1] = ez * s
  out[offset + 2] = ey * s
}

export function planetPosition(body: Body): (t: number) => Vec3 {
  return (t) => {
    const date = new Date(t)
    const out: Vec3 = [0, 0, 0]
    heliocentricScene(body, date, Rotation_EQJ_ECT(date), out, 0)
    return out
  }
}

// One sidereal period of positions centred on t, as xyz triples for a closed
// THREE.LineLoop. Every point uses the ecliptic of date t (the scene's frame
// at t), so the loop stays fixed while the planet moves along it.
export function planetOrbitPath(
  body: Body,
  t: number,
  segments: number
): Float32Array {
  const period = PlanetOrbitalPeriod(body) * MS_PER_DAY
  const rot = Rotation_EQJ_ECT(new Date(t))
  const points = new Float32Array(segments * 3)
  for (let i = 0; i < segments; i++) {
    const ti = t + (i / segments - 0.5) * period
    heliocentricScene(body, new Date(ti), rot, points, i * 3)
  }
  return points
}

// Local +Y is the IAU north pole, +X the prime meridian, −Z east. Returns a
// quaternion owned by this closure, valid until its next call.
export function bodyOrientation(body: Body): (t: number) => THREE.Quaternion {
  const q = new THREE.Quaternion()
  return (t) => axisOrientation(body, t, q)
}
