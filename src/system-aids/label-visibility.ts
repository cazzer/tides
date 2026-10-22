// When and where a body's name shows in the system view (tides-2hv.10).
// BodyLabels runs these every frame, so they are pure and allocation-free.
//
// The metric is scene units per CSS pixel (upp), the ortho main view's
// "camera distance": 1 zoomed all the way out, 0.1 at the default zoom, and
// ~0.2 with Jupiter or Saturn framed. A label shows when, at the current upp:
//
//   - its orbit is clear of its neighbours' (labelClearance) by enough
//     pixels that two names can't stack, so Mercury and Venus come in as
//     the inner system opens up, and Saturn's Titan, Iapetus and Rhea before
//     Enceladus;
//   - for a moon, its whole system is resolvable: the outermost orbit spans
//     enough pixels to tell the moons apart from the planet;
//   - outside the focused body's system, the focused body is not zoomed so
//     far in that the others are off in the distance (or off screen).
//
// The focused body's own name always shows. Where bodies still line up on
// screen (a conjunction, a moon passing its planet), the lower-priority name
// gives way (Collisions, below).

import * as THREE from 'three'
import { PLANETS, PLANET_KEYS, sceneDistance, sceneRadius, type PlanetKey } from '../planets'
import {
  MOONS,
  MOON_KEYS,
  isMoonKey,
  moonOrbitRadius,
  moonRadius,
  moonSystemExtent,
  moonsOf,
  type MoonKey,
} from '../moons/moons'
import { EARTH_ORBIT_RADIUS, MOON_UNITS_PER_KM } from '../ephemeris'
import type { CameraFocus } from '../store'

export type LabelKey = 'sun' | 'earth' | 'moon' | PlanetKey | MoonKey

/**
 * Every labelled body, in priority order when names collide: the Sun, Earth,
 * the Moon, the planets outward, then the major moons largest first (Titan's
 * name beats Rhea's).
 */
export const LABEL_KEYS: readonly LabelKey[] = [
  'sun',
  'earth',
  'moon',
  ...PLANET_KEYS,
  ...[...MOON_KEYS].sort((a, b) => MOONS[b].radiusKm - MOONS[a].radiusKm),
]

/** A moon of any planet, Earth's included: lettered smaller, gated on its system. */
export function isLabelMoon(key: LabelKey): boolean {
  return key === 'moon' || isMoonKey(key)
}

/**
 * Pixels of clearance (labelClearance / upp) over which a name fades in.
 * [TUNE] A name is ~12 px tall, so planets wait until their orbit's gap is
 * past that: Venus (15 units from Earth's orbit) comes in from zoom ~1 to
 * ~1.9, Mercury (7.6 from the Sun's surface) from ~1.9 to ~3.7.
 */
export const PLANET_CLEARANCE_PX: readonly [number, number] = [14, 28]
/**
 * As PLANET_CLEARANCE_PX for moons. [TUNE] Tighter, so the four Galileans
 * (~14 px apart) are all named when Jupiter is framed, and Titan, Iapetus
 * and Rhea are when Saturn is, ahead of Dione, Tethys, Enceladus and Mimas
 * (~5 px apart there).
 */
export const MOON_CLEARANCE_PX: readonly [number, number] = [6, 12]
/**
 * Radius of a moon's system on screen (its outermost orbit), px, over which
 * its moons' names fade in. [TUNE] Earth's Moon comes in from zoom ~1.8
 * to ~3.6, the Galileans once Jupiter's system is ~40 px across, and Triton
 * (a small system, ~8 units) is named with Neptune framed.
 */
export const MOON_SYSTEM_PX: readonly [number, number] = [20, 40]
/**
 * The focused body's radius on screen, px, over which names outside its
 * system fade out. [TUNE] Framing puts every body at ~30 px (Earth's size at
 * the default zoom, main-view.ts), so the others go from twice that zoom in
 * and are gone by four times.
 */
export const FAR_IN_PX: readonly [number, number] = [60, 120]

const SUN_RADIUS = sceneRadius(1_392_700_000)
const EARTH_RADIUS = sceneRadius(12_742_000)
const MOON_RADIUS = sceneRadius(3_474_800)
/** The Moon's mean distance from Earth's centre, scene units (~10). */
const MOON_ORBIT = 384_400 * MOON_UNITS_PER_KM

/** Which body's system a label belongs to: its own, its parent's, or the Sun's. */
export type LabelSystem = 'sun' | 'earth' | PlanetKey

export function labelSystem(key: LabelKey): LabelSystem {
  if (key === 'moon') return 'earth'
  if (isMoonKey(key)) return MOONS[key].parent
  return key
}

/**
 * The body a focus is on: the clock and a location sit on Earth's orbit and
 * surface, so they count as Earth.
 */
