import { MathUtils } from 'three'
import { isSystemFocus, type BodyFocus } from './store'

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

/** Zooming out no further than this keeps the starfield's edge off screen. */
export const PLANETS_MIN_ZOOM = 1

/**
 * Main view zoom floor and starfield size. With planets on, the stars sit
 * beyond every body planetsNear lets through (see main-view.test.ts). Off,
 * these are the values the view always had (minZoom is OrbitControls'
 * default, and an undefined starRadius keeps Starfield's).
 */
export function mainViewRange(showPlanets: boolean): {
  minZoom: number
  starRadius: number | undefined
} {
  return showPlanets
    ? { minZoom: PLANETS_MIN_ZOOM, starRadius: 1500 }
    : { minZoom: 0, starRadius: undefined }
}

/**
 * How far in front of the target the main view draws at `zoom`: 800 units
 * once zoomed out to the whole system (bodies sit within ~360 of the Sun, so
 * two are at most ~720 apart), shrinking with the square of the zoom so that
 * from zoom ~3.2 in, i.e. at every planet's framing, it is inside the eye.
 */
export function planetsDrawDepth(zoom: number): number {
  return 800 / Math.max(zoom, PLANETS_MIN_ZOOM) ** 2
}

/**
 * The ortho near plane with planets on, for an eye `eyeDistance` behind the
 * target. Never past the eye up close, so a planet behind the eye (an ortho
 * camera would draw it over the target) stays hidden, as Earth's neighbours
 * always were; zoomed out it reaches back to take in the whole system, which
 * is the same picture as pulling the eye back that far.
 */
export function planetsNear(zoom: number, eyeDistance: number): number {
  return Math.min(0, eyeDistance - planetsDrawDepth(zoom))
}

/** A body's centre depth in front of the eye and how far it reaches from it. */
export interface BodyDepth {
  depth: number
  reach: number
}

/**
 * Moves `near` forward past every body it would cut, so each is drawn whole
 * or not at all (tides-o63): as planetsNear sweeps back through the system
 * with the zoom, a body it passed through showed sliced open. Bodies reaching
 * past `limit` (the target's depth) are left alone, so the focused body is
 * never the one hidden.
 */
export function clearNear(
  near: number,
  bodies: readonly BodyDepth[],
  limit: number
): number {
  // Each move lands on a far side, so no body can stop the plane twice.
  for (let moved = true; moved; ) {
    moved = false
    for (const { depth, reach } of bodies) {
      const back = depth - reach
      const front = depth + reach
      if (back < near && near < front && front <= limit) {
        near = front
        moved = true
      }
    }
  }
  return near
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
