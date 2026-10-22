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
// "resolvable" gate (and the main view's near plane, camera.tsx).
export function systemExtent(system: LabelSystem): number {
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
// Saturn's. resolveLabels walks the names in priority order (the focused
// body, then LABEL_KEYS' order), and each takes the first side of its body
// (out, along the orbit either way, in) that is on screen and clear of the
// names already placed, of every body's globe, of the clock and of the AU
// rings' labels, or fades out where none is. The focused body's name shows
// wherever it lands.

/**
 * Hysteresis on a collision, CSS px: a shown name keeps showing until it
 * overlaps by this much, and a hidden one waits until it is this far clear,
 * so two names grazing as the bodies move don't flicker. [TUNE]
 */
export const LABEL_COLLISION_PAD_PX = 2

/** The least space between two names, CSS px, before the hysteresis pad. [TUNE] */
export const LABEL_SPACING_PX = 4

/** The least space between a name and the view's edge, CSS px. [TUNE] */
export const LABEL_EDGE_PX = 4

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

/**
 * Every name's inputs and results for resolveLabels: parallel arrays, one
 * slot per name in priority order (LABEL_KEYS'), in CSS px along the
 * camera's right and up axes. Filled in place each frame, so the per-frame
 * path allocates nothing; `side` and `shown` carry over between frames.
 */
export interface LabelLayout {
  n: number
  // Inputs, per name.
  /** The body's globe on screen: centre and radius. */
  discX: Float64Array
  discY: Float64Array
  discR: Float64Array
  /** Toward the camera, any unit: larger is nearer. */
  nearness: Float64Array
  /** 1 between the camera's near and far planes. */
  inView: Uint8Array
  /** The opacity the zoom asks for (labelOpacity); under MIN_NAME_OPACITY, no name. */
  wanted: Float64Array
  /** The name's half sizes. */
  halfW: Float64Array
  halfH: Float64Array
  /** The default side, a unit vector: away from what the body orbits. */
  dirX: Float64Array
  dirY: Float64Array
  /** 1 for a name turned off headings toward the Sun (steerClearOfSun), with (awayX, awayY) the unit direction from the Sun. */
  steer: Uint8Array
  awayX: Float64Array
  awayY: Float64Array
  // Fixed boxes (the AU rings' labels) that the names below the frame's
  // obstacleRank keep off.
  obstacleCount: number
  obstacleX: Float64Array
  obstacleY: Float64Array
  obstacleHalfW: Float64Array
  obstacleHalfH: Float64Array
  // Fixed discs (the clock's text) that every name keeps off.
  blockerCount: number
  blockerX: Float64Array
  blockerY: Float64Array
  blockerR: Float64Array
  // Results, per name.
  /** Which of LABEL_SIDES it is on. */
  side: Int8Array
  /** Its direction from the body's centre (unit), and how far its centre is, px. */
  outX: Float64Array
  outY: Float64Array
  distance: Float64Array
  /** Its box centre. */
  boxX: Float64Array
  boxY: Float64Array
  /** How far it is shown past collisions, 0 to 1, eased; opacity is wanted × shown. */
  shown: Float64Array
  /** Scratch: the names placed so far this frame. */
  kept: Int32Array
}

export function createLabelLayout(n: number, obstacles: number, blockers = 0): LabelLayout {
  const f = () => new Float64Array(n)
  const o = () => new Float64Array(obstacles)
  const b = () => new Float64Array(blockers)
  return {
    n,
    discX: f(),
    discY: f(),
    discR: f(),
    nearness: f(),
    inView: new Uint8Array(n),
    wanted: f(),
    halfW: f(),
    halfH: f(),
    dirX: f(),
    dirY: f(),
    steer: new Uint8Array(n),
    awayX: f(),
    awayY: f(),
    obstacleCount: 0,
    obstacleX: o(),
    obstacleY: o(),
    obstacleHalfW: o(),
    obstacleHalfH: o(),
    blockerCount: 0,
    blockerX: b(),
    blockerY: b(),
    blockerR: b(),
    side: new Int8Array(n),
    outX: f(),
    outY: f(),
    distance: f(),
    boxX: f(),
    boxY: f(),
    shown: f(),
    kept: new Int32Array(n),
  }
}

/** One frame's settings for resolveLabels. */
export interface LabelFrame {
  /** The focused body's name's index, or -1: placed first, and always shown. */
  focus: number
  /** Names past this index (and not focused) keep off the obstacles. */
  obstacleRank: number
  /** The view's edges, px, in the layout's axes. */
  left: number
  right: number
  bottom: number
  top: number
  /** Seconds since the last frame, for the fades. */
  delta: number
  /** Gap between a body's edge and its name, px. */
  gapPx: number
  /** How far body i reaches from its centre along (dirX, dirY), px (bodyReach / upp). */
  reach(i: number, dirX: number, dirY: number): number
}

/** Below this a name is skipped altogether rather than drawn invisible. */
export const MIN_NAME_OPACITY = 0.01

// The sides a name tries, in turn, as quarter turns from its default: out
// from what the body orbits, then either way along the orbit, then inward.
// [cos, sin] of each turn.
const LABEL_SIDES: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [0, -1],
  [-1, 0],
]

const turned: ScreenDirection = { x: 0, y: 0 }

function rankOf(i: number, focus: number): number {
  return i === focus ? -1 : i
}

