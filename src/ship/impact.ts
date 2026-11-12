// Impact feedback (tides-2hv.12): an arrival too fast for a body's cushion
// reaches the backstop under it (flight.ts collide, tides-ufyr.1;
// telemetry.colliding) and bounces off, and nothing else said so; sinking
// into the cushion alone is not a hit and only shakes the view (shake.ts).
// useSpeedFov, which runs in
// the R3F frame loop straight after the controller and so never misses a
// step, counts hits here and punches the FOV; the HUD, on its own rAF loop,
// flashes a vignette whenever the count moves. A counter rather than the
// flag, which is true for a single step and could fall between HUD frames.

import { V_NORMAL } from './flight'

/** Hits so far this session; only ever goes up. */
export const shipImpacts = { count: 0 }

/**
 * [TUNE] The arrival speed over the cushion, units/s, that reads as a crash
 * for the approach panel (approach.ts OVER_ON, canCrash). A locked approach
 * touches down at the V_NORMAL floor, which the cushion takes without
 * reaching the backstop: a landing, not a crash. Earth's ground on the high
 * tier is never one: its speed floor holds a dive at or under OVERSPEED_MAX
 * × EARTH_GROUND_SPEED, well under this (tides-01v.8.17; approach.ts
 * canCrash mutes its warnings). The cushion absorbs arrivals up to about
 * twice the floor, so this warns early (tides-d11z).
 */
export const IMPACT_MIN_SPEED = 1.5 * V_NORMAL

/**
 * [TUNE] A hit counts as an impact only when the ship reached the backstop
 * faster than this, units/s (telemetry.impactSpeed): the speed the cushion
 * couldn't take, not the speed into the step, which the cushion has already
 * braked, by more the shorter the frame. Over flight.ts COLLISION_SPEED, so
 * just reaching it isn't a crash; an arrival at about 2.1× the floor speed
 * reaches it this fast. Earth's ground on the high tier, whose floor is a
 * tenth of V_NORMAL, never does.
 */
export const IMPACT_BACKSTOP_SPEED = 0.25 * V_NORMAL

/**
 * Whether this frame's step is an impact: a new hit, reaching the backstop
 * at `impactSpeed` (telemetry.impactSpeed) over IMPACT_BACKSTOP_SPEED.
 */
export function isImpact(colliding: boolean, wasColliding: boolean, impactSpeed: number): boolean {
  return colliding && !wasColliding && impactSpeed > IMPACT_BACKSTOP_SPEED
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
