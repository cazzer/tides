// True distances for the ship HUD (tides-3bl.5).
//
// The scene is not to scale, and not by one factor: planets sit at
// sceneDistance(r) (power law inside 1.7 AU, log beyond), the Moon orbits at
// 10 units per 384 400 km (~44× the heliocentric scale at 1 AU), and every
// radius is on a log scale. So the ship has no exact true position. The HUD
// builds one, and reads every range off it, so the ranges never contradict
// each other (no "1 AU from Earth and 1 km from the Moon"):
//
//   1. Each body R anchors a guess: R's true position (astronomy-engine,
//      heliocentric, km) plus the ship's scene direction from R, at R's true
//      radius plus the ship's gap to R's shell × kmPerUnit(R).
//   2. kmPerUnit(R) is the true surface gap over the scene shell gap between R
//      and its neighbours, weighted to the nearest (1 / gap⁴, log space): the
//      km a scene unit stands for around R. Earth and the Moon use their own
//      pair only, since the Moon orbits on its own scale.
//   3. The guesses blend with weights 1 / (ship's gap to R)⁴, so the anchor is
//      whichever body the ship is near, handing over smoothly in between.
//      Near Earth (MOON_SYSTEM_*), Earth and the Moon outweigh a planet that
//      happens to be as near in the scene: Venus near inferior conjunction
//      otherwise put the spawn millions of km out with the Moon beside it.
//   4. range(B) = |true B − true ship| − B's true radius.
//
// Gaps are to the collision shell, the closest the ship can get, and the
// anchor then puts the ship on R's true surface: a range reads 0 on arrival,
// and at Earth facing the Moon it is the true surface-to-surface distance
// (the astronomy-engine centre distance less both radii).
//
// The catch: radii are drawn far larger than true and directions between
// bodies are not true (only distances from the Sun are remapped), so away
// from the line between two bodies the position is the scene's geometry at
// the local true scale. Speed uses the same blended scale (km per scene unit
// where the ship is), so it is the rate the ranges change at.

import {
  Body,
  HelioVector,
  KM_PER_AU,
  RotateVector,
  Rotation_EQJ_ECT,
} from 'astronomy-engine'
import * as THREE from 'three'
import { eclipticToScene } from '../ephemeris'
import { PLANETS } from '../planets'
import { COLLISION_MARGIN, type Body as FlightBody } from './flight'

/** Speed of light, km/s. */
export const C_KM_PER_S = 299_792.458

// Weighting falls off fast enough that a body twice as far counts 1/16 as
// much: the anchor is the nearest body unless two are about as near.
const WEIGHT_POWER = 4
// Gaps are floored here so a ship resting on a shell (gap 0) weights finitely.
const MIN_GAP = 1e-3

// Within MOON_SYSTEM_INNER of Earth's centre, Earth and the Moon weigh
// MOON_SYSTEM_BOOST times as much as anchors; past MOON_SYSTEM_OUTER, the
// same as any body; between, a smooth blend. The Moon orbits ~10 units out;
// the spawn is ~12 out on a wide screen and ~28 on a portrait phone (Earth
// framed across the short side). The boost has to be large because another
// body's guess is tens of millions of km off (its scale is the planets'):
// 1e4 is a gap 10× smaller, so with Venus as near as Earth at the spawn the
// position moves ~2% instead of ~50% (a boost of 100). Venus (which can pass
// ~14 units from Earth) still takes over within a unit or so of its surface.
const MOON_SYSTEM_INNER = 30
const MOON_SYSTEM_OUTER = 60
const MOON_SYSTEM_BOOST = 1e4

const ASTRO_BODIES: Record<string, Body> = {
  sun: Body.Sun,
  earth: Body.Earth,
  moon: Body.Moon,
  ...Object.fromEntries(Object.values(PLANETS).map((planet) => [planet.key, planet.body])),
}

// Mean radii, km: half the diameters the scene's spheres are sized from
// (ship-bodies.ts, planets.ts).
const RADIUS_KM: Record<string, number> = {
  sun: 1_392_700 / 2,
  earth: 12_742 / 2,
  moon: 3_474.8 / 2,
  ...Object.fromEntries(
    Object.values(PLANETS).map((planet) => [planet.key, planet.diameter / 2000])
  ),
}

/** Where the bodies truly are: km from the Sun along the scene's axes. */
export interface TrueBodies {
  positions: THREE.Vector3[]
  /** Mean radius, km. */
  radii: number[]
}

/**
 * True heliocentric positions (km, scene axes: ecliptic of date, +Y north)
 * and radii of the bodies `keys` at `t`, epoch ms. Keys are ship body keys
 * ('sun', 'earth', 'moon' or a planet).
 */
export function trueBodies(keys: readonly string[], t: number): TrueBodies {
  const date = new Date(t)
  const toEcliptic = Rotation_EQJ_ECT(date)
  return {
    positions: keys.map((key) => {
      const body = ASTRO_BODIES[key]
      if (body === undefined) throw new Error(`No ephemeris for ${key}`)
      return eclipticToScene(
        RotateVector(toEcliptic, HelioVector(body, date)),
        new THREE.Vector3()
      ).multiplyScalar(KM_PER_AU)
    }),
    radii: keys.map((key) => RADIUS_KM[key]),
  }
}

/** The closest the ship gets to `body`'s centre, scene units. */
function shell(body: FlightBody): number {
  return body.radius * COLLISION_MARGIN
}

function pairGap(a: FlightBody, b: FlightBody): number {
  return Math.max(MIN_GAP, a.position.distanceTo(b.position) - shell(a) - shell(b))
}

function weight(gap: number): number {
  return Math.max(MIN_GAP, gap) ** -WEIGHT_POWER
}

