import { MathUtils } from 'three'
import { isPlanetFocus, type BodyFocus } from './store'

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
 * Main view clipping and starfield size. Planets reach ~350 units from the Sun,
 * so with them on the ortho camera keeps everything up to 1000 units behind its
 * eye (near < 0) and the stars sit beyond the farthest planet while their back
 * hemisphere stays clipped. Off, these are the values the view always had
 * (far is three's default, minZoom OrbitControls', and an undefined
 * starRadius keeps Starfield's).
 */
export function mainViewRange(showPlanets: boolean): {
  near: number
  far: number
  minZoom: number
  starRadius: number | undefined
} {
  // minZoom keeps the starfield's edge (and its clipped back half) off screen.
  return showPlanets
    ? { near: -1000, far: 2000, minZoom: 1, starRadius: 1500 }
    : { near: 0, far: 2000, minZoom: 0, starRadius: undefined }
}

/**
 * The store ref the camera follows for `focus` ('location' is placed
 * separately). A planet that hasn't registered yet falls back to the Sun.
 */
export function focusedRef<R extends { current?: unknown }>(
  refs: Partial<Record<BodyFocus, R | undefined>>,
  focus: BodyFocus
): R | undefined {
  const ref = refs[focus]
  return isPlanetFocus(focus) && !ref?.current ? refs.sun : ref
}
