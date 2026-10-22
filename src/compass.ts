import * as THREE from 'three'
import type { SkyLook } from './sky-look'

const DEG = Math.PI / 180

// Compass mode (tides-d5j): View from Earth looks where the phone's back
// camera points. The maths works in the horizon frame three's cameras use:
// X east, Y the zenith, −Z north.

/** A deviceorientation reading in degrees, with alpha measured from true north. */
export interface DeviceAngles {
  alpha: number
  beta: number
  gamma: number
}

/** The parts of a DeviceOrientationEvent read here; iOS adds webkitCompassHeading. */
export interface OrientationReading {
  alpha: number | null
  beta: number | null
  gamma: number | null
  absolute: boolean
  webkitCompassHeading?: number | null
}

// Time constant of the low-pass, in ms: enough to settle sensor jitter
// without the view trailing the phone.
export const SMOOTHING_MS = 80

/** The reading's angles with alpha turned to face north, or null when it has
 * no north to give (no sensor, or an alpha that only counts from where the
 * page started). */
export function readingAngles(reading: OrientationReading): DeviceAngles | null {
  const { alpha, beta, gamma, absolute, webkitCompassHeading } = reading
  if (beta == null || gamma == null) return null
  // iOS: a clockwise heading, against alpha's anticlockwise turn.
  if (webkitCompassHeading != null && webkitCompassHeading >= 0) {
    return { alpha: THREE.MathUtils.euclideanModulo(-webkitCompassHeading, 360), beta, gamma }
  }
  if (absolute && alpha != null) return { alpha, beta, gamma }
  return null
}

const euler = new THREE.Euler()
const screenTurn = new THREE.Quaternion()
const Z_AXIS = new THREE.Vector3(0, 0, 1)
// Stands the device frame (z out of the screen) up as a camera looking out
// of its back.
const OUT_OF_THE_BACK = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  -Math.PI / 2
)

/** The orientation of a camera looking out of the phone's back, its up the
 * top of the screen as shown: the reading's Z-X'-Y'' turn (as in three's
 * DeviceOrientationControls), then the screen's own turn on the device
 * (screen.orientation.angle, anticlockwise). */
export function deviceQuaternion(
  { alpha, beta, gamma }: DeviceAngles,
  screenAngle: number,
  target = new THREE.Quaternion()
) {
  euler.set(beta * DEG, alpha * DEG, -gamma * DEG, 'YXZ')
  return target
    .setFromEuler(euler)
    .multiply(OUT_OF_THE_BACK)
    .multiply(screenTurn.setFromAxisAngle(Z_AXIS, -screenAngle * DEG))
}

/** The look matching a camera orientation: heading, then pitch, then roll,
 * as placeSurfaceCamera builds it back. Keeping the roll keeps the sky
 * matched to the phone, and keeps the turn smooth through the zenith, where
 * a heading alone is undefined and a level view would spin. */
export function lookFromQuaternion(q: THREE.Quaternion): SkyLook {
  euler.setFromQuaternion(q, 'YXZ')
  return {
    azimuth: THREE.MathUtils.euclideanModulo(-euler.y / DEG, 360),
    altitude: euler.x / DEG,
    roll: euler.z / DEG,
  }
}

/** Eases `current` toward `target` over `dtMs` (in place). Slerping the
 * whole orientation turns the short way, so the heading wraps through north
 * and nothing flips near the zenith. */
export function smoothOrientation(
  current: THREE.Quaternion,
  target: THREE.Quaternion,
  dtMs: number
) {
  return current.slerp(target, 1 - Math.exp(-Math.max(dtMs, 0) / SMOOTHING_MS))
}
