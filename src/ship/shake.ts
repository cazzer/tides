// Air shudder (tides-xxg): flying fast through Earth's air, the view shakes,
// very slightly, a low buffet, with the dynamic pressure (telemetry.air,
// frame-carry.ts), and clearly more while the boost raises the cap. The pure
// maths behind useShipShake, which turns the camera by shakeAngles between
// the settle and drei's View render and puts it back after, so only the
// drawn frame shakes: never the flight, the carry, the targeting, the dust
// or the HUD. Sized in screen pixels, not radians, so a phone's small view
// shakes as visibly as a desktop's. Rotation only: the dust is anchored on the camera's position,
// and at the 30 m stop the near plane leaves no room to move the eye.
//
// The shake is a sum of a few incommensurate sines per axis, so it never
// visibly repeats, and is smooth and deterministic in time (no per-frame
// random, which would jitter with the frame rate).

import { clamp01, easeToward } from './dust'
import { SEA_LEVEL_DENSITY } from './frame-carry'
import { EARTH_AIR_SEA_SPEED, EARTH_UNITS_PER_METRE } from './ship-bodies'

/**
 * [TUNE] No shake at or under this dynamic pressure, Pa: vacuum, the slip
 * of the release band, the plateau speed from ~150 km up.
 */
export const SHAKE_Q_MIN = 100
/**
 * The dynamic pressure, Pa, over SHAKE_Q_MIN that brings the shake to 1 −
 * 1/e of full: half the air's own floor's (EARTH_AIR_SPEED) at sea level,
 * ~12 kPa, so full throttle unboosted reads ~0.86 of full. That law holds
 * the dynamic pressure constant up the column, so it reads the same at any
 * height in the air.
 */
export const SHAKE_Q_REF = 0.25 * SEA_LEVEL_DENSITY * (EARTH_AIR_SEA_SPEED / EARTH_UNITS_PER_METRE) ** 2
/** [TUNE] How much more the shake is at full boost spool while the boost raises the cap. */
export const SHAKE_BOOST_GAIN = 1.5
/** The most shakeTarget gives. */
export const SHAKE_MAX_INTENSITY = 1 + SHAKE_BOOST_GAIN
/** [TUNE] Time constants of the ease toward the target, seconds: rising, falling. */
export const SHAKE_RISE_TAU = 0.35
export const SHAKE_FALL_TAU = 0.6
/** Easing toward 0, under this the shake is 0. */
export const SHAKE_EPSILON = 1e-4

/**
 * [TUNE] Peak pitch and yaw at intensity 1, CSS px at the view's centre:
 * under a pixel unboosted reads as shimmer, a few boosted as a buffet.
 */
export const SHAKE_PX = 1.6
/** [TUNE] Roll's share of SHAKE_PX's turn: rolling tilts the horizon, which reads most as sway. */
export const SHAKE_ROLL_SHARE = 0.6
/** [TUNE] Views shorter than this, CSS px, shake as if this tall: a tiny view's pixels don't turn it wildly. */
export const SHAKE_MIN_VIEW_PX = 300

/**
 * [TUNE] Each axis's sines (pitch, yaw, roll), Hz: a buffet, not a sway
 * (~3–9 Hz; at or under 9 so a 30 fps phone still draws 3 frames a cycle),
 * and incommensurate.
 */
export const SHAKE_HZ: readonly (readonly [number, number, number])[] = [
  [2.9, 5.3, 8.9],
  [2.3, 4.7, 7.9],
  [1.7, 3.7, 6.1],
]
/** [TUNE] The sines' weights, the slowest strongest. */
export const SHAKE_WEIGHTS: readonly [number, number, number] = [1, 0.6, 0.4]
// Fixed phases, so the axes don't start in step.
const SHAKE_PHASES: readonly (readonly [number, number, number])[] = [
  [0, 2.1, 4.4],
  [1.3, 5.0, 0.7],
  [3.6, 0.4, 2.8],
]
const WEIGHT_SUM = SHAKE_WEIGHTS[0] + SHAKE_WEIGHTS[1] + SHAKE_WEIGHTS[2]

/** How much of the shake dynamic pressure `q`, Pa, earns: 0 at or under SHAKE_Q_MIN, toward 1 above. */
export function airShakeShare(q: number): number {
  if (!Number.isFinite(q) || q <= SHAKE_Q_MIN) return 0
  return 1 - Math.exp(-(q - SHAKE_Q_MIN) / SHAKE_Q_REF)
}

/**
 * The shake's intensity to ease toward at dynamic pressure `q`, Pa, and
 * boost spool `boost` (0..1), counted only while `boosted` (the boost raises
 * the cap; telemetry.boosted): 0..SHAKE_MAX_INTENSITY, 0 under reduced motion.
 */
export function shakeTarget(q: number, boost: number, boosted: boolean, reducedMotion = false): number {
  if (reducedMotion) return 0
  const spool = boosted && Number.isFinite(boost) ? clamp01(boost) : 0
  return airShakeShare(q) * (1 + SHAKE_BOOST_GAIN * spool)
}

/**
 * `current` eased `dt` seconds toward `target`: over SHAKE_RISE_TAU rising,
 * SHAKE_FALL_TAU falling, and exactly 0 once it is within SHAKE_EPSILON of
 * a 0 target. A non-finite `current` starts over at `target`.
 */
export function easeShake(current: number, target: number, dt: number): number {
  if (!Number.isFinite(current)) return target
  const next = easeToward(current, target, dt, target > current ? SHAKE_RISE_TAU : SHAKE_FALL_TAU)
  return target === 0 && Math.abs(next) < SHAKE_EPSILON ? 0 : next
}

/** The shake's signal on `axis` (0 pitch, 1 yaw, 2 roll) at `t` seconds, -1..1. */
export function shakeNoise(t: number, axis: 0 | 1 | 2): number {
  const hz = SHAKE_HZ[axis]
  const phase = SHAKE_PHASES[axis]
  let sum = 0
  for (let i = 0; i < 3; i++) sum += SHAKE_WEIGHTS[i] * Math.sin(2 * Math.PI * hz[i] * t + phase[i])
  return sum / WEIGHT_SUM
}

/** A turn of the view, radians, about its own axes. */
export interface ShakeAngles {
  pitch: number
  yaw: number
  roll: number
}

/**
 * Radians a CSS px turns at the centre of a view `viewHeight` CSS px tall
 * (at least SHAKE_MIN_VIEW_PX) with a vertical field of view of `fovDeg`;
 * 0 if either is not finite.
 */
export function shakeRadiansPerPx(fovDeg: number, viewHeight: number): number {
  if (!Number.isFinite(fovDeg) || !Number.isFinite(viewHeight)) return 0
  return Math.tan((fovDeg * Math.PI) / 360) / (Math.max(viewHeight, SHAKE_MIN_VIEW_PX) / 2)
}

/**
 * Fills `out` with the shake at `t` seconds and `intensity`, radians, for a
 * view turning `radiansPerPx` (shakeRadiansPerPx): all 0 at intensity 0 (or
 * not finite).
 */
export function shakeAngles(t: number, intensity: number, radiansPerPx: number, out: ShakeAngles): ShakeAngles {
  if (!Number.isFinite(intensity) || intensity === 0) {
    out.pitch = 0
    out.yaw = 0
    out.roll = 0
    return out
  }
  const amplitude = SHAKE_PX * radiansPerPx * intensity
  out.pitch = amplitude * shakeNoise(t, 0)
  out.yaw = amplitude * shakeNoise(t, 1)
  out.roll = SHAKE_ROLL_SHARE * amplitude * shakeNoise(t, 2)
  return out
}
