import type { RefObject } from 'react'
import { useStore } from './store'
import { DEFAULT_SURFACE_LOCATION, SURFACE_FOV, surfaceView } from './sky'
import {
  DOUBLE_TAP_DISTANCE,
  DOUBLE_TAP_MS,
  DRAG_THRESHOLD,
  dragLook,
  type SkyLook,
} from './sky-look'

// A reset easing back to the default view and field of view (SkyLookControls
// runs it).
export interface Reset {
  from: SkyLook
  fromFov: number
  start: number
}

export function defaultLook() {
  const { lat } = useStore.getState().location ?? DEFAULT_SURFACE_LOCATION
  return surfaceView(lat)
}

export function currentLook() {
  return useStore.getState().skyLook ?? defaultLook()
}

export function currentFov() {
  return useStore.getState().skyFov ?? SURFACE_FOV
}

type LookTarget = Pick<
  HTMLElement,
  'style' | 'clientHeight' | 'setPointerCapture' | 'addEventListener' | 'removeEventListener'
>

// Turns View from Earth as the pointer drags across `element`, and starts a
// reset on a double tap; writes the store's skyLook. Kept out of the
// component, as the react-hooks lint rejects mutating the element from
// useThree in place. Returns the cleanup.
export function lookOnDrag(element: LookTarget, reset: RefObject<Reset | null>) {
  let press: { id: number; x: number; y: number; dragging: boolean } | null = null
  const pointers = new Set<number>()
  let lastTap: { time: number; x: number; y: number } | null = null
  const { touchAction, cursor } = element.style
  element.style.touchAction = 'none'
  element.style.cursor = 'grab'

  // A second finger makes a pinch (sky-zoom-gesture), so the press is
  // neither a drag nor a tap any more; the same pointer pressing again means
  // its release was lost. A primary press starts afresh.
  const down = (event: PointerEvent) => {
    if (event.isPrimary) pointers.clear()
    pointers.add(event.pointerId)
    if (pointers.size > 1) {
      press = null
      lastTap = null
      element.style.cursor = 'grab'
      return
    }
    if (event.pointerType === 'mouse' && event.button !== 0) return
    reset.current = null
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false }
    // From the press, so a release past the panel's edge still ends it.
    element.setPointerCapture(event.pointerId)
  }

  const move = (event: PointerEvent) => {
    if (!press || event.pointerId !== press.id) return
    if (event.buttons === 0) {
      press = null
      element.style.cursor = 'grab'
      return
    }
    const dx = event.clientX - press.x
    const dy = event.clientY - press.y
    if (!press.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      press.dragging = true
      element.style.cursor = 'grabbing'
    }
    // Step by step rather than from the press, so dragging back off a clamp
    // (the zenith) turns the view straight away.
    press.x = event.clientX
    press.y = event.clientY
    useStore.setState({
      skyLook: dragLook(currentLook(), dx, dy, element.clientHeight, currentFov()),
      compass: false,
    })
  }

  const up = (event: PointerEvent) => {
    pointers.delete(event.pointerId)
    if (!press || event.pointerId !== press.id) return
    const { dragging, x, y } = press
    press = null
    element.style.cursor = 'grab'
    if (dragging || event.type !== 'pointerup') {
      lastTap = null
      return
    }
    const time = event.timeStamp
    const double =
      lastTap &&
      time - lastTap.time < DOUBLE_TAP_MS &&
      Math.hypot(x - lastTap.x, y - lastTap.y) < DOUBLE_TAP_DISTANCE
    lastTap = double ? null : { time, x, y }
    if (!double) return
    useStore.setState({ compass: false })
    const { skyLook, skyFov } = useStore.getState()
    if (skyLook || skyFov) {
      reset.current = { from: currentLook(), fromFov: currentFov(), start: performance.now() }
    }
  }

  element.addEventListener('pointerdown', down)
  element.addEventListener('pointermove', move)
  element.addEventListener('pointerup', up)
  element.addEventListener('pointercancel', up)
  element.addEventListener('lostpointercapture', up)
  return () => {
    element.removeEventListener('pointerdown', down)
    element.removeEventListener('pointermove', move)
    element.removeEventListener('pointerup', up)
    element.removeEventListener('pointercancel', up)
    element.removeEventListener('lostpointercapture', up)
    element.style.touchAction = touchAction
    element.style.cursor = cursor
    // A reset cut short (the panel unmounting mid-ease) still lands.
    if (reset.current) {
      reset.current = null
      useStore.setState({ skyLook: null, skyFov: null })
    }
  }
}
