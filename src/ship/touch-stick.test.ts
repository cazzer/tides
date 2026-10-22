import { describe, expect, it } from 'vitest'
import { THROTTLE_RATE } from './desktop-keys'
import { BLUE_ZONE } from './flight'
import { THROTTLE_MAX, THROTTLE_MIN } from './ship-input'
import {
  AXIS_LOCK_PX,
  AXIS_LOCK_RATIO,
  BLUE_BAND,
  clampStickOrigin,
  padAxes,
  CURVE_EXPONENT,
  DEAD_ZONE,
  DETENT_PULL,
  MAX_STICK_DT,
  REVERSE_DETENT_MS,
  ROLL_DEAD_ZONE,
  ROLL_RANGE_PX,
  STICK_RADIUS_PX,
  TAP_MAX_MS,
  TAP_REACH_PX,
  THROTTLE_STICK_RATE,
  freshDetent,
  isTap,
  rollFromDrag,
  shapeAxis,
  stepThrottleStick,
  stickDemand,
  stickKnob,
  throttleDeflection,
  throttleToTrack,
  withinTapReach,
  type ThrottleDetent,
} from './touch-stick'

const R = STICK_RADIUS_PX
const O = { x: 100, y: 200 }
const at = (dx: number, dy: number) => ({ x: O.x + dx, y: O.y + dy })

describe('shapeAxis', () => {
  it('is 0 inside the dead zone and rises from 0 at its edge', () => {
    expect(shapeAxis(0, 0.1, 2)).toBe(0)
    expect(shapeAxis(0.1, 0.1, 2)).toBe(0)
    expect(shapeAxis(-0.05, 0.1, 2)).toBe(0)
    expect(shapeAxis(0.1001, 0.1, 2)).toBeLessThan(1e-6)
  })

  it('keeps the sign and saturates at ±1', () => {
    expect(shapeAxis(1, 0.1, 2)).toBe(1)
    expect(shapeAxis(3, 0.1, 2)).toBe(1)
    expect(shapeAxis(-3, 0.1, 2)).toBe(-1)
  })

  it('treats NaN as no input', () => {
    expect(shapeAxis(NaN, 0.1, 2)).toBe(0)
  })
})

describe('stickDemand', () => {
  it('turns nothing inside the dead zone', () => {
    expect(stickDemand(O, O, R)).toEqual({ pitch: 0, yaw: 0 })
    expect(stickDemand(O, at(R * DEAD_ZONE * 0.9, 0), R)).toEqual({ pitch: 0, yaw: 0 })
  })

  it('reaches full rate at the rim and holds it beyond', () => {
    expect(stickDemand(O, at(R, 0), R)).toEqual({ pitch: 0, yaw: 1 })
    expect(stickDemand(O, at(-3 * R, 0), R)).toEqual({ pitch: 0, yaw: -1 })
    expect(stickDemand(O, at(0, -R), R)).toEqual({ pitch: 1, yaw: 0 })
    expect(stickDemand(O, at(0, 2 * R), R)).toEqual({ pitch: -1, yaw: 0 })
  })

  it('pitches up for a thumb up the screen and yaws right for one to the right', () => {
    const { pitch, yaw } = stickDemand(O, at(R / 2, -R / 2), R)
    expect(pitch).toBeGreaterThan(0)
    expect(yaw).toBeGreaterThan(0)
  })

  it('keeps diagonals within the unit circle', () => {
    const { pitch, yaw } = stickDemand(O, at(R * 2, R * 2), R)
    expect(Math.hypot(pitch, yaw)).toBeCloseTo(1, 9)
    expect(Math.abs(pitch)).toBeLessThan(1)
  })

  it('curves: monotonic, and below linear mid-range', () => {
    let previous = 0
    for (let i = 1; i <= 20; i++) {
      const { yaw } = stickDemand(O, at((R * i) / 20, 0), R)
      expect(yaw).toBeGreaterThanOrEqual(previous)
      previous = yaw
    }
    const mid = stickDemand(O, at(R / 2, 0), R).yaw
    const linear = (0.5 - DEAD_ZONE) / (1 - DEAD_ZONE)
    expect(CURVE_EXPONENT).toBeGreaterThan(1)
    expect(mid).toBeLessThan(linear)
    expect(mid).toBeGreaterThan(0)
  })
})

describe('stickKnob', () => {
  it('follows the thumb within the rim and stops at it', () => {
    expect(stickKnob(O, at(10, -20), R)).toEqual(at(10, -20))
    const knob = stickKnob(O, at(3 * R, 4 * R), R)
    expect(knob.x).toBeCloseTo(O.x + 0.6 * R, 9)
    expect(knob.y).toBeCloseTo(O.y + 0.8 * R, 9)
  })
})

