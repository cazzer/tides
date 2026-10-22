import { describe, expect, it } from 'vitest'
import {
  releaseShipKeys,
  shipKeyAction,
  shipKeyDown,
  shipKeyUp,
  stepThrottle,
  THROTTLE_RATE,
  THROTTLE_SWEEP_SECONDS,
  type HeldKeys,
  type ShipKeyEvent,
} from './desktop-keys'
import { THROTTLE_MAX, THROTTLE_MIN, type ShipInput } from './ship-input'

const key = (code: string, extra: Partial<ShipKeyEvent> = {}): ShipKeyEvent => ({
  code,
  repeat: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...extra,
})

function setup() {
  const held: HeldKeys = new Set()
  const input: ShipInput = {
    throttle: 0,
    strafeX: 0,
    strafeY: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    level: false,
    flightAssist: true,
  }
  const down = (code: string, extra?: Partial<ShipKeyEvent>) =>
    shipKeyDown(held, key(code, extra), input)
  const up = (code: string) => shipKeyUp(held, { code }, input)
  return { held, input, down, up }
}

describe('desktop ship keys (tides-3bl.3)', () => {
  it('maps by physical position and ignores unbound keys', () => {
    expect(shipKeyAction(key('KeyW'))).toBe('throttleUp')
    expect(shipKeyAction(key('KeyQ'))).toBe('rollLeft')
    expect(shipKeyAction(key('Escape'))).toBeNull()
    expect(shipKeyAction(key('Space'))).toBeNull()
    const { down, input } = setup()
    expect(down('KeyP')).toBe(false)
    expect(down('Escape')).toBe(false)
    expect(input.throttle).toBe(0)
  })

  it('leaves Cmd/Ctrl/Alt chords to the browser but not Shift', () => {
    const { down, input } = setup()
    expect(down('KeyR', { metaKey: true })).toBe(false)
    expect(down('KeyW', { ctrlKey: true })).toBe(false)
    expect(down('KeyD', { altKey: true })).toBe(false)
    expect(input.strafeY).toBe(0)
    expect(input.strafeX).toBe(0)
    expect(down('KeyD', { shiftKey: true } as Partial<ShipKeyEvent>)).toBe(true)
    expect(input.strafeX).toBe(1)
  })

  it('holds strafe and roll only while the key is down', () => {
    const { down, up, input } = setup()
    down('KeyA')
    expect(input.strafeX).toBe(-1)
    up('KeyA')
    expect(input.strafeX).toBe(0)
    down('KeyR')
    expect(input.strafeY).toBe(1)
    down('KeyF')
    expect(input.strafeY).toBe(0)
    up('KeyR')
    expect(input.strafeY).toBe(-1)
    up('KeyF')
    expect(input.strafeY).toBe(0)
    down('KeyQ')
    expect(input.roll).toBe(-1)
    down('KeyE')
    expect(input.roll).toBe(0)
    up('KeyQ')
    expect(input.roll).toBe(1)
  })

  it('holds level while L is down', () => {
    const { down, up, input } = setup()
    down('KeyL')
    down('KeyL', { repeat: true })
    expect(input.level).toBe(true)
    up('KeyL')
    expect(input.level).toBe(false)
  })

  it('releases on keyup even when a modifier went down meanwhile', () => {
    const { down, input, held } = setup()
    down('KeyD')
    expect(shipKeyUp(held, { code: 'KeyD' }, input)).toBe(true)
    expect(input.strafeX).toBe(0)
    expect(shipKeyUp(held, { code: 'KeyD' }, input)).toBe(false)
  })

  it('toggles Flight Assist on Z but not on auto-repeat', () => {
    const { down, up, input } = setup()
    down('KeyZ')
    expect(input.flightAssist).toBe(false)
    down('KeyZ', { repeat: true })
    down('KeyZ', { repeat: true })
    expect(input.flightAssist).toBe(false)
    up('KeyZ')
    down('KeyZ')
    expect(input.flightAssist).toBe(true)
  })

  it('ramps the throttle setpoint while W or S is held and keeps it after', () => {
    const { down, up, held, input } = setup()
    down('KeyW')
    stepThrottle(held, input, 0.3)
    expect(input.throttle).toBeCloseTo(THROTTLE_RATE * 0.3, 12)
    up('KeyW')
    stepThrottle(held, input, 1)
    expect(input.throttle).toBeCloseTo(THROTTLE_RATE * 0.3, 12)
    down('KeyS')
    stepThrottle(held, input, 0.1)
    expect(input.throttle).toBeCloseTo(THROTTLE_RATE * 0.2, 12)
  })

  it('sweeps the full range in the sweep time and clamps at both ends', () => {
    const { down, up, held, input } = setup()
    input.throttle = THROTTLE_MIN
    down('KeyW')
    for (let t = 0; t < THROTTLE_SWEEP_SECONDS - 1e-9; t += 0.1) stepThrottle(held, input, 0.1)
    expect(input.throttle).toBeCloseTo(THROTTLE_MAX, 9)
    stepThrottle(held, input, 5)
    expect(input.throttle).toBe(THROTTLE_MAX)
    up('KeyW')
    down('KeyS')
    stepThrottle(held, input, 10)
    expect(input.throttle).toBe(THROTTLE_MIN)
  })

  it('holds the throttle when W and S are both down', () => {
    const { down, held, input } = setup()
    input.throttle = 0.4
    down('KeyW')
    down('KeyS')
    stepThrottle(held, input, 1)
    expect(input.throttle).toBe(0.4)
  })

  it('ignores bad frame times', () => {
    const { down, held, input } = setup()
    down('KeyW')
    stepThrottle(held, input, NaN)
    stepThrottle(held, input, -1)
    expect(input.throttle).toBe(0)
  })

  it('zeroes the throttle on X', () => {
    const { down, input } = setup()
    input.throttle = 0.8
    expect(down('KeyX')).toBe(true)
    expect(input.throttle).toBe(0)
    input.throttle = -0.2
    down('KeyX')
    expect(input.throttle).toBe(0)
  })

  it('lets go of everything on release, keeping throttle and FA', () => {
    const { down, held, input } = setup()
    input.throttle = 0.6
    input.flightAssist = false
    for (const code of ['KeyW', 'KeyD', 'KeyR', 'KeyE', 'KeyL']) down(code)
    releaseShipKeys(held, input)
    expect(held.size).toBe(0)
    expect(input).toMatchObject({ strafeX: 0, strafeY: 0, roll: 0, level: false })
    expect(input.throttle).toBe(0.6)
    expect(input.flightAssist).toBe(false)
    stepThrottle(held, input, 1)
    expect(input.throttle).toBe(0.6)
  })
})
