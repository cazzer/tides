import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindDesktopShipInput, type JoystickDisplay } from './useDesktopShipInput'
import { THROTTLE_RATE } from './desktop-keys'
import { JOYSTICK_SATURATION } from './mouse-joystick'
import type { ShipInput } from './ship-input'

type Listener = (event: never) => void

// Just enough of window and document for the binding.
function fakeTarget() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    listeners,
    addEventListener: (type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener: (type: string, listener: Listener) => listeners.get(type)?.delete(listener),
    fire(type: string, event: object = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event as never)
    },
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  }
}

// An element whose closest() matches when its tag is in the selector list.
const element = (tag: string) => ({
  closest: (selector: string) =>
    selector.split(',').some((s) => s.trim() === tag) ? element(tag) : null,
})

function setup({ fine = true, dialog = false } = {}) {
  const win = fakeTarget()
  const doc = Object.assign(fakeTarget(), {
    visibilityState: 'visible',
    querySelector: (selector: string) => (dialog && selector === 'dialog[open]' ? {} : null),
  })
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 1
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('matchMedia', () => ({ matches: fine }))
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(nextFrame, cb)
    return nextFrame++
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const runFrame = (now: number) => {
    const pending = [...frames.values()]
    frames.clear()
    for (const cb of pending) cb(now)
  }

  const input: ShipInput = {
    throttle: 0,
    strafeX: 0,
    strafeY: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    level: false,
    flightAssist: true,
    boost: false,
  }
  const drawn = { visible: false, x: 0, y: 0, mode: '' }
  const display: JoystickDisplay = {
    setVisible: (visible) => (drawn.visible = visible),
    draw: (x, y, mode) => Object.assign(drawn, { x, y, mode }),
  }
  // A 1000×800 view at the window's origin: centre (500, 400), short side 800.
  const area = {
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 }),
  } as HTMLElement
  const cleanup = bindDesktopShipInput(area, display, input)

  const key = (type: 'keydown' | 'keyup', code: string, extra: object = {}) => {
    const event = {
      code,
      key: code.replace(/^Key/, '').toLowerCase(),
      repeat: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      defaultPrevented: false,
      target: element('body'),
      preventDefault: vi.fn(),
      ...extra,
    }
    win.fire(type, event)
    return event
  }
  const move = (x: number, y: number, extra: object = {}) =>
    win.fire('pointermove', { pointerType: 'mouse', clientX: x, clientY: y, target: element('canvas'), ...extra })

  // Bring the cursor to the centre so the joystick arms.
  const arm = () => move(500, 400)

  return { win, doc, input, drawn, cleanup, key, move, arm, runFrame, frames }
}

