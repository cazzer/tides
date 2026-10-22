// Pointer bindings for the touch ship controls (tides-3bl.4). Each control
// owns at most one pointer at a time, so two thumbs, one per control, never
// disturb each other. Listeners are native and stop propagation at the
// control: R3F listens on #root, where React's synthetic stopPropagation
// comes too late to keep a press from also picking a body in the scene.

import type { ShipInput } from './ship-input'
import {
  STICK_RADIUS_PX,
  clampStickOrigin,
  padAxes,
  rebaseThrottleAnchor,
  rollFromDrag,
  stickDemand,
  stickKnob,
  throttleFromDrag,
  type PadAxes,
  type Point,
  type ThrottleAnchor,
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

/** How the stick reports itself and where it may spawn. */
export interface SteerOptions {
  onStick?: StickListener
  /** Read at each press: the base's leftmost x and lowest y, in client px. */
  spawnBounds?: () => { minX: number; maxY: number }
}

export interface SteerBinding extends Binding {
  /**
   * Writes the held stick's demand again; a no-op when let go. Run each
   * frame so another writer zeroing pitch/yaw (the desktop mouse on a
   * hybrid) can't cancel a turn the thumb is still holding.
   */
  reassert(): void
}

/**
 * The floating steer stick: its base lands under the thumb (clamped clear of
 * the zone's edges), and the thumb's offset from there is the pitch/yaw
 * demand, back to 0 on release.
 */
export function bindSteer(
  element: ControlElement,
  input: ShipInput,
  { onStick = () => {}, spawnBounds }: SteerOptions = {}
): SteerBinding {
  let origin: Point = { x: 0, y: 0 }
  let demand: { pitch: number; yaw: number } | null = null
  const steerTo = (event: PointerEvent) => {
    const current = { x: event.clientX, y: event.clientY }
    demand = stickDemand(origin, current, STICK_RADIUS_PX)
    input.pitch = demand.pitch
    input.yaw = demand.yaw
    onStick({ origin, knob: stickKnob(origin, current, STICK_RADIUS_PX) })
  }
  const binding = bindPress(
    element,
    {
      down(event) {
        const thumb = { x: event.clientX, y: event.clientY }
        origin = spawnBounds ? clampStickOrigin(thumb, spawnBounds()) : thumb
        steerTo(event)
      },
      move: steerTo,
      release() {
        demand = null
        input.pitch = 0
        input.yaw = 0
        onStick(null)
      },
    },
    { touchOnly: true }
  )
  return {
    ...binding,
    reassert() {
      if (!demand) return
      input.pitch = demand.pitch
      input.yaw = demand.yaw
    },
  }
}

/**
 * The throttle/roll pad: vertical drag moves the throttle setpoint, which
 * stays where it's left; horizontal drag rolls and springs back to 0. Once
 * the drag has travelled a little it locks to the axis it mostly moves along
 * (padAxes). `trackPx` is the throttle track's height, read at each press.
 */
export function bindThrottle(
  element: ControlElement,
  input: ShipInput,
  trackPx: () => number
): Binding {
  let start = { x: 0, y: 0, trackPx: 1 }
  let anchor: ThrottleAnchor = { setpoint: 0, y: 0 }
  let axes: PadAxes | null = null
  return bindPress(
    element,
    {
      down(event) {
        start = { x: event.clientX, y: event.clientY, trackPx: trackPx() }
        anchor = { setpoint: input.throttle, y: event.clientY }
        axes = null
      },
      move(event) {
        axes ??= padAxes(event.clientX - start.x, event.clientY - start.y)
        if (!axes) return
        if (axes !== 'roll') {
          input.throttle = throttleFromDrag(anchor.setpoint, anchor.y, event.clientY, start.trackPx)
          anchor = rebaseThrottleAnchor(anchor, event.clientY, start.trackPx)
        }
        if (axes !== 'throttle') input.roll = rollFromDrag(start.x, event.clientX)
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

type EventSource = Pick<Window, 'addEventListener' | 'removeEventListener'>

/**
 * Lets go of every control when the page loses focus or is hidden (an app
 * switch mid-drag delivers no pointerup), or when the view resizes or the
 * phone turns (the pads and track move out from under the thumbs), so no
 * input sticks. `orientation` is screen.orientation where the browser has it.
 */
export function releaseOnInterruption(
  {
    win,
    doc,
    orientation,
  }: {
    win: EventSource
    doc: EventSource & Pick<Document, 'visibilityState'>
    orientation?: EventSource | null
  },
  release: () => void
): () => void {
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') release()
  }
  win.addEventListener('blur', release)
  win.addEventListener('resize', release)
  doc.addEventListener('visibilitychange', onVisibility)
  orientation?.addEventListener('change', release)
  return () => {
    win.removeEventListener('blur', release)
    win.removeEventListener('resize', release)
    doc.removeEventListener('visibilitychange', onVisibility)
    orientation?.removeEventListener('change', release)
  }
}

/**
 * Keeps iOS Safari's own pinch (gesture events) off the page while the
 * controls are up, wherever on the screen it starts.
 */
export function blockPagePinch(doc: EventSource): () => void {
  const prevent = (event: Event) => event.preventDefault()
  doc.addEventListener('gesturestart', prevent, { passive: false })
  doc.addEventListener('gesturechange', prevent, { passive: false })
  return () => {
    doc.removeEventListener('gesturestart', prevent)
    doc.removeEventListener('gesturechange', prevent)
  }
}