describe('throttleDeflection', () => {
  it('ignores a resting thumb, is + up the screen, linear past the dead zone, saturates', () => {
    expect(throttleDeflection(0, R)).toBe(0)
    expect(throttleDeflection(-R * DEAD_ZONE * 0.9, R)).toBe(0)
    expect(throttleDeflection(R * DEAD_ZONE * 0.9, R)).toBe(0)
    expect(throttleDeflection(-R, R)).toBe(1)
    expect(throttleDeflection(R, R)).toBe(-1)
    expect(throttleDeflection(-3 * R, R)).toBe(1)
    // Linear: halfway between the dead zone's edge and the rim is half.
    const mid = (DEAD_ZONE + 1) / 2
    expect(throttleDeflection(-R * mid, R)).toBeCloseTo(0.5, 12)
    expect(throttleDeflection(R * mid, R)).toBeCloseTo(-0.5, 12)
  })
})

// Runs `seconds` of 60 fps frames at a fixed deflection.
function hold(
  start: { throttle: number; detent: ThrottleDetent },
  deflection: number,
  seconds: number
) {
  let state = start
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    state = stepThrottleStick(state.throttle, deflection, 1 / 60, state.detent)
  }
  return state
}

describe('stepThrottleStick', () => {
  const free = (throttle: number) => ({ throttle, detent: freshDetent() })

  it('sweeps the whole range in 1.5 s at full deflection, like W/S', () => {
    expect(THROTTLE_STICK_RATE).toBe(THROTTLE_RATE)
    // 1.5 s for the whole span: 0.3 s up out of full reverse, 1.2 s from 0 to full.
    expect(hold(free(THROTTLE_MIN), 1, 0.3).throttle).toBe(0)
    expect(hold(free(0), 1, 1.2).throttle).toBeCloseTo(THROTTLE_MAX, 9)
    // Half the push, half the rate.
    expect(hold(free(0), 0.5, 0.6).throttle).toBeCloseTo(0.5 * THROTTLE_RATE * 0.6, 9)
    expect(hold(free(1), -0.5, 0.6).throttle).toBeCloseTo(1 - 0.5 * THROTTLE_RATE * 0.6, 9)
  })

  it('clamps at full ahead and full reverse', () => {
    expect(hold(free(0.9), 1, 1).throttle).toBe(THROTTLE_MAX)
    expect(hold(free(-0.1), -1, 1).throttle).toBe(THROTTLE_MIN)
  })

  it('ignores frames with no time, and clamps long ones', () => {
    const detent = freshDetent()
    expect(stepThrottleStick(0.5, 1, 0, detent)).toEqual({ throttle: 0.5, detent })
    expect(stepThrottleStick(0.5, 1, -1, detent)).toEqual({ throttle: 0.5, detent })
    expect(stepThrottleStick(0.5, 1, NaN, detent)).toEqual({ throttle: 0.5, detent })
    expect(stepThrottleStick(0.2, 1, 5, detent).throttle).toBeCloseTo(
      0.2 + THROTTLE_RATE * MAX_STICK_DT,
      12
    )
  })

  it('holds the throttle when the stick is centred', () => {
    expect(stepThrottleStick(0.4, 0, 1 / 60, freshDetent()).throttle).toBe(0.4)
  })

  it('stops at exactly 0 coming down, and holds there through a short pull', () => {
    const landed = stepThrottleStick(0.01, -1, 1 / 60, freshDetent())
    expect(landed.throttle).toBe(0)
    expect(landed.detent).toEqual({ arrivedFrom: 1, dwellMs: 0 })
    // One 60 fps frame short of the detent.
    const frames = (REVERSE_DETENT_MS / 1000) * 60 - 1
    const waited = hold(landed, -1, frames / 60)
    expect(waited.throttle).toBe(0)
    expect(waited.detent.dwellMs).toBeCloseTo((frames * 1000) / 60, 6)
  })

  it('carries on into reverse after a pull held REVERSE_DETENT_MS at 0', () => {
    const landed = stepThrottleStick(0.01, -1, 1 / 60, freshDetent())
    const opened = hold(landed, -1, REVERSE_DETENT_MS / 1000)
    expect(opened.throttle).toBe(0)
    expect(opened.detent.arrivedFrom).toBe(0)
    expect(stepThrottleStick(0, -1, 1 / 60, opened.detent).throttle).toBeLessThan(0)
  })

  it('resets the wait when the pull eases off or backs away', () => {
    const landed = stepThrottleStick(0.01, -1, 1 / 60, freshDetent())
    const waited = hold(landed, -1, 0.2)
    const eased = stepThrottleStick(0, -(DETENT_PULL - 0.01), 1 / 60, waited.detent)
    expect(eased).toEqual({ throttle: 0, detent: { arrivedFrom: 1, dwellMs: 0 } })
    const centred = stepThrottleStick(0, 0, 1 / 60, waited.detent)
    expect(centred.detent.dwellMs).toBe(0)
    // Backing up off zero and coming down again lands on the detent afresh.
    const backed = hold(waited, 0.5, 0.1)
    expect(backed.throttle).toBeGreaterThan(0)
    const again = hold(backed, -1, 0.2)
    expect(again.throttle).toBe(0)
    expect(again.detent.arrivedFrom).toBe(1)
  })

  it('stops at 0 coming up from reverse too', () => {
    // Arrives on the 15th frame.
    const landed = hold(free(-0.2), 1, 0.25)
    expect(landed.throttle).toBe(0)
    expect(landed.detent).toEqual({ arrivedFrom: -1, dwellMs: 0 })
    expect(hold(landed, 1, 0.2).throttle).toBe(0)
    const opened = hold(landed, 1, REVERSE_DETENT_MS / 1000)
    expect(hold(opened, 1, 0.1).throttle).toBeGreaterThan(0)
  })

  it('goes straight into reverse on a fresh press at 0', () => {
    expect(stepThrottleStick(0, -1, 1 / 60, freshDetent()).throttle).toBeLessThan(0)
    expect(stepThrottleStick(0, 1, 1 / 60, freshDetent()).throttle).toBeGreaterThan(0)
  })

  it('never reverses by accident: a full pull from full ahead held until just short of the detent', () => {
    // 1.2 s to come down from 1 to 0, then held on the detent until just short of it.
    const swept = hold(free(THROTTLE_MAX), -1, 1.2 + (REVERSE_DETENT_MS - 20) / 1000)
    expect(swept.throttle).toBe(0)
    // A gentle pull below DETENT_PULL never gets through, however long.
    expect(hold(free(0.5), -0.4, 5).throttle).toBe(0)
  })
})

