import { describe, expect, it } from 'vitest'
import {
  createShipKeys,
  releaseShipKeys,
  shipKeyAction,
  shipKeyDown,
  shipKeyUp,
  stepThrottle,
  THROTTLE_RATE,
  type ShipKeyEvent,
} from './desktop-keys'
import { THROTTLE_MAX, THROTTLE_MIN, type ShipInput } from './ship-input'

const key = (code: string, extra: Partial<ShipKeyEvent> = {}): ShipKeyEvent => ({
  code,
  key: code.replace(/^Key/, '').toLowerCase(),
  repeat: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...extra,
})

function setup() {
  const keys = createShipKeys()
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
    shipKeyDown(keys, key(code, extra), input)
  const up = (code: string) => shipKeyUp(keys, key(code), input)
  return { keys, input, down, up }
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
    const { down, input, keys } = setup()
    down('KeyD')
    expect(shipKeyUp(keys, key('KeyD', { metaKey: true }), input)).toBe(true)
    expect(input.strafeX).toBe(0)
    expect(shipKeyUp(keys, key('KeyD'), input)).toBe(false)
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
    const { down, up, keys, input } = setup()
    down('KeyW')
    stepThrottle(keys, input, 0.3)
    expect(input.throttle).toBeCloseTo(THROTTLE_RATE * 0.3, 12)
    up('KeyW')
    stepThrottle(keys, input, 1)
    expect(input.throttle).toBeCloseTo(THROTTLE_RATE * 0.3, 12)
    down('KeyS')
    stepThrottle(keys, input, 0.1)
    expect(input.throttle).toBeCloseTo(THROTTLE_RATE * 0.2, 12)
  })

  it('sweeps 0 to full in its share of the sweep time and clamps at both ends', () => {
    const { down, up, keys, input } = setup()
    down('KeyW')
    const seconds = THROTTLE_MAX / THROTTLE_RATE
    for (let t = 0; t < seconds - 1e-9; t += 0.05) stepThrottle(keys, input, 0.05)
    expect(input.throttle).toBeCloseTo(THROTTLE_MAX, 9)
    stepThrottle(keys, input, 5)
    expect(input.throttle).toBe(THROTTLE_MAX)
    up('KeyW')
    input.throttle = 0
    down('KeyS')
    stepThrottle(keys, input, 10)
    expect(input.throttle).toBe(THROTTLE_MIN)
  })

  it('stops at zero coming down from forward thrust until S is pressed afresh', () => {
    const { down, up, keys, input } = setup()
    input.throttle = 0.5
    down('KeyS')
    stepThrottle(keys, input, 0.3)
    expect(input.throttle).toBeCloseTo(0.5 - THROTTLE_RATE * 0.3, 12)
    stepThrottle(keys, input, 0.1)
    stepThrottle(keys, input, 0.1)
    stepThrottle(keys, input, 0.1)
    expect(input.throttle).toBe(0)
    down('KeyS', { repeat: true })
    stepThrottle(keys, input, 1)
    expect(input.throttle).toBe(0)
    up('KeyS')
    down('KeyS')
    stepThrottle(keys, input, 0.1)
    expect(input.throttle).toBeCloseTo(-THROTTLE_RATE * 0.1, 12)
  })

  it('stops at zero coming up from reverse until W is pressed afresh', () => {
    const { down, up, keys, input } = setup()
    input.throttle = -0.2
    down('KeyW')
    stepThrottle(keys, input, 1)
    expect(input.throttle).toBe(0)
    up('KeyW')
    down('KeyW')
    stepThrottle(keys, input, 0.1)
    expect(input.throttle).toBeCloseTo(THROTTLE_RATE * 0.1, 12)
  })

  it('only stops at zero when crossing it, not when the throttle moved elsewhere meanwhile', () => {
    const { down, keys, input } = setup()
    input.throttle = -0.2
    down('KeyW')
    input.throttle = 0.5 // e.g. the touch slider
    stepThrottle(keys, input, 0.1)
    expect(input.throttle).toBeCloseTo(0.5 + THROTTLE_RATE * 0.1, 12)
  })

  it('lets go of everything when Cmd is released (macOS drops those keyups)', () => {
    const { down, keys, input } = setup()
    down('KeyD')
    down('KeyQ')
    down('KeyW')
    expect(shipKeyUp(keys, { code: 'MetaLeft', key: 'Meta' }, input)).toBe(false)
    expect(keys.held.size).toBe(0)
    expect(input).toMatchObject({ strafeX: 0, roll: 0 })
  })

  it('holds the throttle when W and S are both down', () => {
    const { down, keys, input } = setup()
    input.throttle = 0.4
    down('KeyW')
    down('KeyS')
    stepThrottle(keys, input, 1)
    expect(input.throttle).toBe(0.4)
  })

  it('ignores bad frame times', () => {
    const { down, keys, input } = setup()
    down('KeyW')
    stepThrottle(keys, input, NaN)
    stepThrottle(keys, input, -1)
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
    const { down, keys, input } = setup()
    input.throttle = 0.6
    input.flightAssist = false
    for (const code of ['KeyW', 'KeyD', 'KeyR', 'KeyE', 'KeyL']) down(code)
    releaseShipKeys(keys, input)
    expect(keys.held.size).toBe(0)
    expect(input).toMatchObject({ strafeX: 0, strafeY: 0, roll: 0, level: false })
    expect(input.throttle).toBe(0.6)
    expect(input.flightAssist).toBe(false)
    stepThrottle(keys, input, 1)
    expect(input.throttle).toBe(0.6)
  })
})
