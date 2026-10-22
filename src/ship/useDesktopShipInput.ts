import { useEffect, type RefObject } from 'react'
import { shipInput, type ShipInput } from './ship-input'
import {
  releaseShipKeys,
  shipKeyDown,
  shipKeyUp,
  stepThrottle,
  type HeldKeys,
} from './desktop-keys'
import { joystickDemand } from './mouse-joystick'

/** What the binding draws the mouse joystick on (see MouseJoystickWidget). */
export interface JoystickDisplay {
  setVisible(visible: boolean): void
  /**
   * The cursor offset clamped to the saturation circle as a share of its
   * radius (x right, y down); active is false while it isn't steering.
   */
  draw(x: number, y: number, active: boolean): void
}

/**
 * Under these the mouse isn't steering: aiming at a button shouldn't turn the
 * ship. Overlays that aren't buttons can opt in with data-ship-ui.
 */
export const SHIP_UI_SELECTOR =
  'button, a, input, select, textarea, [role="button"], [role="dialog"], dialog, [data-ship-ui]'
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

// Longer frames (a stall, a backgrounded tab) don't ramp the throttle in one go.
const MAX_THROTTLE_DT = 0.1

const closest = (target: EventTarget | null, selector: string): boolean => {
  const element = target as Element | null
  return typeof element?.closest === 'function' && element.closest(selector) != null
}

const dialogOpen = () => document.querySelector('dialog[open]') != null

/**
 * Binds desktop flight input to `input` (tides-3bl.3): the keyboard through
 * desktop-keys, and the mouse as a virtual joystick about the centre of
 * `area`, drawn on `display`. Listens on window/document; returns the
 * cleanup, which also lets go of everything it set.
 */
export function bindDesktopShipInput(
  area: HTMLElement,
  display: JoystickDisplay,
  input: ShipInput = shipInput
): () => void {
  const held: HeldKeys = new Set()
  let frame: number | null = null
  let lastFrameAt: number | null = null

  const throttleHeld = () => held.has('throttleUp') || held.has('throttleDown')

  const tick = (now: number) => {
    const dt = lastFrameAt == null ? 0 : (now - lastFrameAt) / 1000
    lastFrameAt = now
    stepThrottle(held, input, Math.min(dt, MAX_THROTTLE_DT))
    frame = throttleHeld() ? requestAnimationFrame(tick) : null
  }
  const startThrottleLoop = () => {
    if (frame != null || !throttleHeld()) return
    lastFrameAt = null
    frame = requestAnimationFrame(tick)
  }
  const stopThrottleLoop = () => {
    if (frame != null) cancelAnimationFrame(frame)
    frame = null
  }

  const stopSteering = () => {
    input.pitch = 0
    input.yaw = 0
    display.draw(0, 0, false)
  }

  const releaseAll = () => {
    releaseShipKeys(held, input)
    stopThrottleLoop()
    stopSteering()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (closest(event.target, EDITABLE_SELECTOR) || dialogOpen()) return
    if (!shipKeyDown(held, event, input)) return
    event.preventDefault()
    startThrottleLoop()
  }

  const onKeyUp = (event: KeyboardEvent) => {
    if (!shipKeyUp(held, event, input)) return
    event.preventDefault()
    if (!throttleHeld()) stopThrottleLoop()
  }

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return
    display.setVisible(true)
    const rect = area.getBoundingClientRect()
    const inside =
      event.clientX >= rect.left &&
      event.clientX < rect.right &&
      event.clientY >= rect.top &&
      event.clientY < rect.bottom
    if (!inside) return stopSteering()
    const demand = joystickDemand(
      event.clientX - (rect.left + rect.width / 2),
      event.clientY - (rect.top + rect.height / 2),
      Math.min(rect.width, rect.height)
    )
    // Over a control the widget keeps tracking but the ship holds its heading.
    const steering = !closest(event.target, SHIP_UI_SELECTOR) && !dialogOpen()
    input.pitch = steering ? demand.pitch : 0
    input.yaw = steering ? demand.yaw : 0
    display.draw(demand.x, demand.y, steering && (demand.pitch !== 0 || demand.yaw !== 0))
  }

  // relatedTarget null: the cursor left the window.
  const onPointerOut = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.relatedTarget == null) stopSteering()
  }

  // Capture phase, ahead of the touch controls' own handlers: a touch takes
  // over steering, so the mouse lets go before the stick writes.
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') return
    stopSteering()
    display.setVisible(false)
  }

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') releaseAll()
  }

  display.setVisible(
    typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches
  )
  display.draw(0, 0, false)

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('pointerout', onPointerOut, { passive: true })
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  window.addEventListener('blur', releaseAll)
  document.addEventListener('visibilitychange', onVisibilityChange)

  return () => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerout', onPointerOut)
    window.removeEventListener('pointerdown', onPointerDown, { capture: true })
    window.removeEventListener('blur', releaseAll)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    releaseAll()
  }
}

/** Desktop keyboard + mouse flight input while the calling component is mounted. */
export function useDesktopShipInput(
  area: RefObject<HTMLElement | null>,
  display: RefObject<JoystickDisplay | null>
): void {
  useEffect(() => {
    const element = area.current
    const widget = display.current
    if (!element || !widget) return
    return bindDesktopShipInput(element, widget)
  }, [area, display])
}