describe('isTap', () => {
  it('needs both a short press and less than the axis-lock travel', () => {
    expect(isTap(0, 0)).toBe(true)
    expect(isTap(AXIS_LOCK_PX - 1, TAP_MAX_MS - 1)).toBe(true)
    expect(isTap(AXIS_LOCK_PX, 10)).toBe(false)
    expect(isTap(0, TAP_MAX_MS)).toBe(false)
  })
})

describe('withinTapReach', () => {
  it('takes taps on and just around the drawn stick only', () => {
    const base = { x: 300, y: 600 }
    expect(TAP_REACH_PX).toBe(1.25 * STICK_RADIUS_PX)
    expect(withinTapReach(base, base)).toBe(true)
    expect(withinTapReach({ x: 300, y: 600 - TAP_REACH_PX }, base)).toBe(true)
    expect(withinTapReach({ x: 300 + TAP_REACH_PX + 1, y: 600 }, base)).toBe(false)
    // The zone's far corner.
    expect(withinTapReach({ x: 378, y: 804 }, base)).toBe(false)
  })
})

describe('rollFromDrag', () => {
  it('ignores a small wobble, rolls right for a drag right, saturates', () => {
    expect(rollFromDrag(100, 100 + ROLL_RANGE_PX * ROLL_DEAD_ZONE * 0.9)).toBe(0)
    expect(rollFromDrag(100, 100 - ROLL_RANGE_PX * ROLL_DEAD_ZONE * 0.9)).toBe(0)
    expect(rollFromDrag(100, 140)).toBeGreaterThan(0)
    expect(rollFromDrag(100, 60)).toBeLessThan(0)
    expect(rollFromDrag(100, 100 + ROLL_RANGE_PX)).toBe(1)
    expect(rollFromDrag(100, 100 - 5 * ROLL_RANGE_PX)).toBe(-1)
  })
})

describe('throttleToTrack', () => {
  it('maps full reverse to the bottom and full ahead to the top', () => {
    expect(throttleToTrack(THROTTLE_MIN)).toBe(0)
    expect(throttleToTrack(THROTTLE_MAX)).toBe(1)
    expect(throttleToTrack(0)).toBeCloseTo(0.2, 12)
    expect(throttleToTrack(5)).toBe(1)
  })

  it('puts the blue band where flight turns best', () => {
    expect(BLUE_BAND[0]).toBeCloseTo(throttleToTrack(BLUE_ZONE[0]), 12)
    expect(BLUE_BAND[1]).toBeCloseTo(throttleToTrack(BLUE_ZONE[1]), 12)
  })
})

describe('padAxes', () => {
  it('waits for AXIS_LOCK_PX of travel', () => {
    expect(padAxes(0, 0)).toBeNull()
    expect(padAxes(AXIS_LOCK_PX * 0.7, AXIS_LOCK_PX * 0.7)).toBeNull()
  })

  it('locks to the dominant axis, both only when clearly diagonal', () => {
    expect(padAxes(0, -AXIS_LOCK_PX)).toBe('throttle')
    expect(padAxes(10, 20)).toBe('throttle')
    expect(padAxes(-AXIS_LOCK_PX, 0)).toBe('roll')
    expect(padAxes(20, -10)).toBe('roll')
    expect(padAxes(20, 20)).toBe('both')
    expect(padAxes(-20, 15)).toBe('both')
    expect(AXIS_LOCK_RATIO).toBe(1.5)
  })
})

describe('clampStickOrigin', () => {
  it('holds the base clear of the left and bottom edges only', () => {
    const bounds = { minX: 70, maxY: 700 }
    expect(clampStickOrigin({ x: 20, y: 780 }, bounds)).toEqual({ x: 70, y: 700 })
    expect(clampStickOrigin({ x: 200, y: 300 }, bounds)).toEqual({ x: 200, y: 300 })
  })
})
