import { beforeEach, describe, expect, it } from 'vitest'
import { resetShipInput, shipInput } from './ship-input'
import {
  bindFlightAssist,
  bindLevel,
  bindSteer,
  bindThrottle,
  releaseWhenBackgrounded,
} from './touch-controls'
import { STICK_RADIUS_PX } from './touch-stick'

type Listener = (event: Event) => void

// Just enough of a control's element to drive its handlers.
function control() {
  const listeners = new Map<string, Listener>()
  const captured: number[] = []
  const element = {
    setPointerCapture: (id: number) => captured.push(id),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  }
  const fire = (
    type: string,
    x = 0,
    y = 0,
    { id = 1, pointerType = 'touch', button = 0 } = {}
  ) => {
    const flags = { stopped: false, prevented: false }
    listeners.get(type)?.({
      type,
      pointerId: id,
      pointerType,
      button,
      clientX: x,
      clientY: y,
      stopPropagation: () => (flags.stopped = true),
      preventDefault: () => (flags.prevented = true),
    } as unknown as PointerEvent)
    return flags
  }
  return { element: element as unknown as HTMLElement, listeners, captured, fire }
}

describe('touch ship controls (tides-3bl.4)', () => {
  beforeEach(() => resetShipInput())

  it('steers from where the thumb lands and centres on release', () => {
    const steer = control()
    const sticks: unknown[] = []
    bindSteer(steer.element, shipInput, (s) => sticks.push(s))
    const down = steer.fire('pointerdown', 100, 500)
    expect(down).toEqual({ stopped: true, prevented: true })
    expect(steer.captured).toEqual([1])
    expect(sticks).toEqual([{ origin: { x: 100, y: 500 }, knob: { x: 100, y: 500 } }])

    steer.fire('pointermove', 100 + STICK_RADIUS_PX, 500 - STICK_RADIUS_PX)
    expect(shipInput.pitch).toBeGreaterThan(0.5)
    expect(shipInput.yaw).toBeGreaterThan(0.5)

    steer.fire('pointerup', 100, 500)
    expect(shipInput.pitch).toBe(0)
    expect(shipInput.yaw).toBe(0)
    expect(sticks[sticks.length - 1]).toBeNull()
  })

  it('drives steer and throttle from two pointers independently', () => {
    const steer = control()
    const pad = control()
    bindSteer(steer.element, shipInput)
    bindThrottle(pad.element, shipInput, () => 200)

    steer.fire('pointerdown', 100, 500, { id: 7 })
    pad.fire('pointerdown', 300, 500, { id: 9 })
    // Each control sees only its own pointer's moves.
    steer.fire('pointermove', 100 + STICK_RADIUS_PX, 500, { id: 9 })
    pad.fire('pointermove', 300, 400, { id: 7 })
    expect(shipInput.yaw).toBe(0)
    expect(shipInput.throttle).toBe(0)

    steer.fire('pointermove', 100 + STICK_RADIUS_PX, 500, { id: 7 })
    pad.fire('pointermove', 300, 400, { id: 9 })
    expect(shipInput.yaw).toBe(1)
    expect(shipInput.throttle).toBeCloseTo(0.625, 12)

    steer.fire('pointerup', 0, 0, { id: 7 })
    expect(shipInput.yaw).toBe(0)
    expect(shipInput.throttle).toBeCloseTo(0.625, 12)
  })

  it('ignores a second finger on a control that is already held', () => {
    const steer = control()
    bindSteer(steer.element, shipInput)
    steer.fire('pointerdown', 100, 500, { id: 1 })
    steer.fire('pointerdown', 200, 500, { id: 2 })
    expect(steer.captured).toEqual([1])
    steer.fire('pointermove', 200 + STICK_RADIUS_PX, 500, { id: 2 })
    expect(shipInput.yaw).toBe(0)
    steer.fire('pointerup', 0, 0, { id: 2 })
    steer.fire('pointermove', 100 + STICK_RADIUS_PX, 500, { id: 1 })
    expect(shipInput.yaw).toBe(1)
  })

  it('lets a mouse pass through the touch pads untouched', () => {
    const steer = control()
    bindSteer(steer.element, shipInput)
    expect(steer.fire('pointerdown', 100, 500, { pointerType: 'mouse' })).toEqual({
      stopped: false,
      prevented: false,
    })
    steer.fire('pointermove', 100 + STICK_RADIUS_PX, 500, { pointerType: 'mouse' })
    expect(shipInput.yaw).toBe(0)
  })

  it.each(['pointercancel', 'lostpointercapture'])('lets go on %s', (type) => {
    const steer = control()
    const pad = control()
    bindSteer(steer.element, shipInput)
    bindThrottle(pad.element, shipInput, () => 200)
    steer.fire('pointerdown', 100, 500, { id: 1 })
    steer.fire('pointermove', 100, 500 + STICK_RADIUS_PX, { id: 1 })
    pad.fire('pointerdown', 300, 500, { id: 2 })
    pad.fire('pointermove', 400, 450, { id: 2 })
    expect(shipInput.pitch).toBe(-1)
    expect(shipInput.roll).toBe(1)
    steer.fire(type, 0, 0, { id: 1 })
    pad.fire(type, 0, 0, { id: 2 })
    expect(shipInput.pitch).toBe(0)
    expect(shipInput.roll).toBe(0)
    expect(shipInput.throttle).toBeGreaterThan(0)
  })

  it('moves the throttle from where it stood and keeps it after release', () => {
    const pad = control()
    bindThrottle(pad.element, shipInput, () => 200)
    shipInput.throttle = 0.5
    pad.fire('pointerdown', 300, 500)
    pad.fire('pointermove', 300, 500)
    expect(shipInput.throttle).toBe(0.5)
    pad.fire('pointermove', 300, 460)
    expect(shipInput.throttle).toBeCloseTo(0.75, 12)
    pad.fire('pointerup', 300, 460)
    expect(shipInput.throttle).toBeCloseTo(0.75, 12)

    pad.fire('pointerdown', 300, 300)
    pad.fire('pointermove', 300, 2000)
    expect(shipInput.throttle).toBe(-0.25)
  })

  it('levels only while the level button is held', () => {
    const level = control()
    bindLevel(level.element, shipInput)
    level.fire('pointerdown', 0, 0, { pointerType: 'mouse', button: 2 })
    expect(shipInput.level).toBe(false)
    level.fire('pointerdown')
    expect(shipInput.level).toBe(true)
    level.fire('pointerup')
    expect(shipInput.level).toBe(false)
    level.fire('pointerdown', 0, 0, { pointerType: 'mouse' })
    expect(shipInput.level).toBe(true)
    level.fire('lostpointercapture', 0, 0, { pointerType: 'mouse' })
    expect(shipInput.level).toBe(false)
  })

  it('levels while Space or Enter is held on the focused level button', () => {
    const level = control()
    bindLevel(level.element, shipInput)
    const key = (type: string, key: string) =>
      level.listeners.get(type)?.({
        type,
        key,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as KeyboardEvent)
    key('keydown', 'x')
    expect(shipInput.level).toBe(false)
    key('keydown', ' ')
    expect(shipInput.level).toBe(true)
    key('keyup', ' ')
    expect(shipInput.level).toBe(false)
    key('keydown', 'Enter')
    level.listeners.get('blur')?.({ type: 'blur' } as Event)
    expect(shipInput.level).toBe(false)
  })

  it('toggles Flight Assist on click without reaching the scene', () => {
    const chip = control()
    const dispose = bindFlightAssist(chip.element, shipInput)
    expect(chip.fire('pointerdown').stopped).toBe(true)
    expect(chip.fire('click').stopped).toBe(true)
    expect(shipInput.flightAssist).toBe(false)
    chip.fire('click')
    expect(shipInput.flightAssist).toBe(true)
    dispose()
    expect(chip.listeners.size).toBe(0)
  })

  it('lets go of everything on blur or when hidden, and on dispose', () => {
    const steer = control()
    const pad = control()
    const level = control()
    const bindings = [
      bindSteer(steer.element, shipInput),
      bindThrottle(pad.element, shipInput, () => 200),
      bindLevel(level.element, shipInput),
    ]
    const win = control()
    const doc = control()
    const docElement = Object.assign(doc.element, { visibilityState: 'visible' })
    const stop = releaseWhenBackgrounded(
      win.element as unknown as Window,
      docElement as unknown as Document,
      () => bindings.forEach((b) => b.release())
    )

    const press = () => {
      steer.fire('pointerdown', 100, 500, { id: 1 })
      steer.fire('pointermove', 100 + STICK_RADIUS_PX, 500, { id: 1 })
      pad.fire('pointerdown', 300, 500, { id: 2 })
      pad.fire('pointermove', 240, 400, { id: 2 })
      level.fire('pointerdown', 0, 0, { id: 3 })
      expect(shipInput).toMatchObject({ yaw: 1, roll: -1, level: true })
    }
    const released = () =>
      expect(shipInput).toMatchObject({ pitch: 0, yaw: 0, roll: 0, level: false })

    press()
    win.fire('blur')
    released()
    // A finger still down after the blur no longer steers.
    steer.fire('pointermove', 100 + STICK_RADIUS_PX, 500, { id: 1 })
    expect(shipInput.yaw).toBe(0)

    press()
    doc.fire('visibilitychange')
    expect(shipInput.yaw).toBe(1)
    docElement.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    released()

    stop()
    expect(win.listeners.size).toBe(0)
    expect(doc.listeners.size).toBe(0)

    press()
    bindings.forEach((b) => b.dispose())
    released()
    expect(shipInput.throttle).toBeGreaterThan(0)
    expect(steer.listeners.size + pad.listeners.size + level.listeners.size).toBe(0)
  })
})
