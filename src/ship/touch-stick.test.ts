import { describe, expect, it } from 'vitest'
import { BLUE_ZONE } from './flight'
import { THROTTLE_MAX, THROTTLE_MIN } from './ship-input'
import {
  BLUE_BAND,
  CURVE_EXPONENT,
  DEAD_ZONE,
  ROLL_DEAD_ZONE,
  ROLL_RANGE_PX,
  STICK_RADIUS_PX,
  rollFromDrag,
  shapeAxis,
  stickDemand,
  stickKnob,
  throttleFromDrag,
  throttleToTrack,
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

describe('throttleFromDrag', () => {
  it('keeps the setpoint when the thumb has not moved', () => {
    expect(throttleFromDrag(0.6, 300, 300, 200)).toBe(0.6)
  })

  it('sweeps the whole range over the track height', () => {
    expect(throttleFromDrag(THROTTLE_MIN, 400, 200, 200)).toBeCloseTo(THROTTLE_MAX, 12)
    expect(throttleFromDrag(0, 300, 260, 200)).toBeCloseTo(0.25, 12)
    expect(throttleFromDrag(0.5, 300, 340, 200)).toBeCloseTo(0.25, 12)
  })

  it('clamps to reverse and full ahead', () => {
    expect(throttleFromDrag(0.5, 300, 0, 200)).toBe(THROTTLE_MAX)
    expect(throttleFromDrag(0.5, 300, 900, 200)).toBe(THROTTLE_MIN)
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
    expect(BLUE_BAND).toEqual([0.6, 0.8])
  })
})
