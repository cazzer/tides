// Geometry → ship input for the touch controls (tides-3bl.4): the floating
// steer stick on the left and the spring-return throttle stick on the right
// (tides-2hv.3). Pure, so the mappings are tested without a DOM;
// touch-controls.ts feeds it pointers and frame times.

import { THROTTLE_RATE } from './desktop-keys'
import { BLUE_ZONE } from './flight'
import { THROTTLE_MAX, THROTTLE_MIN } from './ship-input'

/** How far the stick's knob travels from its base, in CSS px. */
export const STICK_RADIUS_PX = 56
/** Share of the stick's travel that turns nothing, so a resting thumb holds course. */
export const DEAD_ZONE = 0.12
/** >1 softens small deflections for fine aim while keeping full rate at the rim. */
export const CURVE_EXPONENT = 1.6
/** Sideways drag on the throttle stick for full roll: the knob's rim, in CSS px. */
export const ROLL_RANGE_PX = STICK_RADIUS_PX
/** Wider than the steer stick's, as a thumb pushing the throttle wobbles sideways. */
export const ROLL_DEAD_ZONE = 0.15
/** The whole throttle range, full reverse to full ahead. */
const THROTTLE_SPAN = THROTTLE_MAX - THROTTLE_MIN

/**
 * Throttle change per second at full stick deflection: the same full sweep in
 * 1.5 s as holding W or S on the desktop.
 */
export const THROTTLE_STICK_RATE = THROTTLE_RATE
/**
 * [TUNE] Exponent on the throttle stick's deflection. 1 keeps the rate
 * proportional to how far the thumb pushes; above 1 would favour fine trims.
 */
export const THROTTLE_CURVE = 1
/**
 * [TUNE] How long a pull must keep pushing on through zero, in ms, before it
 * passes into reverse (or from reverse into forward) without a fresh press.
 * Well past a reaction time, so a thumb pulling to stop lets go before it
 * overshoots; short enough that a deliberate pull isn't left waiting long.
 */
export const REVERSE_DETENT_MS = 700
/**
 * [TUNE] Deflection a pull must hold at zero for its time to count towards
 * REVERSE_DETENT_MS. A thumb drifting back towards centre resets the wait.
 */
export const DETENT_PULL = 0.5
/** [TUNE] A press shorter than this, in ms, that never travels AXIS_LOCK_PX is a tap. */
export const TAP_MAX_MS = 250
/**
 * [TUNE] How far from the drawn stick's centre, in CSS px, a press may land
 * and still tap the throttle to 0. The zone around it is wider, for drags; a
 * stray brush out there mustn't cut the throttle.
 */
export const TAP_REACH_PX = 1.25 * STICK_RADIUS_PX
/** Longer frames (a stall, an app switch) don't ramp the throttle in one go. */
export const MAX_STICK_DT = 0.1
/** Float slack on the detent timer, so 42 frames of 1/60 s count as 700 ms. */
const DWELL_EPSILON_MS = 1e-6

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
 * The throttle stick's zero detent, carried from frame to frame. `arrivedFrom`
 * is the side (+1 forward, −1 reverse) the throttle came to 0 from on this
 * press, and the stick won't carry it on through until a fresh press or a
 * pull held for REVERSE_DETENT_MS; 0 when the way through is open.
 * `dwellMs` is how long the pull has been holding at the detent.
 */
export interface ThrottleDetent {
  arrivedFrom: -1 | 0 | 1
  dwellMs: number
}

/** A press's detent: open, so a press starting at 0 goes either way at once. */
export const freshDetent = (): ThrottleDetent => ({ arrivedFrom: 0, dwellMs: 0 })

/**
 * Throttle stick deflection −1..1 from the thumb's vertical offset off where
 * it pressed: up the screen is +, the dead zone holds a resting thumb still.
 */
export function throttleDeflection(dy: number, radius: number): number {
  return shapeAxis(-dy / radius, DEAD_ZONE, THROTTLE_CURVE) + 0
}

/**
 * One frame of the throttle stick: the throttle moves at a rate proportional
 * to `deflection` and holds wherever it's left. Coming to 0 from either side
 * stops there (as desktop-keys' W/S detent does); carrying on through takes a
 * fresh press (a fresh detent) or a pull of at least DETENT_PULL held for
 * REVERSE_DETENT_MS.
 */
