import { beforeEach, describe, expect, it } from 'vitest'
import { resetShipInput, shipInput } from './ship-input'
import {
  bindSteer,
  bindThrottle,
  blockPagePinch,
  releaseOnInterruption,
  type ThrottleBinding,
} from './touch-controls'
import {
  AXIS_LOCK_PX,
  REVERSE_DETENT_MS,
  STICK_RADIUS_PX,
  TAP_MAX_MS,
  TAP_REACH_PX,
  THROTTLE_STICK_RATE,
} from './touch-stick'

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
    { id = 1, pointerType = 'touch', button = 0, t = 0 } = {}
  ) => {
    const flags = { stopped: false, prevented: false }
    listeners.get(type)?.({
      type,
      pointerId: id,
      pointerType,
      button,
      clientX: x,
      clientY: y,
      timeStamp: t,
      stopPropagation: () => (flags.stopped = true),
      preventDefault: () => (flags.prevented = true),
    } as unknown as PointerEvent)
    return flags
  }
  return { element: element as unknown as HTMLElement, listeners, captured, fire }
}

// `seconds` of 60 fps frames.
function run(binding: ThrottleBinding, seconds: number) {
  for (let i = 0; i < Math.round(seconds * 60); i++) binding.step(1 / 60)
}

const FRAME_STEP = THROTTLE_STICK_RATE / 60
// The drawn throttle stick's centre; the tests press on it unless they say.
const BASE = { x: 300, y: 500 }

