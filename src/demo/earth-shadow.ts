// Earth's shadow drawn where the Moon is (tides-zec.13, the lunar eclipse
// demo): the umbra's and penumbra's edges as circles in the plane through the
// Moon square to the Sun line, the Moon's track across them with marks at the
// umbral contacts, and the full Moons either side, which miss it. Sized from
// the true geometry in km, the same model the Moon's eclipse shading uses
// (eclipse.ts' sunVisibleFraction with EARTH_SHADOW_RADIUS_KM), then scaled
// so a Moon radius in km is the drawn Moon's radius: the circles agree with
// the darkening on the Moon. Only that scale changes; directions are the
// scene's, as eclipseShadow.ts places the shading.
//
// The 2D frame, seen from Earth looking out along the shadow: x east, y
// ecliptic north, so the Moon's orbit carries it towards +x.

import * as THREE from 'three'
import { SearchLunarEclipse, SearchMoonPhase } from 'astronomy-engine'
import {
  EARTH_SHADOW_RADIUS_KM,
  MOON_RADIUS_KM,
  SUN_RADIUS_KM,
  eclipseBodies,
  type EclipseBodies,
} from '../eclipse'
import { positionsFor } from '../flight-scale'

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000
/** The track's spacing in sim time. */
const TRACK_STEP_MS = 5 * MINUTE_MS
const NORTH = new THREE.Vector3(0, 1, 0)

/** Drawn units per km: a Moon radius in km is the drawn Moon's radius. */
const SCALE = positionsFor('system').radius.moon / MOON_RADIUS_KM

export interface ShadowFrame {
  /** Unit shadow axis, pointing away from the Sun. */
  axis: THREE.Vector3
  /** Unit, square to the axis, on ecliptic north's side. */
  north: THREE.Vector3
  /** Unit, north × axis: east on the sky seen from Earth. */
  east: THREE.Vector3
  /** Where the axis crosses the Moon's plane, from the drawn Moon's centre. */
  centre: THREE.Vector3
}

export function createShadowFrame(): ShadowFrame {
  return {
    axis: new THREE.Vector3(),
    north: new THREE.Vector3(),
    east: new THREE.Vector3(),
    centre: new THREE.Vector3(),
  }
}

const bodies: EclipseBodies = { sun: new THREE.Vector3(), moon: new THREE.Vector3() }
const offset = new THREE.Vector3()

/** The Moon's offset from the axis, km, into `offset`; returns `bodies`. */
function moonOffAxis(t: number, frame: ShadowFrame): EclipseBodies {
  const { sun, moon } = eclipseBodies(t, bodies)
  frame.axis.copy(sun).normalize().negate()
  frame.north.copy(frame.axis).multiplyScalar(-frame.axis.dot(NORTH)).add(NORTH).normalize()
  frame.east.crossVectors(frame.north, frame.axis)
  offset.copy(frame.axis).multiplyScalar(-moon.dot(frame.axis)).add(moon)
  return bodies
}

/** The shadow's frame at t, into `out`. */
export function shadowFrame(t: number, out: ShadowFrame = createShadowFrame()): ShadowFrame {
  moonOffAxis(t, out)
  out.centre.copy(offset).multiplyScalar(-SCALE)
  return out
}

export interface ShadowRadii {
  /** Drawn units, as the drawn Moon's radius is 1 Moon radius. */
  umbra: number
  penumbra: number
}

const scratchFrame = createShadowFrame()

/** The umbra's and penumbra's radii in the Moon's plane at t. */
export function shadowRadii(t: number): ShadowRadii {
  const { sun, moon } = moonOffAxis(t, scratchFrame)
  const d = moon.dot(scratchFrame.axis)
  const sunD = sun.length()
  // Where the angle between Earth's and the Sun's centres, seen from the
  // plane, is their angular radii's difference (umbra) or sum (penumbra).
  // Both lie behind the plane, so a step ρ off the axis parts them by
  // ρ/d − ρ/(sunD + d).
  const earthAngle = Math.asin(EARTH_SHADOW_RADIUS_KM / d)
  const sunAngle = Math.asin(SUN_RADIUS_KM / (sunD + d))
  const spread = 1 - d / (sunD + d)
  return {
    umbra: (d * (earthAngle - sunAngle) * SCALE) / spread,
    penumbra: (d * (earthAngle + sunAngle) * SCALE) / spread,
  }
}

/** The Moon's centre from the shadow's at t: [east, north], drawn units. */
export function moonInShadow(t: number): [number, number] {
  moonOffAxis(t, scratchFrame)
  return [offset.dot(scratchFrame.east) * SCALE, offset.dot(scratchFrame.north) * SCALE]
}

export interface LunarEclipseContacts {
  peak: number
  /** Ms since the epoch. */
  penumbral: [start: number, end: number]
  /** Null when the Moon never touches the umbra. */
  partial: [start: number, end: number] | null
  /** Null when it is never wholly inside it. */
  total: [start: number, end: number] | null
}

export interface LunarEclipseTrack {
  contacts: LunarEclipseContacts
  /** The Moon's centre every TRACK_STEP_MS through the penumbra, xyz (z 0). */
  track: Float32Array
  /** At the umbral contacts, xyz (z 0). */
  ticks: Float32Array
  /** The full Moons before and after, [east, north]. */
  ghosts: [number, number][]
}

function span(peak: number, semiMinutes: number): [number, number] | null {
  return semiMinutes > 0 ? [peak - semiMinutes * MINUTE_MS, peak + semiMinutes * MINUTE_MS] : null
}

function pointsAt(times: readonly number[]): Float32Array {
  const out = new Float32Array(times.length * 3)
  times.forEach((t, i) => {
    const [x, y] = moonInShadow(t)
    out[i * 3] = x
    out[i * 3 + 1] = y
  })
  return out
}

/** The lunar eclipse within a day of t, or null if there is none. */
export function lunarEclipseTrack(t: number): LunarEclipseTrack | null {
  const eclipse = SearchLunarEclipse(new Date(t - 2 * DAY_MS))
  const peak = eclipse.peak.date.getTime()
  if (Math.abs(peak - t) >= DAY_MS) return null
  const penumbral = span(peak, eclipse.sd_penum)!
  const partial = span(peak, eclipse.sd_partial)
  const total = span(peak, eclipse.sd_total)

  const trackTimes: number[] = []
  for (let s = penumbral[0]; s < penumbral[1]; s += TRACK_STEP_MS) trackTimes.push(s)
  trackTimes.push(penumbral[1])
  const tickTimes = [partial?.[0], total?.[0], total?.[1], partial?.[1]].filter(
    (s): s is number => s !== undefined
  )
  const ghosts = [
    SearchMoonPhase(180, new Date(peak - 35 * DAY_MS), 20),
    SearchMoonPhase(180, new Date(peak + 5 * DAY_MS), 40),
  ].flatMap((full) => (full ? [moonInShadow(full.date.getTime())] : []))

  return {
    contacts: { peak, penumbral, partial, total },
    track: pointsAt(trackTimes),
    ticks: pointsAt(tickTimes),
    ghosts,
  }
}

/** A closed circle of `radius` round the origin in XY: n + 1 xyz points. */
export function circlePoints(radius: number, n: number): Float32Array {
  const out = new Float32Array((n + 1) * 3)
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI
    out[i * 3] = radius * Math.cos(a)
    out[i * 3 + 1] = radius * Math.sin(a)
  }
  return out
}
