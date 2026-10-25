import { MathUtils, type Vector3 } from 'three'
import { CLOCK_HALF_WIDTH } from './clock-size'
import { isSystemFocus, type BodyFocus, type CameraFocus } from './store'
import {
  bodyRadius,
  bodyReach,
  type LabelKey,
} from './system-aids/label-visibility'

/** The main view's default zoom (App's MainCamera); Earth's framing at it is the reference. */
export const MAIN_ZOOM = 10

const PLANET_ZOOM_MIN = 1
const PLANET_ZOOM_MAX = 40

/** The zoom at which a planet of `radius` reads as large as Earth does at MAIN_ZOOM. */
export function planetFramingZoom(radius: number, earthRadius: number): number {
  return MathUtils.clamp(
    (MAIN_ZOOM * earthRadius) / radius,
    PLANET_ZOOM_MIN,
    PLANET_ZOOM_MAX
  )
}

/**
 * How far from the target the zoom floor frames, scene units: Neptune's
 * aphelion surface (456, planets.ts) seen from Earth (50 from the Sun, the
 * default target) on the far side, with room for its label.
 */
export const SYSTEM_FIT_RADIUS = 530

/** The starfield's radius in the main view with planets on. */
export const PLANETS_STAR_RADIUS = 1800

/** The main view's vertical field of view, degrees. */
export const MAIN_FOV = 30

const TAN_HALF_FOV = Math.tan(MathUtils.degToRad(MAIN_FOV / 2))

/** The view height, CSS px, at which a distance frames what the ortho view did at a zoom. */
export const REFERENCE_VIEW_HEIGHT = 800

/**
 * The eye distance at which the target reads as large as it did in the ortho
 * view at `zoom`, in a REFERENCE_VIEW_HEIGHT view. Taller or shorter views
 * keep the same share of their height, so a pose looks the same everywhere.
 */
export function zoomDistance(zoom: number): number {
  return REFERENCE_VIEW_HEIGHT / 2 / (TAN_HALF_FOV * zoom)
}

/** The main view's default eye distance (App's MainCamera, CLOCK_VIEW). */
export const MAIN_DISTANCE = zoomDistance(MAIN_ZOOM)

/** The eye distance at which a planet of `radius` reads as large as Earth does at MAIN_DISTANCE. */
export function framingDistance(radius: number, earthRadius: number): number {
  return zoomDistance(planetFramingZoom(radius, earthRadius))
}

/** Scene units per CSS px at `depth` in front of the eye, in a view `heightPx` tall. */
export function targetUnitsPerPixel(depth: number, heightPx: number): number {
  return (2 * depth * TAN_HALF_FOV) / heightPx
}

/** The main view's size in CSS pixels. */
export interface ViewSize {
  width: number
  height: number
}

/**
 * The eye distance at which a sphere of SYSTEM_FIT_RADIUS round the target
 * fits across the view's shorter side, however the view is turned.
 */
export function systemFitDistance(view: ViewSize): number {
  const tan = TAN_HALF_FOV * Math.min(1, view.width / view.height)
  return SYSTEM_FIT_RADIUS / Math.sin(Math.atan(tan))
}

/**
 * Main view zoom-out limit and starfield size. With planets on, the eye backs
 * off until the whole system fits (systemFitDistance), so a phone goes
 * further out than a desktop. Off, these are the values the view always had
 * (maxDistance is OrbitControls' default, and an undefined starRadius keeps
 * Starfield's).
 */
export function mainViewRange(
  showPlanets: boolean,
  view: ViewSize
): {
  maxDistance: number
  starRadius: number | undefined
} {
  return {
    maxDistance: maxDistance(showPlanets, view),
    starRadius: showPlanets ? PLANETS_STAR_RADIUS : undefined,
  }
}

/** mainViewRange's maxDistance, without the object. */
export function maxDistance(showPlanets: boolean, view: ViewSize): number {
  return showPlanets ? systemFitDistance(view) : Infinity
}

/**
 * How close the eye comes to a focused body's centre, as a share of its
 * reach (its radius, or its rings' for a ringed planet): tilted to MAX_TILT
 * about the ground (pivot.ts) it still ends ~1.115 radii out, outside Earth's
 * atmosphere and aurora shells.
 */
export const MIN_DISTANCE_FACTOR = 1.35

/**
 * OrbitControls' minDistance for `focus`. 'location' targets Earth's surface;
 * the clock's eye stays a whole clock's width away from the text's centre.
 */
export function minDistance(focus: CameraFocus): number {
  if (focus === 'clock') return 2 * CLOCK_HALF_WIDTH
  if (focus === 'location') return bodyRadius('earth') * (1 + MIN_DISTANCE_FACTOR)
  return bodyReach(focus) * MIN_DISTANCE_FACTOR
}

const DISTANCE_EASE = 0.05

/**
 * One frame of an eye-distance ease toward `goal`: 5% of the remaining ratio
 * (a lerp of the log), so the apparent size changes smoothly whichever way
 * and however far it has to go, landing on `goal` once within 0.1% of it.
 */
export function easeDistance(distance: number, goal: number): number {
  const next = distance * (goal / distance) ** DISTANCE_EASE
  return Math.abs(goal - next) < goal * 1e-3 ? goal : next
}

