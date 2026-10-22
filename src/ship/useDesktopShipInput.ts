import { useEffect, type RefObject } from 'react'
import { shipInput, type ShipInput } from './ship-input'
import {
  createShipKeys,
  releaseShipKeys,
  shipKeyDown,
  shipKeyUp,
  stepThrottle,
} from './desktop-keys'
import { mouseSteer, type JoystickMode } from './mouse-joystick'

/** What the binding draws the mouse joystick on (see MouseJoystickWidget). */
export interface JoystickDisplay {
  setVisible(visible: boolean): void
  /**
   * The cursor offset clamped to the saturation circle as a share of its
   * radius (x right, y down), and what the joystick is doing.
   */
  draw(x: number, y: number, mode: JoystickMode): void
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
  const keys = createShipKeys()
  let frame: number | null = null
  let lastFrameAt: number | null = null
  let armed = false

  // The view only moves when it resizes (or the window does).
  let rect: DOMRect | null = null
  const viewRect = () => (rect ??= area.getBoundingClientRect())
  const forgetRect = () => {
    rect = null
  }
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(forgetRect) : null
  resizeObserver?.observe(area)

  const throttleHeld = () => keys.held.has('throttleUp') || keys.held.has('throttleDown')

  const tick = (now: number) => {
    const dt = lastFrameAt == null ? 0 : (now - lastFrameAt) / 1000
    lastFrameAt = now
    stepThrottle(keys, input, Math.min(dt, MAX_THROTTLE_DT))
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

  /** Zero the turn demand; the cursor must come back to the centre to steer again. */
  const disarm = () => {
    armed = false
    input.pitch = 0
    input.yaw = 0
    display.draw(0, 0, 'unarmed')
  }

  const releaseAll = () => {
    releaseShipKeys(keys, input)
    stopThrottleLoop()
    disarm()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (closest(event.target, EDITABLE_SELECTOR) || dialogOpen()) return
    if (!shipKeyDown(keys, event, input)) return
    event.preventDefault()
    startThrottleLoop()
  }

  const onKeyUp = (event: KeyboardEvent) => {
    if (shipKeyUp(keys, event, input)) event.preventDefault()
    if (!throttleHeld()) stopThrottleLoop()
  }

  const insideView = (x: number, y: number) => {
    const r = viewRect()
    return x >= r.left && x < r.right && y >= r.top && y < r.bottom
  }

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return
    display.setVisible(true)
    if (!insideView(event.clientX, event.clientY)) return disarm()
    const r = viewRect()
    const steer = mouseSteer(
      armed,
      event.clientX - (r.left + r.width / 2),
      event.clientY - (r.top + r.height / 2),
      Math.min(r.width, r.height),
      { overUi: closest(event.target, SHIP_UI_SELECTOR), dialogOpen: dialogOpen() }
    )
    armed = steer.armed
    input.pitch = steer.pitch
    input.yaw = steer.yaw
    display.draw(steer.x, steer.y, steer.mode)
  }

  // relatedTarget null: the cursor left the window.
  const onPointerOut = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.relatedTarget == null) disarm()
  }

  // Capture phase, ahead of the touch controls' own handlers: a touch takes
  // over steering, so the mouse lets go before the stick writes. Only if the
  // mouse was steering, though: a second thumb (the throttle stick) must not
  // zero a turn the touch stick is holding (tides-3bl.4).
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') return
    if (armed) disarm()
    display.setVisible(false)
  }

  // A context menu would swallow the keyups of keys held while it's open.
  const onContextMenu = (event: MouseEvent) => {
    if (insideView(event.clientX, event.clientY)) event.preventDefault()
  }

  // A dialog opening or closing (dialogs fire neither event through bubbling,
  // hence capture) interrupts steering even if the mouse hasn't moved.
  const onDialogToggle = (event: Event) => {
    if ((event.target as Element | null)?.tagName === 'DIALOG') disarm()
  }

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') releaseAll()
  }

  display.setVisible(
    typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches
  )
  display.draw(0, 0, 'unarmed')

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('pointerout', onPointerOut, { passive: true })
  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  window.addEventListener('contextmenu', onContextMenu)
  window.addEventListener('resize', forgetRect)
  window.addEventListener('blur', releaseAll)
  document.addEventListener('toggle', onDialogToggle, { capture: true })
  document.addEventListener('close', onDialogToggle, { capture: true })
  document.addEventListener('visibilitychange', onVisibilityChange)

  return () => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerout', onPointerOut)
    window.removeEventListener('pointerdown', onPointerDown, { capture: true })
    window.removeEventListener('contextmenu', onContextMenu)
    window.removeEventListener('resize', forgetRect)
    window.removeEventListener('blur', releaseAll)
    document.removeEventListener('toggle', onDialogToggle, { capture: true })
    document.removeEventListener('close', onDialogToggle, { capture: true })
    document.removeEventListener('visibilitychange', onVisibilityChange)
    resizeObserver?.disconnect()
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
