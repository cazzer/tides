// Impact feedback (tides-2hv.12): flight.ts stops the ship dead on a body
// (telemetry.colliding) and nothing else said so. useSpeedFov, which runs in
// the R3F frame loop straight after the controller and so never misses a
// step, counts hits here and punches the FOV; the HUD, on its own rAF loop,
// flashes a vignette whenever the count moves. A counter rather than the
// flag, which is true for a single step and could fall between HUD frames.

import { V_NORMAL } from './flight'

/** Hits so far this session; only ever goes up. */
export const shipImpacts = { count: 0 }

/**
 * [TUNE] A hit counts as an impact only when the ship was going faster than
 * this, units/s, the frame before. A locked approach touches down at the
 * V_NORMAL floor, which telemetry.colliding also flags (flight.ts
 * COLLISION_SPEED); that is a landing, not a crash.
 */
export const IMPACT_MIN_SPEED = 1.5 * V_NORMAL

/** Whether this frame's step is an impact: a new hit, coming in fast. */
export function isImpact(colliding: boolean, wasColliding: boolean, speedBefore: number): boolean {
  return colliding && !wasColliding && speedBefore > IMPACT_MIN_SPEED
}

/**
 * [TUNE] The FOV punch on impact, degrees (negative narrows: the view lurches
 * in), and the time constant it decays back with, seconds.
 */
export const IMPACT_FOV_PUNCH = -2
export const IMPACT_FOV_TAU = 0.12

/** The punch `elapsed` seconds after a hit, degrees; 0 before it. */
export function impactFovPunch(elapsed: number): number {
  if (!(elapsed >= 0)) return 0
  return IMPACT_FOV_PUNCH * Math.exp(-elapsed / IMPACT_FOV_TAU)
}

/**
 * [TUNE] The HUD's coral vignette: how long one flash lasts, ms; the least
 * time between flashes, so grinding along a surface doesn't strobe; and its
 * peak opacity under prefers-reduced-motion (1 otherwise).
 */
export const IMPACT_FLASH_MS = 250
export const IMPACT_FLASH_COOLDOWN_MS = 400
export const IMPACT_FLASH_REDUCED = 0.5
