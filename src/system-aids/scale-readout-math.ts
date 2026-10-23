// What the scale readout says (tides-2hv.10), kept apart from the DOM so it
// can be tested.
//
// The system view has no one scale. Directions from the Sun are true and
// only distances are squeezed (planets.ts' sceneDistance, f(r)), so along a
// planet's orbit, around the Sun, a unit is r / f(r) of true distance, but
// across orbits, out from the Sun, it is 1 / f′(r): at Jupiter the two
// differ by ~1.8×, at Neptune by ~3.6×. The moons have scales of their own
// (moons.ts' log map; Earth's Moon at 38 440 km a unit). So the bar is
// honest about where it holds: it measures along one body's orbit, the
// focused body's (Earth's when the camera is on the Sun, the clock or a
// location), and says so: "at Jupiter's orbit · gaps between orbits are
// squeezed".

import * as THREE from 'three'
import { KM_PER_AU } from 'astronomy-engine'
import { positionsFor } from '../flight-scale'
import { isMoonKey, moonOrbitRadius, moonTrueOffsetKm, type MoonKey } from '../moons/moons'
import type { PlanetKey } from '../planets'
import type { CameraFocus } from '../store'
import { bodyName, formatDistance, trueBodies } from '../ship/ship-distances'

/** A body whose orbit the bar can measure along. */
export type ScaleReference = 'earth' | 'moon' | PlanetKey | MoonKey

/** The body the bar measures along with the camera on `focus`. */
export function scaleReference(focus: CameraFocus): ScaleReference {
  return focus === 'sun' || focus === 'clock' || focus === 'location' ? 'earth' : focus
}

const offset = new THREE.Vector3()

/**
 * km a scene unit stands for along `key`'s orbit at t, epoch ms, in the
 * system view: its true distance from what it orbits over its scene distance
 * (the Sun for Earth and the planets, Earth for the Moon, the parent for a
 * major moon).
 */
export function kmPerUnit(key: ScaleReference, t: number): number {
  if (isMoonKey(key)) return moonTrueOffsetKm(key, t, offset).length() / moonOrbitRadius(key)
  const centre = key === 'moon' ? 'earth' : 'sun'
  const truth = trueBodies([key, centre], t)
  const { positionAt } = positionsFor('system')
  // positionAt's arrays are reused, so read one before asking for the other.
  const [x, y, z] = positionAt[key](t)
  const [cx, cy, cz] = positionAt[centre](t)
  return truth.positions[0].distanceTo(truth.positions[1]) / Math.hypot(x - cx, y - cy, z - cz)
}

/**
 * The scale bar's longest length in CSS px. [TUNE] Its length steps 1, 2, 5,
 * so it runs from 40% of this up to all of it as the zoom changes.
 */
export const SCALE_BAR_MAX_PX = 120

// Under a tenth of an AU the bar counts in km, as formatDistance does.
const AU_FROM = 0.1 * KM_PER_AU

// The largest 1, 2 or 5 × 10ⁿ at or under x.
function niceFloor(x: number): number {
  const power = 10 ** Math.floor(Math.log10(x))
  // Leeway for 0.5 / 0.1 and the like landing a hair under a step.
  const m = (x / power) * (1 + 1e-9)
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * power
}

/**
 * The scale bar's length, km: the largest round length (1, 2 or 5 × 10ⁿ km,
 * or of AU from 0.1 AU) that fits in `maxPx` at `kmPerPx`. formatDistance
 * reads it as "2 AU" or "500,000 km".
 */
export function niceScaleBarKm(kmPerPx: number, maxPx = SCALE_BAR_MAX_PX): number {
  const maxKm = kmPerPx * maxPx
  return maxKm >= AU_FROM ? niceFloor(maxKm / KM_PER_AU) * KM_PER_AU : niceFloor(maxKm)
}

function possessive(key: ScaleReference): string {
  return key === 'moon' ? "the Moon's" : `${bodyName(key)}'s`
}

/** Where the bar holds, and that it holds only there. */
export function scaleCaption(key: ScaleReference): string {
  return `${scaleCaptionShort(key)} · gaps between orbits are squeezed`
}

/** scaleCaption's first half, for a short view where the readout is one line. */
export function scaleCaptionShort(key: ScaleReference): string {
  return `at ${possessive(key)} orbit`
}

/** The focused body other than Earth, whose distance from Earth the readout gives; else null. */
export function distanceTarget(focus: CameraFocus): Exclude<CameraFocus, 'earth' | 'clock' | 'location'> | null {
  return focus === 'earth' || focus === 'clock' || focus === 'location' ? null : focus
}

/** True centre-to-centre distance from Earth to `key` at t, km. */
export function distanceFromEarthKm(key: string, t: number): number {
  const { positions } = trueBodies(['earth', key], t)
  return positions[0].distanceTo(positions[1])
}

/** "Jupiter · 5.21 AU from Earth" */
export function distanceLine(key: string, km: number): string {
  return `${bodyName(key)} · ${formatDistance(km)} from Earth`
}
