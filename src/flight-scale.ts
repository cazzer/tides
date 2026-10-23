// Where ship mode puts the Sun, Earth and planets (tides-2hv.6).
//
// The system view squeezes the planets in with sceneDistance (planets.ts):
// Neptune ~450 units out with Earth at 50, which is too tight to fly between.
// Flight spaces them at one linear scale instead, FLIGHT_UNITS_PER_AU, and
// takes Earth's true heliocentric position too, so the Sun, Earth and every
// planet are reality × FLIGHT_UNITS_PER_AU / KM_PER_AU: distances between
// any two of them are true at that scale, not only distances from the Sun.
// (The system Earth rides a circle of radius 50 at the Sun's longitude; a
// circle at this scale would sit up to 17 units off the true Earth.)
//
// Two things keep their system-view sizes, because true scale would make
// them invisible:
//   - every body's radius (sceneRadius, a log scale), and
//   - the Moon's distance from Earth: 10 units per 384 400 km (moonOffset).
//     Scaled with Earth it would sit 2.57 units out, inside Earth's
//     radius-2.95 sphere; true scale only reaches 10 units at ~3900 per AU.
//
// positionsFor(scale) is the one way in for anything placed by distance from
// the Sun, so the system view and ship mode can't drift apart: its 'system'
// record is earthPosition, moonPosition and planetPosition themselves.

import { Body, KM_PER_AU } from 'astronomy-engine'
import { earthPosition, moonOffset, moonPosition, type Vec3 } from './ephemeris'
import {
  PLANETS,
  PLANET_KEYS,
  planetOrbitPath,
  planetPosition,
  sceneDistance,
  type PlanetKey,
  type SceneDistance,
} from './planets'
import type { DistanceScale } from './distance-scale'

/**
 * Scene units per AU in ship mode: Earth ~1000 from the Sun, Neptune ~30 000.
 * [TUNE] Larger spreads the system out (longer trips, smaller bodies at
 * range; tides-2hv.7 sets the speeds to match). Precision holds without a
 * floating origin to ~1e4: three.js builds model-view in float64, and float32
 * world positions step 0.004 units at Neptune here.
 */
export const FLIGHT_UNITS_PER_AU = 1000

/** Linear: a body r AU from the Sun sits FLIGHT_UNITS_PER_AU · r units out. */
export const flightDistance: SceneDistance = (rAu) => FLIGHT_UNITS_PER_AU * rAu

/** km a scene unit stands for between the Sun, Earth and the planets in flight. */
export const FLIGHT_KM_PER_UNIT = KM_PER_AU / FLIGHT_UNITS_PER_AU

/** Earth's true heliocentric position at the flight scale. */
export const flightEarthPosition: (t: number) => Vec3 = planetPosition(
  Body.Earth,
  flightDistance
)

/** The flight Earth plus the Moon's unscaled geocentric offset (~10 units). */
export function flightMoonPosition(t: number): Vec3 {
  const [x, y, z] = flightEarthPosition(t)
  const [dx, dy, dz] = moonOffset(t)
  return [x + dx, y + dy, z + dz]
}

export function flightPlanetPosition(body: Body): (t: number) => Vec3 {
  return planetPosition(body, flightDistance)
}

/** planetOrbitPath at the flight scale; Body.Earth draws Earth's true orbit. */
export function flightOrbitPath(
  body: Body,
  t: number,
  segments: number,
  out?: Float32Array
): Float32Array {
  return planetOrbitPath(body, t, segments, out, flightDistance)
}

export type BodyKey = 'sun' | 'earth' | 'moon' | PlanetKey
/** The bodies with a heliocentric orbit to draw. */
export type OrbitKey = PlanetKey | 'earth'

export interface ScalePositions {
  /** Scene units from the Sun for a body r AU out (AU rings, scale bars). */
  distance: SceneDistance
  /**
   * Each body's scene position at t, epoch ms. The array is shared: a call at
   * the same t as the last returns it again without recomputing (a planet's
   * moons ask for it every frame), so read it, never mutate or keep it.
   */
  positionAt: Readonly<Record<BodyKey, (t: number) => Vec3>>
  /** One sidereal period of the body's positions centred on t (planetOrbitPath). */
  orbitPath(key: OrbitKey, t: number, segments: number, out?: Float32Array): Float32Array
}

const ORBIT_BODIES: Readonly<Record<OrbitKey, Body>> = {
  earth: Body.Earth,
  ...(Object.fromEntries(PLANET_KEYS.map((key) => [key, PLANETS[key].body])) as Record<
    PlanetKey,
    Body
  >),
}

// Hands back the last result while t is unchanged: the ephemeris costs far
// more than the comparison, and there is nothing to allocate on a repeat.
function sameTimeCache(positionAt: (t: number) => Vec3): (t: number) => Vec3 {
  let lastT = NaN
  let last: Vec3 = [0, 0, 0]
  return (t) => {
    if (t !== lastT) {
      last = positionAt(t)
      lastT = t
    }
    return last
  }
}

// The Sun stays at the origin at every scale: planetFrame and shipFar
// measure from there.
const ORIGIN: Vec3 = [0, 0, 0]
const sunPosition = (): Vec3 => ORIGIN

function scalePositions(
  distance: SceneDistance,
  earth: (t: number) => Vec3,
  moon: (t: number) => Vec3
): ScalePositions {
  const planets = Object.fromEntries(
    PLANET_KEYS.map((key) => [
      key,
      sameTimeCache(planetPosition(PLANETS[key].body, distance)),
    ])
  ) as Record<PlanetKey, (t: number) => Vec3>
  return {
    distance,
    positionAt: {
      sun: sunPosition,
      earth: sameTimeCache(earth),
      moon: sameTimeCache(moon),
      ...planets,
    },
    orbitPath: (key, t, segments, out) =>
      planetOrbitPath(ORBIT_BODIES[key], t, segments, out, distance),
  }
}

// Built once, so positionsFor hands out stable identities (safe as hook deps).
const SYSTEM = scalePositions(sceneDistance, earthPosition, moonPosition)
const FLIGHT = scalePositions(flightDistance, flightEarthPosition, flightMoonPosition)

/**
 * Body positions and orbit paths for a distance scale. 'system' is the
 * compressed system view (bit-for-bit earthPosition, moonPosition and
 * planetPosition); 'flight' is the linear ship-mode scale above. Anything
 * placed relative to a body (a planet's moons, aids) should start from
 * positionsFor(scale).positionAt[key], and anything placed by distance from
 * the Sun from positionsFor(scale).distance, never sceneDistance.
 */
export function positionsFor(scale: DistanceScale): ScalePositions {
  return scale === 'flight' ? FLIGHT : SYSTEM
}
