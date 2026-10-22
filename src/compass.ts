import * as THREE from 'three'
import type { SkyLook } from './sky-look'

const DEG = Math.PI / 180

// Compass mode (tides-d5j): View from Earth looks where the phone's back
// camera points. The maths works in the horizon frame three's cameras use:
// X east, Y the zenith, −Z north.

/** A deviceorientation reading in degrees, with alpha measured from north. */
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

/** iOS's turn from its own alpha to north, and whether it was learnt in a
 * pose where the compass heading can be trusted. */
export interface NorthOffset {
  degrees: number
  trusted: boolean
}

// Time constant of the low-pass, in ms: enough to settle sensor jitter
// without the view trailing the phone.
export const SMOOTHING_MS = 80

// How far each trusted reading moves iOS's north offset: heavy smoothing, as
// the offset only drifts slowly.
const OFFSET_EASING = 0.1

const wrap180 = (degrees: number) => THREE.MathUtils.euclideanModulo(degrees + 180, 360) - 180

// iOS's compass heading follows the top of the phone lying flat and the back
// of it held upright, so it agrees with alpha's frame only in between, with
// the phone not leant sideways.
function headingMatchesAlpha({ beta, gamma }: { beta: number; gamma: number }) {
  return beta >= 0 && beta <= 75 && Math.abs(gamma) <= 30
}

/** Updates iOS's north offset from a reading: −heading − alpha, eased in
 * readings from poses where the two agree. Until one arrives, any reading
 * stands in, so the view starts near north even when held up to the sky.
 * Returns `offset` unchanged when the reading has no heading (or an
 * uncalibrated −1). */
export function nextNorthOffset(
  offset: NorthOffset | null,
  reading: OrientationReading
): NorthOffset | null {
  const { alpha, beta, gamma, webkitCompassHeading: heading } = reading
  if (heading == null || heading < 0 || alpha == null || beta == null || gamma == null) {
    return offset
  }
  const target = THREE.MathUtils.euclideanModulo(-heading - alpha, 360)
  const trusted = headingMatchesAlpha({ beta, gamma })
  if (!offset || (trusted && !offset.trusted)) return { degrees: target, trusted }
  if (!trusted) return offset
  return {
    degrees: THREE.MathUtils.euclideanModulo(
      offset.degrees + wrap180(target - offset.degrees) * OFFSET_EASING,
      360
    ),
    trusted,
  }
}

/** The reading's angles with alpha turned to face north, or null when it has
 * no north to give: no sensor, or an alpha that only counts from where the
 * page started and no iOS offset (see nextNorthOffset) to correct it. North
 * here is magnetic north, as both iOS and Chrome report it. */
export function readingAngles(
  reading: OrientationReading,
  northOffset: NorthOffset | null = null
): DeviceAngles | null {
  const { alpha, beta, gamma, absolute } = reading
  if (alpha == null || beta == null || gamma == null) return null
  if (northOffset) {
    return { alpha: THREE.MathUtils.euclideanModulo(alpha + northOffset.degrees, 360), beta, gamma }
  }
  if (absolute) return { alpha, beta, gamma }
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
