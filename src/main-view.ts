import { MathUtils } from 'three'
import { isSystemFocus, type BodyFocus, type CameraFocus } from './store'
import { bodyRadius } from './system-aids/label-visibility'

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
  if (!showPlanets) return { maxDistance: Infinity, starRadius: undefined }
  return { maxDistance: systemFitDistance(view), starRadius: PLANETS_STAR_RADIUS }
}

/**
 * How close the eye comes to a focused body's centre, as a share of its
 * radius: tilted to MAX_TILT about the ground (pivot.ts) it still ends ~1.115
 * radii out, outside Earth's atmosphere and aurora shells.
 */
export const MIN_DISTANCE_FACTOR = 1.35

// Twice orbit-label.tsx's CLOCK_HALF_WIDTH, so the eye never enters the clock.
const CLOCK_MIN_DISTANCE = 16

/** OrbitControls' minDistance for `focus`. 'location' targets Earth's surface. */
export function minDistance(focus: CameraFocus): number {
  if (focus === 'clock') return CLOCK_MIN_DISTANCE
  if (focus === 'location') return bodyRadius('earth') * (1 + MIN_DISTANCE_FACTOR)
  return bodyRadius(focus) * MIN_DISTANCE_FACTOR
}

/** How far past the Sun the farthest drawn thing (the Kuiper belt's edge, 514) reaches. */
export const SYSTEM_EXTENT = 520

const NEAR_SHARE = 0.5
const NEAR_MIN = 0.01
const NEAR_MAX = 10

/**
 * The main view's near and far planes for an eye `surface` from the nearest
 * thing it must not cut and `eyeFromSun` from the Sun. Near goes halfway to
 * that surface, so no body is cut, but no further than NEAR_MAX, so the
 * orbits and belts it doesn't measure are only cut right at the eye; NEAR_MIN
 * keeps the depth buffer usable as a small moon sweeps past the eye. Far
 * reaches past the whole system and the starfield.
 */
export function mainNearFar(
  surface: number,
  eyeFromSun: number
): { near: number; far: number } {
  return {
    near: MathUtils.clamp(NEAR_SHARE * surface, NEAR_MIN, NEAR_MAX),
    far: Math.max(eyeFromSun + SYSTEM_EXTENT, 1.1 * PLANETS_STAR_RADIUS),
  }
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