export function focusBody(focus: CameraFocus): LabelKey {
  return focus === 'clock' || focus === 'location' ? 'earth' : focus
}

/** The body's sphere radius, scene units: what framing sizes it by. */
export function bodyRadius(key: LabelKey): number {
  if (key === 'sun') return SUN_RADIUS
  if (key === 'earth') return EARTH_RADIUS
  if (key === 'moon') return MOON_RADIUS
  if (isMoonKey(key)) return moonRadius(key)
  return PLANETS[key].radius
}

/**
 * How far the body reaches from its centre along a screen direction, scene
 * units: its sphere, or Saturn's and Uranus' rings where they stick out
 * further. A ring of radius R seen at an angle reaches R·√(1 − c²) along a
 * direction at cosine c to its pole: all of R face-on, nothing edge-on
 * straight across it. `poleAlong` is that c (0, the full ring, if unknown).
 */
export function bodyReach(key: LabelKey, poleAlong = 0): number {
  const radius = bodyRadius(key)
  if (key === 'sun' || key === 'earth' || key === 'moon' || isMoonKey(key)) return radius
  const outer = PLANETS[key].rings?.outer
  if (outer === undefined) return radius
  return Math.max(radius, radius * outer * Math.sqrt(Math.max(0, 1 - poleAlong * poleAlong)))
}

// Mean orbit radius, scene units, from the sidereal period (Kepler's third
// law): eccentric orbits wander, but the gap between neighbours is what sets
// how crowded their names get.
function planetOrbit(key: PlanetKey): number {
  return sceneDistance((PLANETS[key].period / 365.256) ** (2 / 3))
}

// The gap to the nearest neighbouring orbit in an ordered list of radii.
// `inner` is what the first is measured against (the Sun's surface for
// Mercury); without it the first counts only its outer neighbour, since its
// label goes outward, away from what it orbits.
function gaps(radii: readonly number[], inner?: number): number[] {
  return radii.map((r, i) => {
    const below = i > 0 ? r - radii[i - 1] : inner === undefined ? Infinity : r - inner
    const above = i < radii.length - 1 ? radii[i + 1] - r : Infinity
    return Math.min(below, above)
  })
}

// The Sun and Earth have no clearance limit: the Sun's name sits above it,
// clear of every orbit, and Earth is the app's subject, named at every zoom
// (Venus' name gives way to it instead).
const CLEARANCE: Readonly<Record<LabelKey, number>> = (() => {
  const planetOrder: readonly (PlanetKey | 'earth')[] = [
    'mercury',
    'venus',
    'earth',
    ...PLANET_KEYS.slice(2),
  ]
  const radii = planetOrder.map((key) => (key === 'earth' ? EARTH_ORBIT_RADIUS : planetOrbit(key)))
  const planetGaps = gaps(radii, SUN_RADIUS)
  const table: Partial<Record<LabelKey, number>> = {
    sun: Infinity,
    earth: Infinity,
    moon: MOON_ORBIT - EARTH_RADIUS,
  }
  planetOrder.forEach((key, i) => {
    if (key !== 'earth') table[key] = planetGaps[i]
  })
  for (const parent of ['mars', 'jupiter', 'saturn', 'uranus', 'neptune'] as const) {
    const keys = moonsOf(parent)
    const moonGaps = gaps(keys.map(moonOrbitRadius))
    keys.forEach((key, i) => {
      table[key] = moonGaps[i]
    })
  }
  return table as Record<LabelKey, number>
})()

/**
 * How far the body's orbit is from its neighbours', scene units: the
 * smallest gap to the next orbit in or out around the same parent (or the
 * Sun's surface for Mercury, Earth's for the Moon). Infinity where nothing
 * crowds it.
 */
export function labelClearance(key: LabelKey): number {
  return CLEARANCE[key]
}

// How far out a system's outermost body reaches, scene units, for the
// "resolvable" gate.
function systemExtent(system: LabelSystem): number {
  if (system === 'earth') return MOON_ORBIT + MOON_RADIUS
  if (system === 'sun' || system === 'mercury' || system === 'venus') return 0
  return moonSystemExtent(system)
}

/**
 * The label's opacity, 0 to 1, at `upp` scene units per CSS pixel with the
 * camera on `focus` (see the header).
 */
export function labelOpacity(key: LabelKey, upp: number, focus: CameraFocus): number {
  const focused = focusBody(focus)
  if (key === focused) return 1
  const [clearFrom, clearTo] = isLabelMoon(key) ? MOON_CLEARANCE_PX : PLANET_CLEARANCE_PX
  let opacity = THREE.MathUtils.smoothstep(labelClearance(key) / upp, clearFrom, clearTo)
  const system = labelSystem(key)
  if (isLabelMoon(key)) {
    opacity *= THREE.MathUtils.smoothstep(systemExtent(system) / upp, ...MOON_SYSTEM_PX)
  }
  // Everything orbits the Sun, so with the camera on it nothing is "another
  // body's" system.
  if (focused !== 'sun' && system !== labelSystem(focused)) {
    opacity *= 1 - THREE.MathUtils.smoothstep(bodyRadius(focused) / upp, ...FAR_IN_PX)
  }
  return opacity
}

