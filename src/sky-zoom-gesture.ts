import { useEffect, useRef, type RefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { useStore } from './store'
import { LOOK_MAX_ALTITUDE, LOOK_MIN_ALTITUDE, type SkyLook } from './sky-look'
import { currentFov, currentLook, type Reset } from './sky-look-drag'
import {
  SKY_FOV_MAX,
  SKY_FOV_MIN,
  approachFov,
  directionAt,
  lookKeeping,
  pinchFov,
  wheelFov,
  type SkyPoint,
} from './sky-zoom'

// A wheel zoom easing toward `fov`, keeping `anchor` (the sky that was under
// the cursor) under `point`.
export interface Glide {
  fov: number
  anchor: SkyLook
  point: SkyPoint
  height: number
}

// Close enough to the wheel's target to stop easing, in degrees.
const GLIDE_DONE = 0.01

// Safari's trackpad pinch: no ctrl+wheel, just a scale since gesturestart.
interface GestureEvent extends UIEvent {
  scale: number
  clientX: number
  clientY: number
}

type ZoomTarget = Pick<
  HTMLElement,
  'getBoundingClientRect' | 'setPointerCapture' | 'addEventListener' | 'removeEventListener'
>

// Zooms View from Earth on a two-finger pinch, the wheel (a trackpad pinch
// arrives as ctrl+wheel) or Safari's gesture events, keeping the sky under
// the fingers or cursor; writes the store's skyFov and skyLook. A pinch
// follows the fingers directly; wheel steps set `glide`, which
// stepGlide eases toward, until the next press. Pinches never reach the
// page's own zoom. Any zoom cancels a reset in progress. Returns the cleanup.
export function zoomOnPinch(
  element: ZoomTarget,
  reset: RefObject<Reset | null>,
  glide: RefObject<Glide | null>
) {
  const touches = new Map<number, { x: number; y: number }>()
  let pinch: {
    ids: [number, number]
    fov: number
    distance: number
    anchor: SkyLook
  } | null = null
  let gesture: { fov: number; anchor: SkyLook; point: SkyPoint; height: number } | null = null

  const pointOf = (x: number, y: number) => {
    const rect = element.getBoundingClientRect()
    return {
      point: { dx: x - (rect.left + rect.width / 2), dy: y - (rect.top + rect.height / 2) },
      height: rect.height,
    }
  }

  const interrupt = () => {
    reset.current = null
    glide.current = null
  }

  // The two fingers' midpoint and spread.
  const span = ([a, b]: [number, number]) => {
    const p = touches.get(a)!
    const q = touches.get(b)!
    return {
      ...pointOf((p.x + q.x) / 2, (p.y + q.y) / 2),
      distance: Math.hypot(q.x - p.x, q.y - p.y),
    }
  }

  // From the first two fingers down, from the view as it is now.
  const startPinch = () => {
    interrupt()
    gesture = null
    const ids = [...touches.keys()].slice(0, 2) as [number, number]
    const { point, height, distance } = span(ids)
    const fov = currentFov()
    pinch = { ids, fov, distance, anchor: directionAt(currentLook(), fov, point, height) }
  }

  // Any press stops a wheel zoom's easing, so a drag takes over at once.
  const down = (event: PointerEvent) => {
    glide.current = null
    if (event.pointerType === 'mouse') return
    if (event.isPrimary) {
      touches.clear()
      pinch = null
    }
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
    element.setPointerCapture(event.pointerId)
    if (!pinch && touches.size >= 2) startPinch()
  }

  const move = (event: PointerEvent) => {
    const touch = touches.get(event.pointerId)
    if (!touch) return
    touch.x = event.clientX
    touch.y = event.clientY
    if (!pinch || !pinch.ids.includes(event.pointerId)) return
    const { point, height, distance } = span(pinch.ids)
    const skyFov = pinchFov(pinch.fov, pinch.distance, distance)
    const skyLook = lookKeeping(pinch.anchor, point, skyFov, height, currentLook())
    useStore.setState({ skyFov, skyLook })
    // Held at a limit, start afresh from here, so pinching back responds at once.
    if (skyFov === SKY_FOV_MIN || skyFov === SKY_FOV_MAX) {
      pinch.fov = skyFov
      pinch.distance = distance
    }
    if (skyLook.altitude === LOOK_MIN_ALTITUDE || skyLook.altitude === LOOK_MAX_ALTITUDE) {
      pinch.anchor = directionAt(skyLook, skyFov, point, height)
    }
  }

  // Lifting a pinching finger hands over to any other two still down.
  const up = (event: PointerEvent) => {
    touches.delete(event.pointerId)
    if (!pinch?.ids.includes(event.pointerId)) return
    pinch = null
    if (touches.size >= 2) startPinch()
  }

  // Safari's trackpad pinch owns the zoom while it lasts.
  const wheel = (event: WheelEvent) => {
    event.preventDefault()
    if (gesture) return
    const { point, height } = pointOf(event.clientX, event.clientY)
    const target = wheelFov(
      glide.current?.fov ?? currentFov(),
      event.deltaY,
      event.deltaMode,
      event.ctrlKey
    )
    const anchor = directionAt(currentLook(), currentFov(), point, height)
    reset.current = null
    glide.current = { fov: target, anchor, point, height }
  }

  // On iOS the same pinch also arrives as touch pointers, which handle it.
  const gestureStart = (event: Event) => {
    event.preventDefault()
    if (touches.size > 0) return
    interrupt()
    const { clientX, clientY } = event as GestureEvent
    const { point, height } = pointOf(clientX, clientY)
    const fov = currentFov()
    gesture = { fov, point, height, anchor: directionAt(currentLook(), fov, point, height) }
  }

  const gestureChange = (event: Event) => {
    event.preventDefault()
    if (!gesture || touches.size > 0) return
    const { fov, anchor, point, height } = gesture
    const skyFov = pinchFov(fov, 1, (event as GestureEvent).scale)
    useStore.setState({
      skyFov,
      skyLook: lookKeeping(anchor, point, skyFov, height, currentLook()),
    })
  }

  const gestureEnd = (event: Event) => {
    event.preventDefault()
    gesture = null
  }

  const listeners: [string, EventListener][] = [
    ['pointerdown', down as EventListener],
    ['pointermove', move as EventListener],
    ['pointerup', up as EventListener],
    ['pointercancel', up as EventListener],
    ['wheel', wheel as EventListener],
    ['gesturestart', gestureStart],
    ['gesturechange', gestureChange],
    ['gestureend', gestureEnd],
  ]
  for (const [type, listener] of listeners) {
    element.addEventListener(type, listener, { passive: false })
  }
  return () => {
    for (const [type, listener] of listeners) element.removeEventListener(type, listener)
  }
}

// One frame of a wheel zoom: eases the fov toward the glide's target and
// turns the view to keep its anchor under the cursor. A reset takes over.
export function stepGlide(glide: RefObject<Glide | null>, reset: RefObject<Reset | null>, dt: number) {
  const target = glide.current
  if (!target) return
  if (reset.current) {
    glide.current = null
    return
  }
  let skyFov = approachFov(currentFov(), target.fov, Math.min(dt, 0.1))
  if (Math.abs(skyFov - target.fov) < GLIDE_DONE) {
    skyFov = target.fov
    glide.current = null
  }
  useStore.setState({
    skyFov,
    skyLook: lookKeeping(target.anchor, target.point, skyFov, target.height, currentLook()),
  })
}

// Pinch and wheel zoom on View from Earth's panel element (see zoomOnPinch),
// sharing SkyLookControls' reset so a double tap eases the zoom back too.
export function useSkyZoom(element: HTMLElement | undefined, reset: RefObject<Reset | null>) {
  const glide = useRef<Glide | null>(null)
  useEffect(
    () => (element ? zoomOnPinch(element, reset, glide) : undefined),
    [element, reset]
  )
  useFrame((_, dt) => stepGlide(glide, reset, dt))
}
