// What grows a planet's moon system toward true spacing in the system view
// (tides-ufyr.6.3; the orbits themselves are moons.ts' setMoonExpansion).
// MoonBodies runs stepMoonExpansions once a frame for the main view, ahead of
// everything that reads the system scale, so every reader sees one value.
//
//   - The target: with the camera on a planet, all the way out once the eye
//     is at the planet's framing distance Zf (framingDistance, the distance
//     focusing it eases to) and nothing from EXPANSION_FAR_RATIO · Zf out,
//     smoothstepped in log distance between, so zooming in only ever grows
//     the system (its moons never recede on screen). With the camera on one
//     of its moons, all the way, whatever the zoom, so zooming on the moon
//     never slides it round its planet. Anything else, the compact map.
//   - The ease: exponential, EXPANSION_TAU, so a refocus or a jump in zoom
//     settles without a pop; reduced motion snaps.
//   - The cap: the system reaches no further than EXPANSION_CLEAR_SHARE of
//     the way to the nearest other body (the Sun, Earth with its Moon's
//     orbit, Mercury, Venus, and the other moon systems at their live
//     extent or their rings), nor within EXPANSION_MIN_CLEAR of it, so an
//     expanded system never runs into a neighbour. It is per frame: near Jupiter and Saturn's conjunctions the
//     system gives way as they close.
//
// All of it is allocation-free: the positions come from positionsFor's
// same-time caches, which the views fill for the frame anyway.
import * as THREE from 'three'
import { positionsFor, type BodyKey } from '../flight-scale'
import { MOON_UNITS_PER_KM } from '../ephemeris'
import { framingDistance } from '../main-view'
import type { CameraFocus } from '../store'
import {
  MOONS,
  MOON_PARENTS,
  SYSTEM_EXPANSION_MAX,
  expansionForExtent,
  isMoonKey,
  moonExpansion,
  moonSystemExtent,
  setMoonExpansion,
  type MoonParent,
} from './moons'
import { PLANETS } from '../planets'

/** Zoomed out this many framing distances, a focused planet's system is compact again. [TUNE] */
export const EXPANSION_FAR_RATIO = 4

/** Seconds for the expansion to close 63% of the way to its target. [TUNE] */
export const EXPANSION_TAU = 0.35

/**
 * How much of the room to the nearest other body (centre distance less its
 * reach) an expanded system may take. [TUNE] Saturn's system is the only
 * thing that holds Jupiter's back: at 0.9 Jupiter's expands all the way
 * ~90% of 1900–2100 (moon-expansion.test.ts); 0.8 would be ~88.5%, as
 * the two linger near conjunction for a year or two either side.
 */
export const EXPANSION_CLEAR_SHARE = 0.9

/**
 * The least room an expanded system leaves to the nearest other body, scene
 * units, where EXPANSION_CLEAR_SHARE would leave less (room under 10 units:
 * Mars beside the Earth–Moon pair at closest approach).
 */
export const EXPANSION_MIN_CLEAR = 2

const SYSTEM = positionsFor('system')

/**
 * How far the parent's system wants to be expanded, 0 (compact) to 1
 * (SYSTEM_EXPANSION_MAX), with the camera on `focus` `distance` from its
 * target and Earth drawn `earthRadius` in radius (framingDistance's).
 * `spread` (a demo's aids.moonSystems) holds a focused parent all the way
 * out at any distance, as a focused moon does.
 */
export function expansionTarget(
  focus: CameraFocus,
  distance: number,
  parent: MoonParent,
  earthRadius: number = SYSTEM.radius.earth,
  spread = false
): number {
  if (isMoonKey(focus)) return MOONS[focus].parent === parent ? 1 : 0
  if (focus !== parent) return 0
  if (spread) return 1
  const near = Math.log(framingDistance(SYSTEM.radius[parent], earthRadius))
  const far = near + Math.log(EXPANSION_FAR_RATIO)
  return 1 - THREE.MathUtils.smoothstep(Math.log(distance), near, far)
}