export interface ShipRanges {
  /** True range to each body's surface (in `bodies` order), km. */
  km: Float64Array
  /** Index of the body with the smallest range; -1 with no bodies. */
  nearest: number
  /** km per scene unit where the ship is; scene speed × this = km/s. */
  kmPerUnit: number
  /** The ship's true position, km from the Sun along the scene's axes. */
  position: THREE.Vector3
}

export function createShipRanges(count: number): ShipRanges {
  return {
    km: new Float64Array(count),
    nearest: -1,
    kmPerUnit: NaN,
    position: new THREE.Vector3(),
  }
}

const gaps: number[] = []
const logScales: number[] = []
const anchor = new THREE.Vector3()
const direction = new THREE.Vector3()

// ln(km per scene unit) between a and b: true surface gap over scene shell gap.
function pairLogScale(
  a: number,
  b: number,
  bodies: readonly FlightBody[],
  truth: TrueBodies
): number {
  const surfaceKm =
    truth.positions[a].distanceTo(truth.positions[b]) - truth.radii[a] - truth.radii[b]
  return Math.log(Math.max(1, surfaceKm) / pairGap(bodies[a], bodies[b]))
}

/**
 * Fill `out` with the ship's true position, its range to every body, the
 * nearest by range and the local km per scene unit (see the header), for a
 * ship at scene `position` among `bodies`. `truth` is trueBodies for the same
 * bodies in the same order.
 */
export function measureRanges(
  position: THREE.Vector3,
  bodies: readonly FlightBody[],
  truth: TrueBodies,
  out: ShipRanges
): ShipRanges {
  const n = bodies.length
  gaps.length = n
  logScales.length = n
  for (let i = 0; i < n; i++) {
    gaps[i] = Math.max(0, position.distanceTo(bodies[i].position) - shell(bodies[i]))
  }

  const earth = bodies.findIndex((body) => body.key === 'earth')
  const moon = bodies.findIndex((body) => body.key === 'moon')
  const moonSystem = earth >= 0 && moon >= 0
  const moonSystemLog = moonSystem ? pairLogScale(earth, moon, bodies, truth) : 0
  const moonSystemBoost = moonSystem
    ? MOON_SYSTEM_BOOST **
      (1 -
        THREE.MathUtils.smoothstep(
          position.distanceTo(bodies[earth].position),
          MOON_SYSTEM_INNER,
          MOON_SYSTEM_OUTER
        ))
    : 1

  for (let r = 0; r < n; r++) {
    if (moonSystem && (r === earth || r === moon)) {
      logScales[r] = moonSystemLog
      continue
    }
    let weightSum = 0
    let logSum = 0
    for (let b = 0; b < n; b++) {
      if (b === r) continue
      const w = weight(pairGap(bodies[r], bodies[b]))
      weightSum += w
      logSum += w * pairLogScale(r, b, bodies, truth)
    }
    logScales[r] = weightSum > 0 ? logSum / weightSum : 0
  }

  out.position.set(0, 0, 0)
  let weightSum = 0
  let logSum = 0
  for (let r = 0; r < n; r++) {
    let w = weight(gaps[r])
    if (r === earth || r === moon) w *= moonSystemBoost
    direction.subVectors(position, bodies[r].position)
    if (direction.lengthSq() > 0) direction.normalize()
    anchor
      .copy(truth.positions[r])
      .addScaledVector(direction, truth.radii[r] + gaps[r] * Math.exp(logScales[r]))
    out.position.addScaledVector(anchor, w)
    weightSum += w
    logSum += w * logScales[r]
  }
  if (weightSum > 0) out.position.divideScalar(weightSum)
  out.kmPerUnit = weightSum > 0 ? Math.exp(logSum / weightSum) : NaN

  out.nearest = -1
  for (let b = 0; b < n; b++) {
    out.km[b] = Math.max(0, truth.positions[b].distanceTo(out.position) - truth.radii[b])
    if (out.nearest < 0 || out.km[b] < out.km[out.nearest]) out.nearest = b
  }
  return out
}

const MILLION = 1e6
// Short of a tenth of an AU, AU would need too many zeros to read.
const AU_FROM = 0.1 * KM_PER_AU
const threeFigures = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 })
const twoFigures = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 2 })

/** "766,000 km", "2.03 million km" from a million km, "1.52 AU" from 0.1 AU. */
export function formatDistance(km: number): string {
  if (!Number.isFinite(km)) return '—'
  if (km < MILLION) return `${threeFigures.format(km)} km`
  if (km < AU_FROM) return `${threeFigures.format(km / MILLION)} million km`
  return `${threeFigures.format(km / KM_PER_AU)} AU`
}

// Below a tenth of light speed km/s reads better; above it, Elite's c.
const C_FROM = 0.1 * C_KM_PER_S

/** "15,500 km/s" under 0.1 c, else "1.3c". */
export function formatSpeed(kmPerSecond: number): string {
  if (!Number.isFinite(kmPerSecond)) return '—'
  if (kmPerSecond < C_FROM) return `${threeFigures.format(kmPerSecond)} km/s`
  return `${twoFigures.format(kmPerSecond / C_KM_PER_S)}c`
}

/** "7 s", "3 min", "2 h"; a dash when not closing. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 100) return `${Math.round(seconds)} s`
  if (seconds < 100 * 60) return `${Math.round(seconds / 60)} min`
  return `${Math.round(seconds / 3600)} h`
}

const NAMES: Record<string, string> = {
  sun: 'Sun',
  earth: 'Earth',
  moon: 'Moon',
  ...Object.fromEntries(Object.values(PLANETS).map((planet) => [planet.key, planet.name])),
}

/** Display name for a ship body key. */
export function bodyName(key: string): string {
  return NAMES[key] ?? key
}