/**
 * How far from the body's centre, px, to put the centre of a label
 * `halfWidth` × `halfHeight` px in screen direction (dirX, dirY), a unit
 * vector, so it clears a disc `bodyPx` in radius by `gapPx`.
 * The box's reach along the direction is |dirX|·halfWidth + |dirY|·halfHeight,
 * exact on the axes and generous (by up to √2) on the diagonals.
 */
export function labelDistancePx(
  dirX: number,
  dirY: number,
  bodyPx: number,
  halfWidth: number,
  halfHeight: number,
  gapPx: number
): number {
  return bodyPx + gapPx + Math.abs(dirX) * halfWidth + Math.abs(dirY) * halfHeight
}

/** A screen direction, written in place to keep the per-frame path allocation-free. */
export interface ScreenDirection {
  x: number
  y: number
}

/**
 * Normalise (x, y), a body's offset from what it orbits on screen, into
 * `out`. Straight up where the offset is (near) zero: the Sun, or a body
 * right in front of or behind its parent. Up rather than down because the
 * AU ring labels (EclipticGrid) run down the screen from the Sun in the
 * starting view.
 */
export function labelDirection(x: number, y: number, out: ScreenDirection): ScreenDirection {
  const length = Math.hypot(x, y)
  if (length < 1e-9) {
    out.x = 0
    out.y = 1
  } else {
    out.x = x / length
    out.y = y / length
  }
  return out
}

/**
 * Turn `dir` (unit, written in place) off any heading toward the Sun, given
 * (awayX, awayY), the unit screen direction from the Sun to the body. For
 * the Moon: away from Earth would put its name inward at new moon, across
 * the clock and month names on the Sun side of Earth's orbit, so the
 * sunward part is dropped, leaving it beside the Moon, along the orbit.
 */
export function steerClearOfSun(dir: ScreenDirection, awayX: number, awayY: number): ScreenDirection {
  const toward = dir.x * awayX + dir.y * awayY
  if (toward >= 0) return dir
  const x = dir.x - toward * awayX
  const y = dir.y - toward * awayY
  const length = Math.hypot(x, y)
  if (length < 1e-6) {
    // Dead on the Sun–Earth line: either side along the orbit will do.
    dir.x = -awayY
    dir.y = awayX
  } else {
    dir.x = x / length
    dir.y = y / length
  }
  return dir
}

// --- Collisions ----------------------------------------------------------
//
// Names placed outward from the Sun still meet where bodies line up on
// screen: Venus' name lands on Earth at inferior conjunction, Iapetus' on
// Saturn's. BodyLabels walks the names in priority order (the focused body,
// then LABEL_KEYS' order), and each takes the first side of its body (out,
// along the orbit either way, in) clear of higher-priority names and bodies
// and of the AU rings' labels, or fades out where none is.

/**
 * Hysteresis on a collision, CSS px: a shown name keeps showing until it
 * overlaps by this much, and a hidden one waits until it is this far clear,
 * so two names grazing as the bodies move don't flicker. [TUNE]
 */
export const LABEL_COLLISION_PAD_PX = 2

/** The least space between two names, CSS px, before the hysteresis pad. [TUNE] */
export const LABEL_SPACING_PX = 4

/**
 * A body's disc smaller than this, px, doesn't push names aside: a moon's
 * dot under a name hides little, and would otherwise hide Titan's name
 * behind Rhea's unnamed speck. [TUNE]
 */
export const MIN_BLOCKING_DISC_PX = 3

/** Seconds a name takes to fade out of, or back from, a collision. [TUNE] */
export const LABEL_COLLISION_FADE_S = 0.25

/** Whether two centred boxes overlap, given their centres and half sizes. */
export function boxesOverlap(
  ax: number,
  ay: number,
  aHalfWidth: number,
  aHalfHeight: number,
  bx: number,
  by: number,
  bHalfWidth: number,
  bHalfHeight: number
): boolean {
  return Math.abs(ax - bx) < aHalfWidth + bHalfWidth && Math.abs(ay - by) < aHalfHeight + bHalfHeight
}

/** Whether a centred box overlaps a disc of `radius` at (x, y). */
export function boxHitsDisc(
  cx: number,
  cy: number,
  halfWidth: number,
  halfHeight: number,
  x: number,
  y: number,
  radius: number
): boolean {
  const dx = Math.max(Math.abs(cx - x) - halfWidth, 0)
  const dy = Math.max(Math.abs(cy - y) - halfHeight, 0)
  return dx * dx + dy * dy < radius * radius
}