// Put name i on side `s`.
function placeOnSide(layout: LabelLayout, frame: LabelFrame, i: number, s: number) {
  const [c, sn] = LABEL_SIDES[s]
  turned.x = layout.dirX[i] * c - layout.dirY[i] * sn
  turned.y = layout.dirX[i] * sn + layout.dirY[i] * c
  if (layout.steer[i]) steerClearOfSun(turned, layout.awayX[i], layout.awayY[i])
  const distance = labelDistancePx(
    turned.x,
    turned.y,
    frame.reach(i, turned.x, turned.y),
    layout.halfW[i],
    layout.halfH[i],
    frame.gapPx
  )
  layout.outX[i] = turned.x
  layout.outY[i] = turned.y
  layout.distance[i] = distance
  layout.boxX[i] = layout.discX[i] + turned.x * distance
  layout.boxY[i] = layout.discY[i] + turned.y * distance
}

/**
 * Whether body i is out of sight behind a larger, nearer globe (its name
 * goes with it): depth, not priority, decides.
 */
export function eclipsed(layout: LabelLayout, i: number): boolean {
  const { discX, discY, discR, nearness, inView } = layout
  for (let j = 0; j < layout.n; j++) {
    if (
      j !== i &&
      inView[j] &&
      nearness[j] > nearness[i] &&
      discR[j] > discR[i] &&
      Math.hypot(discX[i] - discX[j], discY[i] - discY[j]) < discR[j]
    ) {
      return true
    }
  }
  return false
}

// Whether name i, where it is now, runs off the view or covers a placed
// name, an obstacle it doesn't outrank, or any other body's globe, with its
// box grown by `pad` px.
function collides(layout: LabelLayout, frame: LabelFrame, i: number, keptCount: number, pad: number): boolean {
  const { boxX, boxY, halfW, halfH, kept } = layout
  const w = halfW[i] + pad
  const h = halfH[i] + pad
  const x = boxX[i]
  const y = boxY[i]
  if (
    x - w < frame.left + LABEL_EDGE_PX ||
    x + w > frame.right - LABEL_EDGE_PX ||
    y - h < frame.bottom + LABEL_EDGE_PX ||
    y + h > frame.top - LABEL_EDGE_PX
  ) {
    return true
  }
  // Names keep a space between them, so two never read as one word.
  const spacedW = w + LABEL_SPACING_PX
  const spacedH = h + LABEL_SPACING_PX
  for (let k = 0; k < keptCount; k++) {
    const j = kept[k]
    if (boxesOverlap(x, y, spacedW, spacedH, boxX[j], boxY[j], halfW[j], halfH[j])) return true
  }
  if (rankOf(i, frame.focus) > frame.obstacleRank) {
    for (let r = 0; r < layout.obstacleCount; r++) {
      if (
        boxesOverlap(x, y, spacedW, spacedH, layout.obstacleX[r], layout.obstacleY[r], layout.obstacleHalfW[r], layout.obstacleHalfH[r])
      ) {
        return true
      }
    }
  }
  for (let b = 0; b < layout.blockerCount; b++) {
    if (boxHitsDisc(x, y, w, h, layout.blockerX[b], layout.blockerY[b], layout.blockerR[b])) return true
  }
  const { discX, discY, discR, inView } = layout
  for (let j = 0; j < layout.n; j++) {
    if (j !== i && inView[j] && discR[j] >= MIN_BLOCKING_DISC_PX && boxHitsDisc(x, y, w, h, discX[j], discY[j], discR[j])) {
      return true
    }
  }
  return false
}

/**
 * Place every name (see Collisions, above): fills each name's side, box and
 * direction, and eases `shown` toward 1 where it fits, 0 where it doesn't.
 * A name keeps last frame's side while that stays clear, so it doesn't hop.
 */
export function resolveLabels(layout: LabelLayout, frame: LabelFrame): void {
  const { n, wanted, shown, side, kept } = layout
  const step = frame.delta / LABEL_COLLISION_FADE_S
  let keptCount = 0
  for (let k = -1; k < n; k++) {
    const i = k < 0 ? frame.focus : k
    if (i < 0 || (k >= 0 && i === frame.focus)) continue
    const focused = i === frame.focus
    let target = 0
    if (wanted[i] >= MIN_NAME_OPACITY && (focused || !eclipsed(layout, i))) {
      // The default side first, so a name goes back to it once it's free;
      // then the side it is on, so it doesn't hop between the others. It
      // stays where it is (if shown) until that is overlapped by the pad,
      // and moves only to a side clear by the pad.
      const was = side[i]
      const staying = shown[i] > 0.5
      let clear = false
      for (let tried = -2; tried < LABEL_SIDES.length && !clear; tried++) {
        const s = tried === -2 ? 0 : tried === -1 ? was : tried
        if ((tried === -1 && was === 0) || (tried >= 0 && (s === 0 || s === was))) continue
        placeOnSide(layout, frame, i, s)
        const pad = staying && s === was ? -LABEL_COLLISION_PAD_PX : LABEL_COLLISION_PAD_PX
        if (!collides(layout, frame, i, keptCount, pad)) {
          clear = true
          side[i] = s
        }
      }
      if (!clear) placeOnSide(layout, frame, i, was)
      if (clear || focused) {
        target = 1
        kept[keptCount++] = i
      }
    }
    shown[i] = target > shown[i] ? Math.min(target, shown[i] + step) : Math.max(target, shown[i] - step)
  }
}
