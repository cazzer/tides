import * as THREE from 'three'
import { SURFACE_FOV } from './sky'
import { LOOK_MAX_ALTITUDE, LOOK_MIN_ALTITUDE, clampLook, type SkyLook } from './sky-look'

const DEG = Math.PI / 180

// Pinch or wheel zoom in View from Earth (tides-2j7) narrows the surface
// camera's vertical field of view, in degrees, from the default 90° down to
// SKY_FOV_MIN. The store holds null until the user zooms.
export const SKY_FOV_MIN = 20
export const SKY_FOV_MAX = SURFACE_FOV

// How quickly a wheel zoom eases toward its target, in seconds: about two
// thirds of the way in this time, so a burst of wheel steps reads as one
// smooth zoom rather than a staircase.
export const GLIDE_TIME = 0.08

// A point on the panel, in px from its centre, y down.
export interface SkyPoint {
  dx: number
  dy: number
}

export function clampFov(fov: number) {
  return THREE.MathUtils.clamp(fov, SKY_FOV_MIN, SKY_FOV_MAX)
}

// Zoom works on tan(fov/2), the image scale: spreading the fingers to twice
// their distance shows the sky twice as big.
const zoomOf = (fov: number) => Math.log(Math.tan((fov / 2) * DEG))
const fovOf = (zoom: number) => (2 * Math.atan(Math.exp(zoom))) / DEG

export function pinchFov(startFov: number, startDistance: number, distance: number) {
  if (startDistance <= 0 || distance <= 0) return clampFov(startFov)
  return clampFov(fovOf(zoomOf(startFov) + Math.log(startDistance / distance)))
}

// Wheel deltas as d3-zoom scales them: a mouse notch (~100px) zooms ~15%, and
// a trackpad pinch (ctrl+wheel, small deltas) ten times as fast per pixel.
// Scrolling down (positive deltaY) zooms out.
export function wheelFov(fov: number, deltaY: number, deltaMode: number, ctrlKey: boolean) {
  const perUnit = deltaMode === 1 ? 0.05 : deltaMode ? 1 : 0.002
  const steps = deltaY * perUnit * (ctrlKey ? 10 : 1)
  return clampFov(fovOf(zoomOf(fov) + steps * Math.LN2))
}

// Smoothstep from `from` to `to` at progress t (0..1), even in scale.
export function easeFov(from: number, to: number, t: number) {
  const k = THREE.MathUtils.smoothstep(t, 0, 1)
  return fovOf(zoomOf(from) + (zoomOf(to) - zoomOf(from)) * k)
}

// One frame (dt seconds) of a wheel zoom easing toward `target`.
export function approachFov(fov: number, target: number, dt: number) {
  const k = Math.exp(-dt / GLIDE_TIME)
  return fovOf(zoomOf(target) + (zoomOf(fov) - zoomOf(target)) * k)
}

// The ray through `point` in camera space, x right and y up, at unit depth.
function ray({ dx, dy }: SkyPoint, fov: number, height: number) {
  const perPixel = (2 * Math.tan((fov / 2) * DEG)) / height
  return { x: dx * perPixel, y: -dy * perPixel }
}

// The sky direction (azimuth/altitude, degrees) under `point` when looking
// along `look` with this vertical fov on a panel `height` px tall: the
// camera's ray pitched up by the look's altitude, then turned to its heading.
export function directionAt(look: SkyLook, fov: number, point: SkyPoint, height: number): SkyLook {
  const { x, y } = ray(point, fov, height)
  const pitch = look.altitude * DEG
  const length = Math.hypot(1, x, y)
  return {
    azimuth: THREE.MathUtils.euclideanModulo(
      look.azimuth + Math.atan2(x, Math.cos(pitch) - y * Math.sin(pitch)) / DEG,
      360
    ),
    altitude:
      Math.asin(
        THREE.MathUtils.clamp((y * Math.cos(pitch) + Math.sin(pitch)) / length, -1, 1)
      ) / DEG,
  }
}

// Angle between two looks' centres of view, in radians.
function separation(a: SkyLook, b: SkyLook) {
  const cos =
    Math.sin(a.altitude * DEG) * Math.sin(b.altitude * DEG) +
    Math.cos(a.altitude * DEG) * Math.cos(b.altitude * DEG) * Math.cos((a.azimuth - b.azimuth) * DEG)
  return Math.acos(THREE.MathUtils.clamp(cos, -1, 1))
}

// The look that puts `direction` under `point`: directionAt solved for the
// look, so a zoom keeps the sky under the fingers or the cursor. Two pitches
// do it, one looking back over the zenith; the one nearer `near` (the look
// now) keeps the view from flipping. Where no look can (the zenith off to the
// side of the view, or past the pitch limits), it gets as close as the clamped
// pitch allows.
export function lookKeeping(
  direction: SkyLook,
  point: SkyPoint,
  fov: number,
  height: number,
  near: SkyLook
): SkyLook {
  const { x, y } = ray(point, fov, height)
  // y cos(pitch) + sin(pitch) = hypot(1, y) sin(pitch + atan(y)).
  const reach = (Math.sin(direction.altitude * DEG) * Math.hypot(1, x, y)) / Math.hypot(1, y)
  const lift = Math.asin(THREE.MathUtils.clamp(reach, -1, 1))
  const looks = [lift, Math.PI - lift].map((solution) => {
    const altitude = THREE.MathUtils.clamp(
      (solution - Math.atan(y)) / DEG,
      LOOK_MIN_ALTITUDE,
      LOOK_MAX_ALTITUDE
    )
    const pitch = altitude * DEG
    return clampLook({
      azimuth: direction.azimuth - Math.atan2(x, Math.cos(pitch) - y * Math.sin(pitch)) / DEG,
      altitude,
    })
  })
  return separation(looks[0], near) <= separation(looks[1], near) ? looks[0] : looks[1]
}