/**
 * How near its target the ease lands on it. An expansion that still moves
 * changes the orbits, and so rebuilds the orbit lines, every frame; landing
 * stops that, and puts a system back on the compact map exactly.
 */
export const EXPANSION_SNAP = 1e-4

/**
 * One frame (`dt` seconds) of the ease from `e` toward `target`: exponential
 * with time constant EXPANSION_TAU, so it never overshoots, landing on the
 * target within EXPANSION_SNAP; straight to it under reduced motion.
 */
export function stepExpansion(e: number, target: number, dt: number, reducedMotion: boolean): number {
  if (reducedMotion) return target
  const next = e + (target - e) * (1 - Math.exp(-dt / EXPANSION_TAU))
  return Math.abs(target - next) < EXPANSION_SNAP ? target : next
}

// What the cap keeps a system clear of, besides the other moon systems.
const OTHER_BODIES: readonly BodyKey[] = ['sun', 'earth', 'mercury', 'venus']

// Earth with its Moon at apogee (~406 700 km), as its orbit line reaches.
const EARTH_REACH = Math.max(SYSTEM.radius.earth, 406_700 * MOON_UNITS_PER_KM + SYSTEM.radius.moon)

function bodyReach(key: BodyKey): number {
  return key === 'earth' ? EARTH_REACH : SYSTEM.radius[key]
}

// A moon parent's reach: its rings', or its moons' live extent.
function parentReach(parent: MoonParent): number {
  const { radius, rings } = PLANETS[parent]
  return Math.max(radius * (rings?.outer ?? 1), moonSystemExtent(parent, 'system'))
}

function distanceBetween(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/**
 * The most the parent's system may expand at t: its extent held within
 * EXPANSION_CLEAR_SHARE of the room (centre distance less reach) to every
 * other body, and EXPANSION_MIN_CLEAR short of it, the other systems at
 * their extent now. 0 to SYSTEM_EXPANSION_MAX.
 */
export function expansionCap(parent: MoonParent, t: number): number {
  const centre = SYSTEM.positionAt[parent](t)
  let room = Infinity
  for (let i = 0; i < OTHER_BODIES.length; i++) {
    const key = OTHER_BODIES[i]
    room = Math.min(room, distanceBetween(centre, SYSTEM.positionAt[key](t)) - bodyReach(key))
  }
  for (let i = 0; i < MOON_PARENTS.length; i++) {
    const other = MOON_PARENTS[i]
    if (other === parent) continue
    room = Math.min(room, distanceBetween(centre, SYSTEM.positionAt[other](t)) - parentReach(other))
  }
  return expansionForExtent(parent, Math.min(EXPANSION_CLEAR_SHARE * room, room - EXPANSION_MIN_CLEAR))
}

/**
 * One frame of every parent's expansion: eased toward its target (`spread`
 * as expansionTarget's), held under its cap. Parents go in turn, so each
 * one's cap sees the others' extents as already set this frame.
 */
export function stepMoonExpansions(
  focus: CameraFocus,
  distance: number,
  t: number,
  dt: number,
  reducedMotion: boolean,
  earthRadius?: number,
  spread = false
): void {
  for (let i = 0; i < MOON_PARENTS.length; i++) {
    const parent = MOON_PARENTS[i]
    const target = SYSTEM_EXPANSION_MAX * expansionTarget(focus, distance, parent, earthRadius, spread)
    const eased = stepExpansion(moonExpansion(parent), target, dt, reducedMotion)
    setMoonExpansion(parent, Math.min(eased, expansionCap(parent, t)))
  }
}

/** Every parent back to the compact map. */
export function resetMoonExpansions(): void {
  for (let i = 0; i < MOON_PARENTS.length; i++) setMoonExpansion(MOON_PARENTS[i], 0)
}
