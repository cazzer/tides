// Pointer bindings for the touch ship controls (tides-3bl.4). Each control
// owns at most one pointer at a time, so two thumbs, one per control, never
// disturb each other. Listeners are native and stop propagation at the
// control: R3F listens on #root, where React's synthetic stopPropagation
// comes too late to keep a press from also picking a body in the scene.

import type { ShipInput } from './ship-input'
import {
  STICK_RADIUS_PX,
  clampStickOrigin,
  freshDetent,
  isTap,
  padAxes,
  rollFromDrag,
  stepThrottleStick,
  stickDemand,
  stickKnob,
  throttleDeflection,
  withinTapReach,
  type PadAxes,
  type Point,
  type ThrottleDetent,
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

/**
 * Why a press ended: 'up' for a finger lifting, 'interrupted' for anything
 * else (pointercancel, lost capture, blur, hide, resize, a turn of the
 * phone, dispose), which must never count as a tap.
 */
export type ReleaseReason = 'up' | 'interrupted'

interface PressHandlers {
  /** Return false to decline the press. */
  down(event: PointerEvent): boolean | void
  move?(event: PointerEvent): void
  /** `event` is the pointer event that ended the press, if one did. */
  release(reason: ReleaseReason, event?: PointerEvent): void
}

// One pointer at a time: a second finger on the same control is ignored,
// and only the owning pointer's moves and release count.
function bindPress(
  element: ControlElement,
  handlers: PressHandlers,
  { touchOnly }: { touchOnly: boolean }
): Binding {
  let activeId: number | null = null

  const release = (reason: ReleaseReason, event?: PointerEvent) => {
    if (activeId === null) return
    activeId = null
    handlers.release(reason, event)
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
    release(event.type === 'pointerup' ? 'up' : 'interrupted', event)
  }

  element.addEventListener('pointerdown', down, { passive: false })
  element.addEventListener('pointermove', move, { passive: false })
  for (const type of RELEASE_EVENTS) element.addEventListener(type, up)
  return {
    release: () => release('interrupted'),
    dispose() {
      release('interrupted')
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

export interface ThrottleBinding extends Binding {
  /**
   * Moves the throttle by the held stick's deflection over `dt` seconds; a
   * no-op when let go. Run each frame. Reads shipInput.throttle afresh, so
   * the keyboard on a hybrid can set it too.
   */
  step(dt: number): void
  /** The held press's zero detent, for the readout; fresh when let go. */
  detentState(): ThrottleDetent
}

export interface ThrottleOptions {
  /** Read at each press: the drawn stick's centre, in client px. */
  base: () => Point
  onStick?: StickListener
  /** Called when a tap has just zeroed the throttle. */
  onTap?: () => void
}

/**
 * The spring-return throttle stick (tides-2hv.3): pushing up raises the
 * throttle and pulling down lowers it, at a rate proportional to the push,
 * and it holds where it's left when the knob springs back. Zero is a detent
 * (stepThrottleStick). Sideways rolls, springing back to 0. Once the drag
 * has travelled a little it locks to the axis it mostly moves along
 * (padAxes). A tap on the drawn stick (withinTapReach) that never gets that
 * far zeroes the throttle; elsewhere in the zone, presses only drag.
 */
export function bindThrottle(
  element: ControlElement,
  input: ShipInput,
  { base, onStick = () => {}, onTap = () => {} }: ThrottleOptions
): ThrottleBinding {
  let origin: Point = { x: 0, y: 0 }
  let downAt = 0
  let tappable = false
  let maxTravel = 0
  let axes: PadAxes | null = null
  let deflection: number | null = null
  let detent = freshDetent()
  const binding = bindPress(
    element,
    {
      down(event) {
        origin = { x: event.clientX, y: event.clientY }
        downAt = event.timeStamp
        tappable = withinTapReach(origin, base())
        maxTravel = 0
        axes = null
        deflection = 0
        detent = freshDetent()
        onStick({ origin, knob: origin })
      },
      move(event) {
        const dx = event.clientX - origin.x
        const dy = event.clientY - origin.y
        maxTravel = Math.max(maxTravel, Math.hypot(dx, dy))
        axes ??= padAxes(dx, dy)
        // Before the lock the knob follows the thumb but nothing moves, so
        // a tap's wobble leaves the throttle alone.
        deflection = axes && axes !== 'roll' ? throttleDeflection(dy, STICK_RADIUS_PX) : 0
        input.roll = axes && axes !== 'throttle' ? rollFromDrag(origin.x, event.clientX) : 0
        const shown = {
          x: origin.x + (axes === 'throttle' ? 0 : dx),
          y: origin.y + (axes === 'roll' ? 0 : dy),
        }
        onStick({ origin, knob: stickKnob(origin, shown, STICK_RADIUS_PX) })
      },
      release(reason, event) {
        deflection = null
        detent = freshDetent()
        input.roll = 0
        onStick(null)
        if (tappable && reason === 'up' && event && isTap(maxTravel, event.timeStamp - downAt)) {
          input.throttle = 0
          onTap()
        }
      },
    },
    { touchOnly: true }
  )
  return {
    ...binding,
    step(dt) {
      if (deflection === null) return
      const next = stepThrottleStick(input.throttle, deflection, dt, detent)
      input.throttle = next.throttle
      detent = next.detent
    },
    detentState: () => detent,
  }
}

type EventSource = Pick<Window, 'addEventListener' | 'removeEventListener'>

/**
 * Lets go of every control when the page loses focus or is hidden (an app
 * switch mid-drag delivers no pointerup), or when the view changes width or
 * the phone turns (the controls move out from under the thumbs), so no
 * input sticks. A height-only resize is Safari's toolbars sliding in or out
 * mid-flight, which leaves the controls where they were, so it's let be.
 * `orientation` is screen.orientation where the browser has it.
 */
export function releaseOnInterruption(
  {
    win,
    doc,
    orientation,
  }: {
    win: EventSource & Pick<Window, 'innerWidth'>
    doc: EventSource & Pick<Document, 'visibilityState'>
    orientation?: EventSource | null
  },
  release: () => void
): () => void {
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') release()
  }
  let width = win.innerWidth
  const onResize = () => {
    if (win.innerWidth === width) return
    width = win.innerWidth
    release()
  }
  win.addEventListener('blur', release)
  win.addEventListener('resize', onResize)
  doc.addEventListener('visibilitychange', onVisibility)
  orientation?.addEventListener('change', release)
  return () => {
    win.removeEventListener('blur', release)
    win.removeEventListener('resize', onResize)
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
