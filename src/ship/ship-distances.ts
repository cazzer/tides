// True distances for the ship HUD (tides-3bl.5).
//
// The scene is not to scale, and not by one factor: planets sit at
// sceneDistance(r) (power law inside 1.7 AU, log beyond), the Moon orbits at
// 10 units per 384 400 km (~44× the heliocentric scale at 1 AU), and every
// radius is on a log scale. So "where the ship truly is" has no single answer.
// What does have one is the true distance between two bodies, from the
// ephemeris. The HUD reads off that:
//
//   range(B) = shellGap(ship, B) × kmPerUnit(B)
//   kmPerUnit(B) = trueCentreDistance(R, B) / shellGap(R, B)
//
// where R is the body the ship is near (Earth and the Moon excepted, see
// MOON_SYSTEM_INNER): you are that share of the way across
// the gap from R to B, and that gap is truly so many km. R is not one body
// but every other body, weighted by 1 / (ship's gap to R)^4 and averaged in
// log space, so the scale follows whichever body the ship is near without a
// jump when that changes (a hard switch between Earth and the Moon as R moved
// a Mars range by ~30%). Gaps are to the collision shell (flight.ts
// COLLISION_MARGIN), the closest the ship can get, so a range reads 0 on
// arrival and, at R's shell on the line to B, exactly the true centre-to-
// centre distance R → B: at Earth facing the Moon it shows the Earth–Moon
// distance from astronomy-engine. True radii are ignored (Earth's is 1.7% of
// the Moon's distance; a planet's is far less of anything).
//
// The catch is honest about the scene: radii are drawn far larger than true,
// so off the line between bodies (e.g. on Earth's night side, facing away
// from the Moon) a range reflects the scene's geometry at the local true
// scale, not the true geometry. Speed uses the same local scale (km per scene
// unit near the ship), so it is the rate the ranges change at.

import { Body, HelioVector, KM_PER_AU } from 'astronomy-engine'
import * as THREE from 'three'
import { PLANETS, type PlanetKey } from '../planets'
import { COLLISION_MARGIN, type Body as FlightBody } from './flight'

/** Speed of light, km/s. */
export const C_KM_PER_S = 299_792.458

// Weighting falls off fast enough that a body twice as far counts 1/16 as
// much: the scale is the nearest body's unless two are about as near.
const WEIGHT_POWER = 4
// Gaps are floored here so a ship resting on a shell (gap 0) weights finitely.
const MIN_GAP = 1e-3

const ASTRO_BODIES: Record<string, Body> = {
  sun: Body.Sun,
  earth: Body.Earth,
  moon: Body.Moon,
  ...Object.fromEntries(
    Object.values(PLANETS).map((planet) => [planet.key, planet.body])
  ),
}

/**
 * True centre-to-centre distances between `keys` at `t` (epoch ms), km, as an
 * n×n row-major matrix. Keys are ship body keys ('sun', 'earth', 'moon' or a
 * planet).
 */
export function trueSeparations(keys: readonly string[], t: number): Float64Array {
  const date = new Date(t)
  const positions = keys.map((key) => {
    const body = ASTRO_BODIES[key]
    if (body === undefined) throw new Error(`No ephemeris for ${key}`)
    return HelioVector(body, date)
  })
  const n = keys.length
  const out = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = positions[i]
      const b = positions[j]
      const km = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * KM_PER_AU
      out[i * n + j] = km
      out[j * n + i] = km
    }
  }
  return out
}

function shellGap(position: THREE.Vector3, body: FlightBody): number {
  return position.distanceTo(body.position) - body.radius * COLLISION_MARGIN
}

function pairGap(a: FlightBody, b: FlightBody): number {
  return Math.max(
    MIN_GAP,
    a.position.distanceTo(b.position) - (a.radius + b.radius) * COLLISION_MARGIN
  )
}

function weight(gap: number): number {
  return Math.max(MIN_GAP, gap) ** -WEIGHT_POWER
}

export interface ShipRanges {
  /** True range to each body (in `bodies` order), km. */
  km: Float64Array
  /** km per scene unit where the ship is; scene speed × this = km/s. */
  kmPerUnit: number
}

