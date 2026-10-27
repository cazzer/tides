// Speed blur (tides-5lj): under boost the cap over terrain is no longer held
// to what the surface tiles stream (flight.ts lawSpeed's boosted guard), so
// low and fast the ground sweeps past quicker than detail arrives, and the
// tiles sit at their coarsest (surface-lod.ts, past RATE_HIGH). A soft blur
// round the edges of the view, where the ground streams past fastest and
// coarse or late tiles show most, hides that and reads as speed. The pure
// maths behind SpeedBlur, a CSS backdrop-filter over the ship view behind a
// radial mask, so the centre, where the pilot looks, stays sharp.
//
// It follows the sweep rate the tiles coarsen with (surface-lod.ts
// sweepRate: speed over height, 1/s) and its easing, so it comes in as the
// tiles coarsen and goes as they refine; scaled by the boost's spool, and
// only while the boost raises the cap (telemetry.boosted, as the shake:
// shake.ts), so never unboosted, nor in space or on the Moon. Off under
// reduced motion.

import { clamp01, easeToward } from './dust'
import { FALL_SECONDS, RATE_HIGH, RISE_SECONDS } from '../renderers/surface/surface-lod'

/** [TUNE] The blur's radius at full spool and sweep, CSS px. */
export const BLUR_MAX_PX = 6
/**
 * Sweep rates, 1/s, the blur ramps between (smoothstep in log): none at or
 * under a quarter of where the tiles reach their coarsest, full there.
 */
export const BLUR_SWEEP_LOW = RATE_HIGH / 4
export const BLUR_SWEEP_HIGH = RATE_HIGH
/** Time constants of the ease toward the target, seconds: the tiles' own (surface-lod.ts), rising, falling. */
export const BLUR_RISE_TAU = RISE_SECONDS
export const BLUR_FALL_TAU = FALL_SECONDS
/** Easing toward 0, under this many px the blur is 0. */
export const BLUR_EPSILON = 0.05

/** How much of the blur sweep rate `sweep` (1/s) earns: 0 at or under BLUR_SWEEP_LOW (or NaN), 1 from BLUR_SWEEP_HIGH. */
export function blurSweepShare(sweep: number): number {
  if (!(sweep > BLUR_SWEEP_LOW)) return 0
  const t = clamp01(Math.log(sweep / BLUR_SWEEP_LOW) / Math.log(BLUR_SWEEP_HIGH / BLUR_SWEEP_LOW))
  return t * t * (3 - 2 * t)
}

/**
 * The blur's radius to ease toward, CSS px, at sweep rate `sweep` (1/s) and
 * boost spool `boost` (0..1), counted only while `boosted` (the boost raises
 * the cap; telemetry.boosted): 0..BLUR_MAX_PX, 0 under reduced motion.
 */
export function blurTarget(sweep: number, boost: number, boosted: boolean, reducedMotion = false): number {
  if (reducedMotion) return 0
  const spool = boosted && Number.isFinite(boost) ? clamp01(boost) : 0
  return BLUR_MAX_PX * spool * blurSweepShare(sweep)
}

/**
 * `current` eased `dt` seconds toward `target`: over BLUR_RISE_TAU rising,
 * BLUR_FALL_TAU falling, and exactly 0 once it is within BLUR_EPSILON of a
 * 0 target. A non-finite `current` starts over at `target`; a non-finite
 * `dt` is no time.
 */
export function easeBlur(current: number, target: number, dt: number): number {
  if (!Number.isFinite(current)) return target
  const step = Number.isFinite(dt) ? dt : 0
  const next = easeToward(current, target, step, target > current ? BLUR_RISE_TAU : BLUR_FALL_TAU)
  return target === 0 && Math.abs(next) < BLUR_EPSILON ? 0 : next
}

/**
 * The CSS filter for a blur of `px`: 'none' when it rounds to 0 (or is not
 * finite), else blur() to a tenth of a px, so the style changes only when
 * the drawn blur would.
 */
export function blurFilter(px: number): string {
  const tenths = Number.isFinite(px) ? Math.round(px * 10) : 0
  return tenths > 0 ? `blur(${(tenths / 10).toFixed(1)}px)` : 'none'
}