describe('touch ship controls (tides-3bl.4)', () => {
  beforeEach(() => resetShipInput())

  it('steers from where the thumb lands and centres on release', () => {
    const steer = control()
    const sticks: unknown[] = []
    bindSteer(steer.element, shipInput, { onStick: (s) => sticks.push(s) })
    const down = steer.fire('pointerdown', 100, 500)
    expect(down).toEqual({ stopped: true, prevented: true })
    expect(steer.captured).toEqual([1])
    expect(sticks).toEqual([{ origin: { x: 100, y: 500 }, knob: { x: 100, y: 500 } }])
    expect(shipInput).toMatchObject({ pitch: 0, yaw: 0 })

    steer.fire('pointermove', 100 + STICK_RADIUS_PX, 500 - STICK_RADIUS_PX)
    expect(shipInput.pitch).toBeGreaterThan(0.5)
    expect(shipInput.yaw).toBeGreaterThan(0.5)

    steer.fire('pointerup', 100, 500)
    expect(shipInput.pitch).toBe(0)
    expect(shipInput.yaw).toBe(0)
    expect(sticks[sticks.length - 1]).toBeNull()
  })

  it('spawns the stick clear of the zone edges so full deflection is reachable', () => {
    const steer = control()
    const sticks: { origin: { x: number; y: number } }[] = []
    bindSteer(steer.element, shipInput, {
      onStick: (s) => s && sticks.push(s),
      spawnBounds: () => ({ minX: 70, maxY: 700 }),
    })
    steer.fire('pointerdown', 20, 780)
    expect(sticks[0].origin).toEqual({ x: 70, y: 700 })
    // The thumb sits left of and below the base, so it already turns.
    expect(shipInput.yaw).toBeLessThan(0)
    expect(shipInput.pitch).toBeLessThan(0)
    steer.fire('pointermove', 70 - STICK_RADIUS_PX, 700)
    expect(shipInput).toMatchObject({ pitch: 0, yaw: -1 })
    steer.fire('pointerup')

    steer.fire('pointerdown', 150, 500)
    expect(sticks[sticks.length - 1].origin).toEqual({ x: 150, y: 500 })
  })

  it('re-asserts a held turn that another writer zeroed, and stops once let go', () => {
    const steer = control()
    const binding = bindSteer(steer.element, shipInput)
    binding.reassert()
    steer.fire('pointerdown', 100, 500)
    steer.fire('pointermove', 100 + STICK_RADIUS_PX, 500)
    shipInput.yaw = 0
    binding.reassert()
    expect(shipInput.yaw).toBe(1)
    steer.fire('pointerup')
    shipInput.yaw = 0.3
    binding.reassert()
    expect(shipInput.yaw).toBe(0.3)
  })

  it('drives steer and throttle from two pointers independently', () => {
    const steer = control()
    const pad = control()
    bindSteer(steer.element, shipInput)
    const throttle = bindThrottle(pad.element, shipInput, { base: () => BASE })

    steer.fire('pointerdown', 100, 500, { id: 7 })
    pad.fire('pointerdown', 300, 500, { id: 9 })
    // Each control sees only its own pointer's moves.
    steer.fire('pointermove', 100 + STICK_RADIUS_PX, 500, { id: 9 })
    pad.fire('pointermove', 300, 500 - STICK_RADIUS_PX, { id: 7 })
    run(throttle, 0.1)
    expect(shipInput.yaw).toBe(0)
    expect(shipInput.throttle).toBe(0)

    steer.fire('pointermove', 100 + STICK_RADIUS_PX, 500, { id: 7 })
    pad.fire('pointermove', 300, 500 - STICK_RADIUS_PX, { id: 9 })
    run(throttle, 0.6)
    expect(shipInput.yaw).toBe(1)
    expect(shipInput.throttle).toBeCloseTo(THROTTLE_STICK_RATE * 0.6, 9)

    steer.fire('pointerup', 0, 0, { id: 7 })
    run(throttle, 0.1)
    expect(shipInput.yaw).toBe(0)
    expect(shipInput.throttle).toBeCloseTo(THROTTLE_STICK_RATE * 0.7, 9)
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

  it('lets a mouse pass through the touch controls untouched', () => {
    const steer = control()
    const pad = control()
    bindSteer(steer.element, shipInput)
    bindThrottle(pad.element, shipInput, { base: () => BASE })
    expect(steer.fire('pointerdown', 100, 500, { pointerType: 'mouse' })).toEqual({
      stopped: false,
      prevented: false,
    })
    steer.fire('pointermove', 100 + STICK_RADIUS_PX, 500, { pointerType: 'mouse' })
    expect(shipInput.yaw).toBe(0)
    shipInput.throttle = 0.5
    pad.fire('pointerdown', 300, 500, { pointerType: 'mouse' })
    pad.fire('pointerup', 300, 500, { pointerType: 'mouse', t: 50 })
    expect(shipInput.throttle).toBe(0.5)
  })

  it.each(['pointercancel', 'lostpointercapture'])(
    'lets go on %s, which is never a tap',
    (type) => {
      const steer = control()
      const pad = control()
      bindSteer(steer.element, shipInput)
      const throttle = bindThrottle(pad.element, shipInput, { base: () => BASE })
      shipInput.throttle = 0.5
      steer.fire('pointerdown', 100, 500, { id: 1 })
      steer.fire('pointermove', 100, 500 + STICK_RADIUS_PX, { id: 1 })
      pad.fire('pointerdown', 300, 500, { id: 2 })
      pad.fire('pointermove', 400, 495, { id: 2 })
      expect(shipInput.pitch).toBe(-1)
      expect(shipInput.roll).toBe(1)
      steer.fire(type, 0, 0, { id: 1 })
      pad.fire(type, 0, 0, { id: 2 })
      expect(shipInput.pitch).toBe(0)
      expect(shipInput.roll).toBe(0)
      expect(shipInput.throttle).toBe(0.5)

      // A press interrupted before it moved, as quick as a tap, still isn't one.
      pad.fire('pointerdown', 300, 500, { id: 3, t: 1000 })
      pad.fire(type, 300, 500, { id: 3, t: 1050 })
      expect(shipInput.throttle).toBe(0.5)
      run(throttle, 0.1)
      expect(shipInput.throttle).toBe(0.5)
    }
  )

  describe('throttle stick (tides-2hv.3)', () => {
    it('moves the throttle at a rate set by the push and holds it after release', () => {
      const pad = control()
      const throttle = bindThrottle(pad.element, shipInput, { base: () => BASE })
      shipInput.throttle = 0.5
      pad.fire('pointerdown', 300, 500, { t: 0 })
      pad.fire('pointermove', 300, 500 - STICK_RADIUS_PX, { t: 20 })
      run(throttle, 0.3)
      expect(shipInput.throttle).toBeCloseTo(0.5 + THROTTLE_STICK_RATE * 0.3, 9)
      pad.fire('pointerup', 300, 500 - STICK_RADIUS_PX, { t: 320 })
      const held = shipInput.throttle
      run(throttle, 0.5)
      expect(shipInput.throttle).toBe(held)
    })

    it('stops at 0 coming down; a fresh pull goes on into reverse', () => {
      const pad = control()
      const throttle = bindThrottle(pad.element, shipInput, { base: () => BASE })
      shipInput.throttle = 0.05
      pad.fire('pointerdown', 300, 500, { t: 0 })
      pad.fire('pointermove', 300, 500 + STICK_RADIUS_PX, { t: 20 })
      run(throttle, 0.2)
      expect(shipInput.throttle).toBe(0)
      expect(throttle.detentState()).toMatchObject({ arrivedFrom: 1 })
      pad.fire('pointerup', 300, 500 + STICK_RADIUS_PX, { t: 400 })
      expect(throttle.detentState()).toEqual({ arrivedFrom: 0, dwellMs: 0 })
      expect(shipInput.throttle).toBe(0)

      pad.fire('pointerdown', 300, 500, { t: 1000 })
      pad.fire('pointermove', 300, 500 + STICK_RADIUS_PX, { t: 1020 })
      run(throttle, 0.1)
      expect(shipInput.throttle).toBeCloseTo(-FRAME_STEP * 6, 9)
    })

    it('goes on into reverse after a pull held at 0 for REVERSE_DETENT_MS', () => {
      const pad = control()
      const throttle = bindThrottle(pad.element, shipInput, { base: () => BASE })
      shipInput.throttle = 0.01
      pad.fire('pointerdown', 300, 500, { t: 0 })
      pad.fire('pointermove', 300, 500 + STICK_RADIUS_PX, { t: 20 })
      run(throttle, 1 / 60 + 0.25)
      expect(shipInput.throttle).toBe(0)
      expect(throttle.detentState().dwellMs).toBeCloseTo(250, 6)
      run(throttle, REVERSE_DETENT_MS / 1000 - 0.25 + 0.1)
      expect(shipInput.throttle).toBeLessThan(0)
    })

    it('zeroes the throttle on a tap', () => {
      const pad = control()
      let taps = 0
      const throttle = bindThrottle(pad.element, shipInput, {
        base: () => BASE,
        onTap: () => taps++,
      })
      shipInput.throttle = 0.7
      pad.fire('pointerdown', 300, 500, { t: 1000 })
      pad.fire('pointermove', 305, 497, { t: 1050 })
      run(throttle, 0.05)
      expect(shipInput.throttle).toBe(0.7)
      pad.fire('pointerup', 305, 497, { t: 1000 + TAP_MAX_MS - 1 })
      expect(shipInput.throttle).toBe(0)

      shipInput.throttle = -0.2
      pad.fire('pointerdown', 300, 500, { t: 2000 })
      pad.fire('pointerup', 300, 500, { t: 2010 })
      expect(shipInput.throttle).toBe(0)
      expect(taps).toBe(2)
    })

    it('takes taps only on the drawn stick: a brush in the far corner of the zone does nothing', () => {
      const pad = control()
      let taps = 0
      bindThrottle(pad.element, shipInput, { base: () => BASE, onTap: () => taps++ })
      shipInput.throttle = 0.6
      // The review's case: an 80 ms touch in the zone's bottom-right corner.
      pad.fire('pointerdown', 378, 804, { t: 0 })
      pad.fire('pointerup', 378, 804, { t: 80 })
      expect(shipInput.throttle).toBe(0.6)
      // Just outside the reach, still nothing; just inside, a tap.
      pad.fire('pointerdown', BASE.x + TAP_REACH_PX + 1, BASE.y, { t: 1000 })
      pad.fire('pointerup', BASE.x + TAP_REACH_PX + 1, BASE.y, { t: 1050 })
      expect(shipInput.throttle).toBe(0.6)
      expect(taps).toBe(0)
      pad.fire('pointerdown', BASE.x, BASE.y + TAP_REACH_PX - 1, { t: 2000 })
      pad.fire('pointerup', BASE.x, BASE.y + TAP_REACH_PX - 1, { t: 2050 })
      expect(shipInput.throttle).toBe(0)
      expect(taps).toBe(1)
    })

    it('still drags from anywhere in the zone', () => {
      const pad = control()
      const throttle = bindThrottle(pad.element, shipInput, { base: () => BASE })
      shipInput.throttle = 0.2
      pad.fire('pointerdown', 378, 804, { t: 0 })
      pad.fire('pointermove', 378, 804 - STICK_RADIUS_PX, { t: 20 })
      run(throttle, 0.3)
      expect(shipInput.throttle).toBeCloseTo(0.2 + THROTTLE_STICK_RATE * 0.3, 9)
    })

    it('does not count a slow press or one that travelled as a tap', () => {
      const pad = control()
      bindThrottle(pad.element, shipInput, { base: () => BASE })
      shipInput.throttle = 0.7
      pad.fire('pointerdown', 300, 500, { t: 0 })
      pad.fire('pointerup', 300, 500, { t: TAP_MAX_MS })
      expect(shipInput.throttle).toBe(0.7)

      // Out past the axis lock and back again, quickly.
      pad.fire('pointerdown', 300, 500, { t: 1000 })
      pad.fire('pointermove', 300 + AXIS_LOCK_PX, 500, { t: 1030 })
      pad.fire('pointermove', 300, 500, { t: 1060 })
      pad.fire('pointerup', 300, 500, { t: 1090 })
      expect(shipInput.throttle).toBe(0.7)
    })

    it('springs the knob back on release', () => {
      const pad = control()
      const sticks: unknown[] = []
      bindThrottle(pad.element, shipInput, { base: () => BASE, onStick: (s) => sticks.push(s) })
      pad.fire('pointerdown', 300, 500)
      pad.fire('pointermove', 302, 500 - 3 * STICK_RADIUS_PX)
      // Locked to the throttle: the knob runs straight up, held to the rim.
      expect(sticks[sticks.length - 1]).toEqual({
        origin: { x: 300, y: 500 },
        knob: { x: 300, y: 500 - STICK_RADIUS_PX },
      })
      pad.fire('pointerup', 302, 500 - 3 * STICK_RADIUS_PX, { t: 400 })
      expect(sticks[sticks.length - 1]).toBeNull()
    })
  })

  describe('axis lock on the throttle stick', () => {
    const drag = (dx: number, dy: number) => {
      const pad = control()
      const throttle = bindThrottle(pad.element, shipInput, { base: () => BASE })
      shipInput.throttle = 0.5
      pad.fire('pointerdown', 300, 500)
      pad.fire('pointermove', 300 + dx, 500 + dy)
      run(throttle, 0.1)
      return { pad, throttle }
    }

    it('does nothing until the drag has travelled a little', () => {
      drag(AXIS_LOCK_PX * 0.6, -AXIS_LOCK_PX * 0.6)
      expect(shipInput).toMatchObject({ throttle: 0.5, roll: 0 })
    })

    it('locks a mostly vertical drag to the throttle', () => {
      const { pad, throttle } = drag(5, -STICK_RADIUS_PX)
      expect(shipInput.throttle).toBeGreaterThan(0.5)
      pad.fire('pointermove', 400, 500)
      const was = shipInput.throttle
      run(throttle, 0.1)
      expect(shipInput.roll).toBe(0)
      expect(shipInput.throttle).toBe(was)
    })

    it('locks a mostly horizontal drag to roll', () => {
      const { pad, throttle } = drag(30, 5)
      expect(shipInput.roll).toBeGreaterThan(0)
      pad.fire('pointermove', 360, 300)
      run(throttle, 0.1)
      expect(shipInput.roll).toBe(1)
      expect(shipInput.throttle).toBe(0.5)
    })

    it('drives both for a clearly diagonal start', () => {
      drag(40, -40)
      expect(shipInput.roll).toBeGreaterThan(0)
      expect(shipInput.throttle).toBeGreaterThan(0.5)
    })

    it('decides afresh on each press', () => {
      const { pad } = drag(0, -40)
      pad.fire('pointerup', 0, -40, { t: 1000 })
      pad.fire('pointerdown', 300, 500)
      pad.fire('pointermove', 300 + STICK_RADIUS_PX, 500)
      expect(shipInput.roll).toBe(1)
    })
  })

  it('lets go of everything on blur, hide, resize or a turn of the phone, and on dispose', () => {
    const steer = control()
    const pad = control()
    const steerBinding = bindSteer(steer.element, shipInput)
    const throttle = bindThrottle(pad.element, shipInput, { base: () => BASE })
    const bindings = [steerBinding, throttle]
    const win = control()
    const doc = control()
    const orientation = control()
    const docElement = Object.assign(doc.element, { visibilityState: 'visible' })
    const winElement = Object.assign(win.element, { innerWidth: 390 })
    const stop = releaseOnInterruption(
      {
        win: winElement as unknown as Window,
        doc: docElement as unknown as Document,
        orientation: orientation.element,
      },
      () => bindings.forEach((b) => b.release())
    )

    shipInput.throttle = 0.5
    // A diagonal throttle-stick drag: rolls left and pushes the throttle up.
    const press = () => {
      steer.fire('pointerdown', 100, 500, { id: 1 })
      steer.fire('pointermove', 100 + STICK_RADIUS_PX, 500, { id: 1 })
      pad.fire('pointerdown', 300, 500, { id: 2 })
      pad.fire('pointermove', 300 - STICK_RADIUS_PX, 500 - STICK_RADIUS_PX, { id: 2 })
      expect(shipInput).toMatchObject({ yaw: 1, roll: -1 })
    }
    // Nothing held, the throttle where it was, and no stepping after.
    const released = () => {
      expect(shipInput).toMatchObject({ pitch: 0, yaw: 0, roll: 0 })
      const was = shipInput.throttle
      run(throttle, 0.1)
      expect(shipInput.throttle).toBe(was)
      expect(was).toBe(0.5)
    }

    press()
    win.fire('blur')
    released()
    // A finger still down after the blur no longer steers or rolls.
    steer.fire('pointermove', 100 + STICK_RADIUS_PX, 500, { id: 1 })
    pad.fire('pointermove', 300 - STICK_RADIUS_PX, 500, { id: 2 })
    expect(shipInput).toMatchObject({ yaw: 0, roll: 0 })
    // Its lift, ending nothing, isn't a tap either.
    pad.fire('pointerup', 300, 500, { id: 2, t: 10 })
    expect(shipInput.throttle).toBe(0.5)

    press()
    doc.fire('visibilitychange')
    expect(shipInput.yaw).toBe(1)
    docElement.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    released()

    press()
    // Height only: Safari's toolbars sliding in or out. The thumbs keep hold.
    win.fire('resize')
    expect(shipInput).toMatchObject({ yaw: 1, roll: -1 })
    winElement.innerWidth = 844
    win.fire('resize')
    released()

    press()
    orientation.fire('change')
    released()

    stop()
    expect(win.listeners.size + doc.listeners.size + orientation.listeners.size).toBe(0)

    press()
    bindings.forEach((b) => b.dispose())
    released()
    expect(steer.listeners.size + pad.listeners.size).toBe(0)
  })

  it('works without screen.orientation', () => {
    const win = control()
    const winElement = Object.assign(win.element, { innerWidth: 390 })
    const doc = Object.assign(control().element, { visibilityState: 'visible' })
    let released = 0
    const stop = releaseOnInterruption(
      { win: winElement as unknown as Window, doc: doc as unknown as Document, orientation: null },
      () => released++
    )
    win.fire('resize')
    expect(released).toBe(0)
    winElement.innerWidth = 844
    win.fire('resize')
    expect(released).toBe(1)
    stop()
  })

  it("blocks Safari's page pinch while mounted", () => {
    const doc = control()
    const unblock = blockPagePinch(doc.element)
    expect(doc.fire('gesturestart').prevented).toBe(true)
    expect(doc.fire('gesturechange').prevented).toBe(true)
    unblock()
    expect(doc.listeners.size).toBe(0)
  })
})
