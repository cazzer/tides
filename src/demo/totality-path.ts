// The solar eclipse tour's path of totality (tides-zec.12): where the
// umbra's axis has met the ground since it first touched Earth, from the true
// geometry in km (eclipse.ts), never the compressed scene. MoonShadowGlobe
// draws it behind the shadow dot from a table resampled by longitude, so the
// trail at any sim time is a pure function of that time.
import * as THREE from 'three'
import { applyBodyTransform } from '../body-transform'
import {
  EARTH_ECCENTRICITY_SQ,
  EARTH_EQUATORIAL_RADIUS_KM,
  eclipseBodies,
  type EclipseBodies,
} from '../eclipse'
import { earthSpin, earthTilt } from '../ephemeris'

/** 8 April 2024: the umbra meets Earth (NASA), where the trail starts. */
export const LANDFALL_MS = Date.parse('2024-04-08T16:38:48Z')
/** The umbra leaves Earth (NASA); the axis left a little before. */
export const DEPARTURE_MS = Date.parse('2024-04-08T19:55:27Z')

export const TRAIL_ROWS = 64

const bodies: EclipseBodies = { sun: new THREE.Vector3(), moon: new THREE.Vector3() }
const earth = new THREE.Object3D()
const toEarthLocal = new THREE.Quaternion()
const origin = new THREE.Vector3()
const axis = new THREE.Vector3()
const closest = new THREE.Vector3()
// The ellipsoid's y axis scaled by this becomes a sphere of the equatorial
// radius.
const FLATTEN = Math.sqrt(1 - EARTH_ECCENTRICITY_SQ)

/**
 * Where the umbra's axis (the Sun's centre through the Moon's) first meets
 * the WGS84 ellipsoid at t, as the geodetic direction in Earth's own frame
 * (+Y the pole, longitude -atan2(z, x), the texture's and
 * calculateLocationAndRotationForLatLng's): the texel the shadow's centre is
 * over, read as eclipse.ts's surfacePoint() reads it. Null while it misses.
 */
export function umbraCentreline(t: number, out = new THREE.Vector3()): THREE.Vector3 | null {
  const { sun, moon } = eclipseBodies(t, bodies)
  applyBodyTransform(earth, { tiltAt: earthTilt, spinAt: earthSpin }, t)
  toEarthLocal.copy(earth.quaternion).invert()
  origin.copy(moon).applyQuaternion(toEarthLocal)
  axis.subVectors(moon, sun).applyQuaternion(toEarthLocal)
  // Squashed so the ellipsoid is a sphere: the line stays a line.
  origin.y /= FLATTEN
  axis.y /= FLATTEN
  axis.normalize()
  const along = -origin.dot(axis)
  if (along <= 0) return null
  closest.copy(origin).addScaledVector(axis, along)
  const miss2 = EARTH_EQUATORIAL_RADIUS_KM ** 2 - closest.lengthSq()
  if (miss2 < 0) return null
  // The sunward crossing, back on the ellipsoid.
  out.copy(origin).addScaledVector(axis, along - Math.sqrt(miss2))
  out.y *= FLATTEN
  // Its geodetic normal, the gradient (x, y / (1 - e²), z).
  out.y /= 1 - EARTH_ECCENTRICITY_SQ
  return out.normalize()
}

export function latOf(direction: THREE.Vector3): number {
  return Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1))
}

export function lonOf(direction: THREE.Vector3): number {
  return -Math.atan2(direction.z, direction.x)
}

export interface CentrelineSample {
  t: number // ms
  lat: number // rad
  lon: number // rad
}

const point = new THREE.Vector3()

function sampleAt(t: number): CentrelineSample | null {
  const p = umbraCentreline(t, point)
  return p && { t, lat: latOf(p), lon: lonOf(p) }
}

// The first (rising) or last time the axis is on Earth, to the millisecond.
function edgeTime(onAt: number, offAt: number): number {
  while (Math.abs(offAt - onAt) > 1) {
    const mid = Math.round((onAt + offAt) / 2)
    if (umbraCentreline(mid, point)) onAt = mid
    else offAt = mid
  }
  return onAt
}

const COARSE_MS = 20_000
// Finer where the axis grazes the limb and races across the ground.
const MAX_STEP_RAD = (0.25 * Math.PI) / 180

/**
 * The centreline from the axis's first touch to its last, with no two
 * samples more than 0.25° of longitude apart.
 */
export function centrelineSamples(): CentrelineSample[] {
  let first = LANDFALL_MS
  while (!umbraCentreline(first, point)) first += COARSE_MS
  first = edgeTime(first, first - COARSE_MS)
  let last = DEPARTURE_MS
  while (!umbraCentreline(last, point)) last -= COARSE_MS
  last = edgeTime(last, last + COARSE_MS)

  const samples: CentrelineSample[] = []
  const push = (a: CentrelineSample, b: CentrelineSample, depth: number) => {
    if (depth < 12 && Math.abs(b.lon - a.lon) > MAX_STEP_RAD) {
      const mid = sampleAt((a.t + b.t) / 2)
      if (mid) {
        push(a, mid, depth + 1)
        push(mid, b, depth + 1)
        return
      }
    }
    samples.push(b)
  }
  let prev = sampleAt(first)!
  samples.push(prev)
  for (let t = first + COARSE_MS; ; t += COARSE_MS) {
    const next = sampleAt(Math.min(t, last))!
    push(prev, next, 0)
    prev = next
    if (t >= last) break
  }
  return samples
}

export interface TrailTable {
  /** Per row: centre latitude (rad), seconds after LANDFALL_MS the axis was
   * at that longitude, cos of the track's angle from east, spare. */
  rows: Float32Array
  /** Row 0's longitude and the step between rows, rad. */
  lon0: number
  dLon: number
}

let table: TrailTable | null = null

/** The centreline resampled at TRAIL_ROWS even steps of longitude: the
 * track runs steadily east, ~-159° to ~-20°. Built once, on first use. */
export function trailTable(): TrailTable {
  if (table) return table
  const samples = centrelineSamples()
  const lon0 = samples[0].lon
  const dLon = (samples[samples.length - 1].lon - lon0) / (TRAIL_ROWS - 1)
  const rows = new Float32Array(TRAIL_ROWS * 4)
  let j = 0
  for (let i = 0; i < TRAIL_ROWS; i++) {
    const lon = lon0 + i * dLon
    while (j < samples.length - 2 && samples[j + 1].lon < lon) j++
    const a = samples[j]
    const b = samples[j + 1]
    const f = THREE.MathUtils.clamp((lon - a.lon) / (b.lon - a.lon), 0, 1)
    const lat = a.lat + f * (b.lat - a.lat)
    const east = Math.cos(lat) * (b.lon - a.lon)
    const north = b.lat - a.lat
    rows[i * 4] = lat
    rows[i * 4 + 1] = (a.t + f * (b.t - a.t) - LANDFALL_MS) / 1000
    rows[i * 4 + 2] = east / Math.hypot(east, north)
  }
  table = { rows, lon0, dLon }
  return table
}
