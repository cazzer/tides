import * as THREE from 'three'
import { SURFACE_FOV } from './sky'

const DEG = Math.PI / 180

// Where View from Earth looks, in degrees: azimuth from north through east,
// altitude above the horizon. The store holds null until the user drags, so
// the view follows surfaceView(lat) (facing the equator) by default.
export interface SkyLook {
  azimuth: number
  altitude: number
}

// A little below the horizon, so the hills stay in reach, up to the zenith.
export const LOOK_MIN_ALTITUDE = -5
export const LOOK_MAX_ALTITUDE = 90

// Pointer travel (px) before a press becomes a drag; shorter is a tap.
export const DRAG_THRESHOLD = 5

// Two taps this close in time (ms; the usual OS double-click setting) and
// space (px) reset the view. A tap does nothing else here, so a generous
// window costs nothing.
export const DOUBLE_TAP_MS = 500
export const DOUBLE_TAP_DISTANCE = 30

// How long the reset eases back to the default view, in ms.
export const RESET_DURATION = 400

export function clampLook({ azimuth, altitude }: SkyLook): SkyLook {
  return {
    azimuth: THREE.MathUtils.euclideanModulo(azimuth, 360),
    altitude: THREE.MathUtils.clamp(altitude, LOOK_MIN_ALTITUDE, LOOK_MAX_ALTITUDE),
  }
}

// Above this altitude a sideways drag stops keeping up with the pointer.
const GRAB_TURN_LIMIT = 60

// Grabbing the sky: it follows the pointer, so dragging right turns the view
// left and dragging down looks up. The scale is the view's at its centre,
// where a pixel spans 2 tan(fov/2) / height radians. Turning the heading
// moves the centre of view only cos(altitude) as far, so sideways drags turn
// faster as the view looks up; toward the zenith, where no turn could keep up,
// that stops at GRAB_TURN_LIMIT rather than spinning the sky. `fov` is the
// view's current vertical field of view, narrower when zoomed in.
export function dragLook(
  look: SkyLook,
  dx: number,
  dy: number,
  height: number,
  fov = SURFACE_FOV
): SkyLook {
  const perPixel = (2 * Math.tan((fov / 2) * DEG)) / height / DEG
  const tilt = Math.min(Math.abs(look.altitude), GRAB_TURN_LIMIT) * DEG
  return clampLook({
    azimuth: look.azimuth - (dx * perPixel) / Math.cos(tilt),
    altitude: look.altitude + dy * perPixel,
  })
}

// Smoothstep from `from` to `to` at progress t (0..1), turning the short way.
export function easeLook(from: SkyLook, to: SkyLook, t: number): SkyLook {
  const k = THREE.MathUtils.smoothstep(t, 0, 1)
  const turn = THREE.MathUtils.euclideanModulo(to.azimuth - from.azimuth + 180, 360) - 180
  return clampLook({
    azimuth: from.azimuth + turn * k,
    altitude: from.altitude + (to.altitude - from.altitude) * k,
  })
}