export function createShipRanges(count: number): ShipRanges {
  return { km: new Float64Array(count), kmPerUnit: NaN }
}

const gaps: number[] = []

// The Moon orbits on its own scale, ~44× the planets' at 1 AU, so near Earth
// a planet's gap would set the scale for Earth and the Moon (Venus near
// inferior conjunction put the spawn "0.2 AU from Earth" with the Moon in
// view beside it). Within MOON_SYSTEM_INNER of Earth's centre their ranges
// use the Earth–Moon gap's scale alone; past MOON_SYSTEM_OUTER, the general
// rule; between, a smooth blend. The Moon orbits ~10 units out; the spawn is
// ~12 out on a wide screen and ~28 on a portrait phone (Earth framed across
// the short side). Venus can come within ~14 of Earth, Mars ~20.
const MOON_SYSTEM_INNER = 30
const MOON_SYSTEM_OUTER = 60

/**
 * Fill `out` with the true range from a ship at `position` to every body and
 * the local km per scene unit (see the header). `separations` is
 * trueSeparations for the same bodies, in the same order.
 */
export function measureRanges(
  position: THREE.Vector3,
  bodies: readonly FlightBody[],
  separations: Float64Array,
  out: ShipRanges
): ShipRanges {
  const n = bodies.length
  gaps.length = n
  for (let i = 0; i < n; i++) gaps[i] = shellGap(position, bodies[i])

  const earth = bodies.findIndex((body) => body.key === 'earth')
  const moon = bodies.findIndex((body) => body.key === 'moon')
  const hasMoonSystem = earth >= 0 && moon >= 0
  const moonSystemLog = hasMoonSystem
    ? Math.log(separations[earth * n + moon] / pairGap(bodies[earth], bodies[moon]))
    : 0
  const outOfMoonSystem = hasMoonSystem
    ? THREE.MathUtils.smoothstep(
        position.distanceTo(bodies[earth].position),
        MOON_SYSTEM_INNER,
        MOON_SYSTEM_OUTER
      )
    : 1

  let shipWeight = 0
  let shipLog = 0
  for (let b = 0; b < n; b++) {
    let weightSum = 0
    let logSum = 0
    for (let r = 0; r < n; r++) {
      if (r === b) continue
      const w = weight(gaps[r])
      weightSum += w
      logSum += w * Math.log(separations[r * n + b] / pairGap(bodies[r], bodies[b]))
    }
    let log = weightSum > 0 ? logSum / weightSum : NaN
    if (b === earth || b === moon) {
      log = THREE.MathUtils.lerp(moonSystemLog, log, outOfMoonSystem)
    }
    out.km[b] = Math.max(0, gaps[b]) * Math.exp(log)
    const w = weight(gaps[b])
    shipWeight += w
    shipLog += w * log
  }
  out.kmPerUnit = shipWeight > 0 ? Math.exp(shipLog / shipWeight) : NaN
  return out
}

const KM_BELOW = 1e6
const kmFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const auFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 })
const speedFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 })
const cFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 2 })

/** "384,400 km" under a million km, else "1.52 AU". */
export function formatDistance(km: number): string {
  if (!Number.isFinite(km)) return '—'
  if (km < KM_BELOW) return `${kmFormat.format(km)} km`
  return `${auFormat.format(km / KM_PER_AU)} AU`
}

// Below a tenth of light speed km/s reads better; above it, Elite's c.
const C_FROM = 0.1 * C_KM_PER_S

/** "15,500 km/s" under 0.1 c, else "1.3c". */
export function formatSpeed(kmPerSecond: number): string {
  if (!Number.isFinite(kmPerSecond)) return '—'
  if (kmPerSecond < C_FROM) return `${speedFormat.format(kmPerSecond)} km/s`
  return `${cFormat.format(kmPerSecond / C_KM_PER_S)}c`
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
  ...Object.fromEntries(
    Object.entries(PLANETS).map(([key, planet]) => [key as PlanetKey, planet.name])
  ),
}

/** Display name for a ship body key. */
export function bodyName(key: string): string {
  return NAMES[key] ?? key
}
