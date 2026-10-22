// Pointer bindings for the touch ship controls (tides-3bl.4). Each control
// owns at most one pointer at a time, so two thumbs, one per control, never
// disturb each other. Listeners are native and stop propagation at the
// control: R3F listens on #root, where React's synthetic stopPropagation
// comes too late to keep a press from also picking a body in the scene.

import type { ShipInput } from './ship-input'
import {
  STICK_RADIUS_PX,
  rollFromDrag,
  stickDemand,
  stickKnob,
  throttleFromDrag,
  type Point,
} from './touch-stick'

export type ControlElement = Pick<
  HTMLElement,
  'setPointerCapture' | 'addEventListener' | 'removeEventListener'
>

export interface Binding {
  /** Lets go of the control as though its finger lifted. */
  release(): void
  /** Removes the listeners, releasing first. */
  dispose(): void
}

/** The stick's base and knob in client px while held; null when let go. */
export type StickListener = (stick: { origin: Point; knob: Point } | null) => void

const RELEASE_EVENTS = ['pointerup', 'pointercancel', 'lostpointercapture'] as const

// Capture keeps a thumb that slides off the control driving it. A pointer
// the browser no longer tracks makes it throw; the control still works for
// moves over itself, so that's no reason to drop the press.
function capture(element: ControlElement, pointerId: number) {
  try {
    element.setPointerCapture(pointerId)
  } catch {
    // Not an active pointer (e.g. it lifted before this ran).
  }
}

interface PressHandlers {
  /** Return false to decline the press. */
  down(event: PointerEvent): boolean | void
  move?(event: PointerEvent): void
  release(): void
}

// One pointer at a time: a second finger on the same control is ignored,
// and only the owning pointer's moves and release count.
function bindPress(
  element: ControlElement,
  handlers: PressHandlers,
  { touchOnly }: { touchOnly: boolean }
): Binding {
  let activeId: number | null = null

  const release = () => {
    if (activeId === null) return
    activeId = null
    handlers.release()
  }
  const down = (event: PointerEvent) => {
    // A mouse on a touch-only pad passes through to the scene and the
    // desktop controls, as though the pad weren't there.
    if (touchOnly && event.pointerType === 'mouse') return
    event.stopPropagation()
    if (activeId !== null) return
    if (handlers.down(event) === false) return
    event.preventDefault()
    activeId = event.pointerId
    capture(element, event.pointerId)
  }
  const move = (event: PointerEvent) => {
    if (event.pointerId !== activeId) return
    event.stopPropagation()
    event.preventDefault()
    handlers.move?.(event)
  }
  const up = (event: PointerEvent) => {
    if (event.pointerId !== activeId) return
    event.stopPropagation()
    release()
  }

  element.addEventListener('pointerdown', down, { passive: false })
  element.addEventListener('pointermove', move, { passive: false })
  for (const type of RELEASE_EVENTS) element.addEventListener(type, up)
  return {
    release,
    dispose() {
      release()
      element.removeEventListener('pointerdown', down)
      element.removeEventListener('pointermove', move)
      for (const type of RELEASE_EVENTS) element.removeEventListener(type, up)
    },
  }
}

/**
 * The floating steer stick: its base lands under the thumb, and the thumb's
 * offset from there is the pitch/yaw demand, back to 0 on release.
 */
export function bindSteer(
  element: ControlElement,
  input: ShipInput,
  onStick: StickListener = () => {}
): Binding {
  let origin: Point = { x: 0, y: 0 }
  return bindPress(
    element,
    {
      down(event) {
        origin = { x: event.clientX, y: event.clientY }
        onStick({ origin, knob: origin })
      },
      move(event) {
        const current = { x: event.clientX, y: event.clientY }
        const { pitch, yaw } = stickDemand(origin, current, STICK_RADIUS_PX)
        input.pitch = pitch
        input.yaw = yaw
        onStick({ origin, knob: stickKnob(origin, current, STICK_RADIUS_PX) })
      },
      release() {
        input.pitch = 0
        input.yaw = 0
        onStick(null)
      },
    },
    { touchOnly: true }
  )
}

/**
 * The throttle/roll pad: vertical drag moves the throttle setpoint, which
 * stays where it's left; horizontal drag rolls and springs back to 0.
 * `trackPx` is the throttle track's height, read at each press.
 */
export function bindThrottle(
  element: ControlElement,
  input: ShipInput,
  trackPx: () => number
): Binding {
  let start = { x: 0, y: 0, setpoint: 0, trackPx: 1 }
  return bindPress(
    element,
    {
      down(event) {
        start = { x: event.clientX, y: event.clientY, setpoint: input.throttle, trackPx: trackPx() }
      },
      move(event) {
        input.throttle = throttleFromDrag(start.setpoint, start.y, event.clientY, start.trackPx)
        input.roll = rollFromDrag(start.x, event.clientX)
      },
      release() {
        input.roll = 0
      },
    },
    { touchOnly: true }
  )
}

const HOLD_KEYS = new Set([' ', 'Enter'])

/** Level while held, from any pointer or Space/Enter on the focused button. */
export function bindLevel(element: ControlElement, input: ShipInput): Binding {
  let keyHeld = false
  const keyDown = (event: KeyboardEvent) => {
    if (!HOLD_KEYS.has(event.key)) return
    // Held here, not by the desktop keys bound on window.
    event.preventDefault()
    event.stopPropagation()
    keyHeld = true
    input.level = true
  }
  const releaseKey = () => {
    if (!keyHeld) return
    keyHeld = false
    input.level = false
  }
  const keyUp = (event: KeyboardEvent) => {
    if (!HOLD_KEYS.has(event.key)) return
    event.stopPropagation()
    releaseKey()
  }
  const pointer = bindPress(
    element,
    {
      down(event) {
        if (event.pointerType === 'mouse' && event.button !== 0) return false
        input.level = true
      },
      release() {
        input.level = false
      },
    },
    { touchOnly: false }
  )
  element.addEventListener('keydown', keyDown)
  element.addEventListener('keyup', keyUp)
  element.addEventListener('blur', releaseKey)
  return {
    release() {
      pointer.release()
      releaseKey()
    },
    dispose() {
      pointer.dispose()
      releaseKey()
      element.removeEventListener('keydown', keyDown)
      element.removeEventListener('keyup', keyUp)
      element.removeEventListener('blur', releaseKey)
    },
  }
}

/** Toggles Flight Assist on click (tap, mouse or keyboard). */
export function bindFlightAssist(element: ControlElement, input: ShipInput): () => void {
  const stop = (event: Event) => event.stopPropagation()
  const click = (event: Event) => {
    event.stopPropagation()
    input.flightAssist = !input.flightAssist
  }
  element.addEventListener('pointerdown', stop)
  element.addEventListener('pointerup', stop)
  element.addEventListener('click', click)
  return () => {
    element.removeEventListener('pointerdown', stop)
    element.removeEventListener('pointerup', stop)
    element.removeEventListener('click', click)
  }
}

type EventSource = Pick<Window, 'addEventListener' | 'removeEventListener'>

/**
 * Lets go of every control when the page loses focus or is hidden (an app
 * switch mid-drag delivers no pointerup), so no input sticks.
 */
export function releaseWhenBackgrounded(
  win: EventSource,
  doc: EventSource & Pick<Document, 'visibilityState'>,
  release: () => void
): () => void {
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') release()
  }
  win.addEventListener('blur', release)
  doc.addEventListener('visibilitychange', onVisibility)
  return () => {
    win.removeEventListener('blur', release)
    doc.removeEventListener('visibilitychange', onVisibility)
  }
}