describe('desktop ship input binding (tides-3bl.3)', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('handles ship keys and leaves others alone', () => {
    const { key, input } = setup()
    const d = key('keydown', 'KeyD')
    expect(d.preventDefault).toHaveBeenCalled()
    expect(input.strafeX).toBe(1)
    expect(key('keyup', 'KeyD').preventDefault).toHaveBeenCalled()
    expect(input.strafeX).toBe(0)
    expect(key('keydown', 'Escape').preventDefault).not.toHaveBeenCalled()
    expect(key('keydown', 'KeyR', { metaKey: true }).preventDefault).not.toHaveBeenCalled()
    expect(input.strafeY).toBe(0)
  })

  it('ignores keys while typing, behind an open dialog, or already handled', () => {
    expect(setup().key('keydown', 'KeyA', { target: element('input') }).preventDefault).not.toHaveBeenCalled()
    expect(setup().key('keydown', 'KeyA', { defaultPrevented: true }).preventDefault).not.toHaveBeenCalled()
    const { key, input } = setup({ dialog: true })
    key('keydown', 'KeyZ')
    expect(input.flightAssist).toBe(true)
  })

  it('ramps the throttle on animation frames only while W is held', () => {
    const { key, input, runFrame, frames } = setup()
    key('keydown', 'KeyW')
    key('keydown', 'KeyW', { repeat: true })
    expect(frames.size).toBe(1)
    runFrame(1000)
    runFrame(1050)
    runFrame(1100)
    expect(input.throttle).toBeCloseTo(THROTTLE_RATE * 0.1, 9)
    key('keyup', 'KeyW')
    expect(frames.size).toBe(0)
    runFrame(2000)
    expect(input.throttle).toBeCloseTo(THROTTLE_RATE * 0.1, 9)
  })

  it('steers with the mouse offset from the view centre once armed', () => {
    const { move, input, drawn } = setup()
    move(900, 400)
    expect(input.yaw).toBe(0)
    expect(drawn).toMatchObject({ visible: true, mode: 'unarmed' })
    move(500, 400)
    expect(input.pitch).toBe(0)
    expect(input.yaw).toBe(0)
    expect(drawn.mode).toBe('holding')
    move(500 + 800 * JOYSTICK_SATURATION, 400)
    expect(input.yaw).toBeCloseTo(1, 9)
    expect(drawn).toMatchObject({ visible: true, mode: 'steering' })
    expect(drawn.x).toBeCloseTo(1, 9)
    move(500, 400 - 800 * JOYSTICK_SATURATION)
    expect(input.pitch).toBeCloseTo(1, 9)
  })

  it('holds steady over controls but keeps the widget tracking', () => {
    const { move, arm, input, drawn } = setup()
    arm()
    move(900, 100)
    expect(input.yaw).toBeGreaterThan(0)
    move(900, 100, { target: element('button') })
    expect(input).toMatchObject({ pitch: 0, yaw: 0 })
    expect(drawn.mode).toBe('holding')
    expect(drawn.x).toBeGreaterThan(0)
  })

  it('ignores touch and pen moves and lets a touch take over', () => {
    const { move, arm, win, input, drawn } = setup()
    arm()
    move(900, 400)
    move(100, 400, { pointerType: 'touch' })
    expect(input.yaw).toBeGreaterThan(0)
    win.fire('pointerdown', { pointerType: 'touch' })
    expect(input.yaw).toBe(0)
    expect(drawn.visible).toBe(false)
  })

  it("leaves a touch stick's turn alone when the mouse wasn't steering (tides-3bl.4)", () => {
    const { win, input, drawn } = setup()
    // The touch stick holds a turn; another thumb lands on the throttle.
    input.pitch = 0.4
    input.yaw = -0.6
    win.fire('pointerdown', { pointerType: 'touch' })
    expect(input).toMatchObject({ pitch: 0.4, yaw: -0.6 })
    expect(drawn.visible).toBe(false)
  })

  it('shows the widget for a fine pointer, else only once a mouse moves', () => {
    expect(setup().drawn.visible).toBe(true)
    const { drawn, move } = setup({ fine: false })
    expect(drawn.visible).toBe(false)
    move(500, 400)
    expect(drawn.visible).toBe(true)
  })

  it('stops and disarms when the cursor leaves the window or the view', () => {
    const { move, arm, win, input, drawn } = setup()
    arm()
    move(900, 400)
    win.fire('pointerout', { pointerType: 'mouse', relatedTarget: element('canvas') })
    expect(input.yaw).toBeGreaterThan(0)
    win.fire('pointerout', { pointerType: 'mouse', relatedTarget: null })
    expect(input.yaw).toBe(0)
    move(900, 400)
    expect(input.yaw).toBe(0)
    expect(drawn.mode).toBe('unarmed')
    arm()
    move(900, 400)
    expect(input.yaw).toBeGreaterThan(0)
    move(1200, 400)
    expect(input.yaw).toBe(0)
    move(900, 400)
    expect(input.yaw).toBe(0)
  })

  it('disarms while a dialog is open and when one opens or closes', () => {
    const { move, arm, doc, input } = setup()
    arm()
    move(900, 400)
    expect(input.yaw).toBeGreaterThan(0)
    doc.fire('toggle', { target: { tagName: 'DIALOG' } })
    expect(input.yaw).toBe(0)
    move(900, 400)
    expect(input.yaw).toBe(0)
    arm()
    move(900, 400)
    doc.fire('close', { target: { tagName: 'DIALOG' } })
    expect(input.yaw).toBe(0)
    arm()
    move(900, 400)
    doc.fire('toggle', { target: { tagName: 'DETAILS' } })
    expect(input.yaw).toBeGreaterThan(0)

    const open = setup({ dialog: true })
    open.arm()
    open.move(900, 400)
    expect(open.input.yaw).toBe(0)
    expect(open.drawn.mode).toBe('unarmed')
  })

  it('lets go of held keys when Cmd is released', () => {
    const { key, input } = setup()
    key('keydown', 'KeyD')
    key('keydown', 'KeyQ')
    const meta = key('keyup', 'MetaLeft', { key: 'Meta' })
    expect(meta.preventDefault).not.toHaveBeenCalled()
    expect(input).toMatchObject({ strafeX: 0, roll: 0 })
  })

  it('suppresses the context menu over the view only', () => {
    const { win } = setup()
    const inside = { clientX: 500, clientY: 400, preventDefault: vi.fn() }
    win.fire('contextmenu', inside)
    expect(inside.preventDefault).toHaveBeenCalled()
    const outside = { clientX: 1100, clientY: 400, preventDefault: vi.fn() }
    win.fire('contextmenu', outside)
    expect(outside.preventDefault).not.toHaveBeenCalled()
  })

  it('lets go of everything on blur and when the tab hides', () => {
    const { move, arm, key, win, doc, input, frames } = setup()
    arm()
    move(900, 100)
    key('keydown', 'KeyW')
    key('keydown', 'KeyQ')
    key('keydown', 'KeyL')
    win.fire('blur')
    expect(input).toMatchObject({ pitch: 0, yaw: 0, roll: 0, level: false })
    expect(frames.size).toBe(0)

    key('keydown', 'KeyA')
    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    expect(input.strafeX).toBe(0)
  })

  it('removes its listeners and resets what it set on cleanup', () => {
    const { move, arm, key, win, doc, input, cleanup, frames } = setup()
    arm()
    move(900, 100)
    key('keydown', 'KeyS')
    key('keydown', 'KeyE')
    cleanup()
    expect(win.count()).toBe(0)
    expect(doc.count()).toBe(0)
    expect(frames.size).toBe(0)
    expect(input).toMatchObject({ pitch: 0, yaw: 0, roll: 0 })
  })
})