export function stepThrottleStick(
  throttle: number,
  deflection: number,
  dt: number,
  detent: ThrottleDetent
): { throttle: number; detent: ThrottleDetent } {
  if (!(dt > 0)) return { throttle, detent }
  if (deflection === 0) {
    return { throttle, detent: detent.dwellMs === 0 ? detent : { ...detent, dwellMs: 0 } }
  }
  const step = Math.min(dt, MAX_STICK_DT)
  const direction = Math.sign(deflection)
  // Held at zero, pushing on away from the side it came from.
  if (throttle === 0 && detent.arrivedFrom === -direction) {
    const dwellMs = Math.abs(deflection) >= DETENT_PULL ? detent.dwellMs + step * 1000 : 0
    if (dwellMs >= REVERSE_DETENT_MS - DWELL_EPSILON_MS) return { throttle: 0, detent: freshDetent() }
    return { throttle: 0, detent: { arrivedFrom: detent.arrivedFrom, dwellMs } }
  }
  const next = clamp(throttle + deflection * THROTTLE_STICK_RATE * step, THROTTLE_MIN, THROTTLE_MAX)
  // Reaching or crossing zero from either side stops on it.
  if (throttle !== 0 && Math.sign(next) !== Math.sign(throttle)) {
    return { throttle: 0, detent: { arrivedFrom: throttle > 0 ? 1 : -1, dwellMs: 0 } }
  }
  return { throttle: next, detent: freshDetent() }
}

/** Whether a press was a tap: brief, and never far enough to lock an axis. */
export function isTap(maxTravelPx: number, durationMs: number): boolean {
  return maxTravelPx < AXIS_LOCK_PX && durationMs < TAP_MAX_MS
}

/** Whether a press at `point` landed on the drawn stick, close enough to tap it. */
export function withinTapReach(point: Point, base: Point): boolean {
  return Math.hypot(point.x - base.x, point.y - base.y) <= TAP_REACH_PX
}

/** Travel on the throttle stick before it decides which axes the drag drives. */
export const AXIS_LOCK_PX = 12
/** How much one axis must dominate the other for the drag to lock to it. */
export const AXIS_LOCK_RATIO = 1.5

export type PadAxes = 'throttle' | 'roll' | 'both'

/**
 * Which axes a throttle-stick drag drives, from its travel so far: null until
 * it has moved AXIS_LOCK_PX, then throttle for a mostly vertical start, roll
 * for a mostly horizontal one, both only for a clearly diagonal one. Keeps a
 * throttle slide from rolling the ship and a roll from creeping the throttle.
 */
export function padAxes(dx: number, dy: number): PadAxes | null {
  if (Math.hypot(dx, dy) < AXIS_LOCK_PX) return null
  if (Math.abs(dy) > AXIS_LOCK_RATIO * Math.abs(dx)) return 'throttle'
  if (Math.abs(dx) > AXIS_LOCK_RATIO * Math.abs(dy)) return 'roll'
  return 'both'
}

/**
 * Where the floating stick's base lands for a press at `point`: no closer to
 * the zone's left and bottom edges than `minX`/`maxY` allow, so the knob can
 * reach full deflection left and down.
 */
export function clampStickOrigin(point: Point, bounds: { minX: number; maxY: number }): Point {
  return { x: Math.max(point.x, bounds.minX), y: Math.min(point.y, bounds.maxY) }
}

/** Roll demand from the throttle stick's sideways drag; right rolls right. */
export function rollFromDrag(startX: number, x: number): number {
  return shapeAxis((x - startX) / ROLL_RANGE_PX, ROLL_DEAD_ZONE, CURVE_EXPONENT) + 0
}

/** A throttle setpoint's height up the readout, 0 (full reverse) .. 1 (full ahead). */
export function throttleToTrack(throttle: number): number {
  return (clamp(throttle, THROTTLE_MIN, THROTTLE_MAX) - THROTTLE_MIN) / THROTTLE_SPAN
}

/** flight.ts's BLUE_ZONE as heights up the throttle readout. */
export const BLUE_BAND: readonly [number, number] = [
  throttleToTrack(BLUE_ZONE[0]),
  throttleToTrack(BLUE_ZONE[1]),
]
