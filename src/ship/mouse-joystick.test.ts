import { describe, expect, it } from 'vitest'
import {
  JOYSTICK_DEAD_ZONE,
  JOYSTICK_EXPONENT,
  JOYSTICK_SATURATION,
  joystickDemand,
  mouseSteer,
} from './mouse-joystick'

const SHORT = 1000
const dead = JOYSTICK_DEAD_ZONE * SHORT
const sat = JOYSTICK_SATURATION * SHORT

describe('mouse virtual joystick (tides-3bl.3)', () => {
  it('holds still at the centre and anywhere in the dead zone', () => {
    expect(joystickDemand(0, 0, SHORT)).toEqual({ pitch: 0, yaw: 0, x: 0, y: 0 })
    for (const [dx, dy] of [
      [dead, 0],
      [0, -dead],
      [dead * 0.7, dead * 0.7],
    ]) {
      const d = joystickDemand(dx, dy, SHORT)
      expect(d.pitch).toBe(0)
      expect(d.yaw).toBe(0)
    }
  })

  it('still reports the offset inside the dead zone for the widget', () => {
    const d = joystickDemand(dead / 2, 0, SHORT)
    expect(d.x).toBeCloseTo(dead / 2 / sat, 12)
    expect(d.y).toBe(0)
  })

  it('maps right to yaw+ and up to pitch+ (nose up)', () => {
    const right = joystickDemand(sat, 0, SHORT)
    expect(right.yaw).toBeCloseTo(1, 12)
    expect(right.pitch).toBe(0)
    const up = joystickDemand(0, -sat, SHORT)
    expect(up.pitch).toBeCloseTo(1, 12)
    expect(up.yaw).toBe(0)
    const downLeft = joystickDemand(-sat / 2, sat / 2, SHORT)
    expect(downLeft.pitch).toBeLessThan(0)
    expect(downLeft.yaw).toBeLessThan(0)
  })

  it('rises along the response curve from the dead-zone edge', () => {
    const halfway = dead + (sat - dead) / 2
    expect(joystickDemand(halfway, 0, SHORT).yaw).toBeCloseTo(0.5 ** JOYSTICK_EXPONENT, 12)
    const just = joystickDemand(dead + 1, 0, SHORT).yaw
    expect(just).toBeGreaterThan(0)
    expect(just).toBeLessThan(0.01)
  })

  it('is monotonic in distance', () => {
    let last = -1
    for (let r = 0; r <= sat * 1.5; r += 5) {
      const yaw = joystickDemand(r, 0, SHORT).yaw
      expect(yaw).toBeGreaterThanOrEqual(last)
      last = yaw
    }
  })

  it('saturates and clamps to the unit circle beyond the saturation radius', () => {
    const far = joystickDemand(sat * 3, -sat * 3, SHORT)
    expect(Math.hypot(far.pitch, far.yaw)).toBeCloseTo(1, 12)
    expect(far.yaw).toBeCloseTo(Math.SQRT1_2, 12)
    expect(far.pitch).toBeCloseTo(Math.SQRT1_2, 12)
    expect(Math.hypot(far.x, far.y)).toBeCloseTo(1, 12)
    for (let a = 0; a < Math.PI * 2; a += 0.3) {
      const d = joystickDemand(Math.cos(a) * 5000, Math.sin(a) * 5000, SHORT)
      expect(Math.hypot(d.pitch, d.yaw)).toBeLessThanOrEqual(1 + 1e-12)
    }
  })

  it('scales with the view', () => {
    const small = joystickDemand(100, 0, 400)
    const large = joystickDemand(250, 0, 1000)
    expect(small.yaw).toBeCloseTo(large.yaw, 12)
  })

  it('returns zero for degenerate input', () => {
    expect(joystickDemand(10, 10, 0)).toEqual({ pitch: 0, yaw: 0, x: 0, y: 0 })
    expect(joystickDemand(NaN, 0, SHORT)).toEqual({ pitch: 0, yaw: 0, x: 0, y: 0 })
  })
})

describe('mouse joystick arming (tides-3bl.3)', () => {
  const free = { overUi: false, dialogOpen: false }

  it('does not steer from wherever the cursor starts', () => {
    const s = mouseSteer(false, sat, sat, SHORT, free)
    expect(s).toMatchObject({ pitch: 0, yaw: 0, armed: false, mode: 'unarmed' })
    // The widget still shows where the cursor is.
    expect(Math.hypot(s.x, s.y)).toBeCloseTo(1, 12)
  })

  it('arms once the cursor passes through the dead zone, then steers', () => {
    const centre = mouseSteer(false, dead / 2, 0, SHORT, free)
    expect(centre).toMatchObject({ armed: true, mode: 'holding', pitch: 0, yaw: 0 })
    const out = mouseSteer(centre.armed, sat, 0, SHORT, free)
    expect(out.mode).toBe('steering')
    expect(out.armed).toBe(true)
    expect(out.yaw).toBeCloseTo(1, 12)
  })

  it('holds over a control without disarming', () => {
    const s = mouseSteer(true, sat, 0, SHORT, { overUi: true, dialogOpen: false })
    expect(s).toMatchObject({ pitch: 0, yaw: 0, armed: true, mode: 'holding' })
    expect(s.x).toBeCloseTo(1, 12)
    expect(mouseSteer(s.armed, sat, 0, SHORT, free).mode).toBe('steering')
  })

  it('disarms while a dialog is open, even at the centre', () => {
    const open = { overUi: false, dialogOpen: true }
    expect(mouseSteer(true, sat, 0, SHORT, open)).toMatchObject({ yaw: 0, armed: false, mode: 'unarmed' })
    expect(mouseSteer(false, 0, 0, SHORT, open)).toMatchObject({ armed: false, mode: 'unarmed' })
    // Closed again: back through the centre before it steers.
    expect(mouseSteer(false, sat, 0, SHORT, free).mode).toBe('unarmed')
    expect(mouseSteer(false, 0, 0, SHORT, free).armed).toBe(true)
  })
})
