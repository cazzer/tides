// Geometry → ship input for the touch controls (tides-3bl.4): the floating
// steer stick on the left and the throttle/roll pad on the right. Pure, so
// the mappings are tested without a DOM; touch-controls.ts feeds it pointers.

import { BLUE_ZONE } from './flight'
import { THROTTLE_MAX, THROTTLE_MIN } from './ship-input'

/** How far the stick's knob travels from its base, in CSS px. */
export const STICK_RADIUS_PX = 56
/** Share of the stick's travel that turns nothing, so a resting thumb holds course. */
export const DEAD_ZONE = 0.12
/** >1 softens small deflections for fine aim while keeping full rate at the rim. */
export const CURVE_EXPONENT = 1.6
/** Sideways drag on the throttle pad for full roll, in CSS px. */
export const ROLL_RANGE_PX = 60
/** Wider than the stick's, as the throttle thumb wobbles sideways while it slides. */
export const ROLL_DEAD_ZONE = 0.15
/** Dragging the throttle track's full height sweeps this much setpoint. */
const THROTTLE_SPAN = THROTTLE_MAX - THROTTLE_MIN

export interface Point {
  x: number
  y: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * A deflection −1..1 shaped for the thumb: 0 inside the dead zone, then
 * rescaled so it rises from 0 at the zone's edge, curved, clamped to ±1.
 */
export function shapeAxis(v: number, deadZone: number, exponent: number): number {
  const magnitude = Math.abs(v)
  if (!(magnitude > deadZone)) return 0
  const t = Math.min((magnitude - deadZone) / (1 - deadZone), 1)
  return Math.sign(v) * t ** exponent
}

/** Where the knob sits: under the thumb, held to the base's rim. */
export function stickKnob(origin: Point, current: Point, radius: number): Point {
  const dx = current.x - origin.x
  const dy = current.y - origin.y
  const distance = Math.hypot(dx, dy)
  if (distance <= radius) return { x: current.x, y: current.y }
  const k = radius / distance
  return { x: origin.x + dx * k, y: origin.y + dy * k }
}

/**
 * Turn-rate demand from the thumb's offset off where it landed. The dead zone
 * and curve act on the offset's length, so diagonals stay round and never
 * exceed 1. Up the screen is nose up; right is nose right.
 */
export function stickDemand(
  origin: Point,
  current: Point,
  radius: number
): { pitch: number; yaw: number } {
  const dx = (current.x - origin.x) / radius
  const dy = (current.y - origin.y) / radius
  const magnitude = Math.hypot(dx, dy)
  const shaped = shapeAxis(magnitude, DEAD_ZONE, CURVE_EXPONENT)
  if (shaped === 0) return { pitch: 0, yaw: 0 }
  // + 0 turns a -0 into 0.
  return { pitch: (-dy / magnitude) * shaped + 0, yaw: (dx / magnitude) * shaped + 0 }
}

/**
 * The throttle setpoint after dragging from `startY` to `y`: relative to where
 * it stood at the press, so touching the pad never makes it jump. Dragging up
 * the full `trackPx` sweeps the whole −0.25..1 range.
 */
export function throttleFromDrag(
  startSetpoint: number,
  startY: number,
  y: number,
  trackPx: number
): number {
  const next = startSetpoint + ((startY - y) / Math.max(trackPx, 1)) * THROTTLE_SPAN
  return clamp(next, THROTTLE_MIN, THROTTLE_MAX)
}

/** Roll demand from the throttle pad's sideways drag; right rolls right. */
export function rollFromDrag(startX: number, x: number): number {
  return shapeAxis((x - startX) / ROLL_RANGE_PX, ROLL_DEAD_ZONE, CURVE_EXPONENT) + 0
}

/** A throttle setpoint's height up the track, 0 (full reverse) .. 1 (full ahead). */
export function throttleToTrack(throttle: number): number {
  return (clamp(throttle, THROTTLE_MIN, THROTTLE_MAX) - THROTTLE_MIN) / THROTTLE_SPAN
}

/** The best-turn-rate throttle band as heights up the track. */
export const BLUE_BAND: readonly [number, number] = [
  throttleToTrack(BLUE_ZONE[0]),
  throttleToTrack(BLUE_ZONE[1]),
]