/** The part of OrbitControls stepEyeDistance drives. */
export interface Dolly {
  minDistance: number
  maxDistance: number
  getDistance(): number
  setScale(scale: number): void
}

/**
 * One frame of the main view's eye distance: eases it (easeDistance) toward
 * `framed`, or where it is if null, kept within [lo, hi], so a range that
 * changed (a new focus, the planets toggled, a resize) is eased into rather
 * than jumped to. OrbitControls' limits follow the eased distance, as they
 * would otherwise snap the eye there in one frame. Returns whether it has
 * landed on `framed`.
 */
export function stepEyeDistance(
  controls: Dolly,
  framed: number | null,
  lo: number,
  hi: number
): boolean {
  const distance = controls.getDistance()
  const goal = MathUtils.clamp(framed ?? distance, lo, hi)
  const next = easeDistance(distance, goal)
  controls.minDistance = Math.min(lo, next)
  controls.maxDistance = Math.max(hi, next)
  if (next !== distance) controls.setScale(next / distance)
  return framed !== null && next === goal
}

/**
 * Widens OrbitControls' limits to take in the eye distance as it is now, so
 * a target that moved without the eye (CameraProvider easing it onto a new
 * focus) isn't met by OrbitControls snapping the eye to its limits: the next
 * stepEyeDistance eases it back into range instead.
 */
export function allowDistance(controls: Dolly): void {
  const distance = controls.getDistance()
  controls.minDistance = Math.min(controls.minDistance, distance)
  controls.maxDistance = Math.max(controls.maxDistance, distance)
}

/** The body the eye rides along with, as it was last frame. */
export interface FollowAnchor {
  key: unknown
  position: Vector3
}

/**
 * Writes into `carry` how far the followed body (`key`, now at `position`)
 * moved since the last frame, for the eye to move with it. On the frame the
 * key changes, a new focus, it is zero: the eye stays put while the view
 * turns to the new body, so it never flies through anything on the way.
 */
export function followMotion(
  anchor: FollowAnchor,
  key: unknown,
  position: Vector3,
  carry: Vector3
): void {
  if (key !== null && key === anchor.key) {
    carry.subVectors(position, anchor.position)
  } else {
    carry.set(0, 0, 0)
  }
  anchor.key = key
  anchor.position.copy(position)
}

/** How far past a body's surface the near plane keeps clear: Earth's atmosphere and aurora shells. */
export const NEAR_CLEARANCE = 1.1

/** How far from its centre a body reaches for the near plane: its shells, or its rings. */
export function nearReach(key: LabelKey): number {
  return Math.max(NEAR_CLEARANCE * bodyRadius(key), bodyReach(key))
}

/** A body's centre and nearReach (the clock's: CLOCK_HALF_WIDTH), or a reach of 0 while it isn't there. */
export interface NearBody {
  centre: Vector3
  reach: number
}

/**
 * How far the eye is from the nearest thing the near plane must not cut: any
 * body's reach, or the target, which may be off every body.
 */
export function nearestSurface(
  eye: Vector3,
  target: Vector3,
  bodies: readonly NearBody[]
): number {
  let surface = eye.distanceTo(target)
  for (const { centre, reach } of bodies) {
    if (reach > 0) surface = Math.min(surface, eye.distanceTo(centre) - reach)
  }
  return surface
}

/** How far past the Sun the farthest drawn thing (the Kuiper belt's edge, 514) reaches. */
export const SYSTEM_EXTENT = 520

const NEAR_SHARE = 0.5
/** The closest the near plane comes to the eye. */
export const NEAR_MIN = 0.01
const NEAR_MAX = 10

/**
 * The main view's near and far planes, into `out`, for an eye `surface` from
 * the nearest thing it must not cut (nearestSurface) and `eyeFromSun` from
 * the Sun. Near goes halfway to that surface, so no body is cut, but no
 * further than NEAR_MAX, so the orbits and belts it doesn't measure are only
 * cut right at the eye. It never comes closer than NEAR_MIN, to keep the
 * depth buffer usable, so the one cut it allows is of a body whose reach
 * passes within 2 · NEAR_MIN of the eye (or through it): an inner moon
 * sweeping past an eye at the closest distance shows sliced for a frame or
 * two. Far reaches past the whole system and the starfield.
 */
export function mainNearFar(
  surface: number,
  eyeFromSun: number,
  out = { near: 0, far: 0 }
): { near: number; far: number } {
  out.near = MathUtils.clamp(NEAR_SHARE * surface, NEAR_MIN, NEAR_MAX)
  out.far = Math.max(eyeFromSun + SYSTEM_EXTENT, 1.1 * PLANETS_STAR_RADIUS)
  return out
}

/**
 * The store ref the camera follows for `focus` ('location' is placed
 * separately). A planet or moon that hasn't registered yet falls back to the Sun.
 */
export function focusedRef<R extends { current?: unknown }>(
  refs: Partial<Record<BodyFocus, R | undefined>>,
  focus: BodyFocus
): R | undefined {
  const ref = refs[focus]
  return isSystemFocus(focus) && !ref?.current ? refs.sun : ref
}
