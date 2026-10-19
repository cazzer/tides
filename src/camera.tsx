import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  Vector3,
  Matrix4,
  type Camera,
  type InstancedMesh,
  type Object3D,
  type OrthographicCamera,
} from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { useStore, type CameraFocus } from './store'
import { calculateLocationAndRotationForLatLng } from './utils'
import { leaveClock, rideWithClock, useClockRide } from './clock-view'
import {
  clampTilt,
  pivotDepth,
  pixelsToPivot,
  tiltControls,
  wrapAngle,
  type Pivot,
} from './pivot'

const CameraContext = createContext({
  handleFocus: null,
})

const FOCUS_VALUES: CameraFocus[] = [
  'clock',
  'earth',
  'sun',
  'moon',
  'location',
]

function getFocusForObject(object: Object3D): CameraFocus | null {
  let o: Object3D | null = object
  while (o) {
    const focus = (o as Object3D & { userData?: { focus?: string } }).userData
      ?.focus
    if (focus && FOCUS_VALUES.includes(focus as CameraFocus)) {
      return focus as CameraFocus
    }
    o = o.parent
  }
  return null
}

/**
 * OrbitControls turns 2π·rotateSpeed/domHeight rad per dragged pixel, while
 * the surface point facing the camera moves worldPerPixel/radius rad per
 * pixel. Matching the two keeps the grabbed surface under the cursor up close;
 * capping at the default 1 leaves the far-away orbit as it was.
 */
export function surfaceGrabRotateSpeed(
  worldPerPixel: number,
  domHeight: number,
  radius: number
): number {
  return Math.min(1, (worldPerPixel * domHeight) / (2 * Math.PI * radius))
}

const PIVOT_EASE = 0.05

const inEarthFocus = () => useStore.getState().cameraFocus === 'earth'

/**
 * Hands the right and middle buttons and the second finger's travel to the
 * pivot; pan has nothing to move in Earth focus since the target follows
 * Earth. Returns the undo.
 */
function takeEarthInputs(controls: OrbitControlsImpl): () => void {
  const { enablePan } = controls
  const { MIDDLE: middle, RIGHT: right } = controls.mouseButtons
  controls.enablePan = false
  controls.mouseButtons.MIDDLE = undefined
  controls.mouseButtons.RIGHT = undefined
  return () => {
    controls.enablePan = enablePan
    controls.mouseButtons.MIDDLE = middle
    controls.mouseButtons.RIGHT = right
  }
}

const isPivotButton = (button: number) => button === 1 || button === 2

/** Fingers must move this far before a two-finger touch picks pinch or pivot. */
const GESTURE_LOCK_PX = 10

/**
 * Feeds right- and middle-drags and two-finger touch drags to `pivot`. A
 * two-finger click on a macOS trackpad is a right click, so click-and-drag
 * pivots while a plain two-finger scroll still zooms.
 */
function listenForPivot(
  dom: HTMLElement,
  controls: OrbitControlsImpl,
  pivot: Pivot
): () => void {
  const doc = dom.ownerDocument

  const turn = (dx: number, dy: number) => {
    const delta = pixelsToPivot(dx, dy, dom.clientHeight)
    pivot.tilt = clampTilt(pivot.tilt + delta.tilt)
    pivot.heading = wrapAngle(pivot.heading + delta.heading)
  }

  const touches = new Map<number, { x: number; y: number }>()
  const pair = () => {
    const [a, b] = touches.values()
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      spread: Math.hypot(a.x - b.x, a.y - b.y),
    }
  }
  // Each two-finger gesture either pinches (OrbitControls zooms) or pivots
  // (zoom held off), so a pinch doesn't tilt and a drag doesn't zoom.
  let gesture: {
    start: ReturnType<typeof pair>
    mode: 'pinch' | 'pivot' | null
    enableZoom: boolean
  } | null = null
  const endGesture = () => {
    if (gesture?.mode === 'pivot') controls.enableZoom = gesture.enableZoom
    gesture = null
  }
  let drag: { id: number; x: number; y: number } | null = null

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch') {
      // A new gesture; a lost pointerup can't leave a stale finger behind.
      if (event.isPrimary) touches.clear()
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
      endGesture()
      if (touches.size === 2) {
        gesture = { start: pair(), mode: null, enableZoom: controls.enableZoom }
      }
    } else if (isPivotButton(event.button) && inEarthFocus()) {
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY }
    }
  }
  const onPointerMove = (event: PointerEvent) => {
    const touch = touches.get(event.pointerId)
    if (touch) {
      const before = gesture ? pair() : null
      touch.x = event.clientX
      touch.y = event.clientY
      if (!gesture || !before || !inEarthFocus()) return
      const after = pair()
      if (gesture.mode === null) {
        const travel = Math.hypot(
          after.x - gesture.start.x,
          after.y - gesture.start.y
        )
        const stretch = Math.abs(after.spread - gesture.start.spread)
        if (Math.max(travel, stretch) < GESTURE_LOCK_PX) return
        gesture.mode = stretch > travel ? 'pinch' : 'pivot'
        if (gesture.mode === 'pivot') {
          // three-stdlib checks this on every two-finger move.
          controls.enableZoom = false
          turn(after.x - gesture.start.x, after.y - gesture.start.y)
        }
      } else if (gesture.mode === 'pivot') {
        turn(after.x - before.x, after.y - before.y)
      }
    } else if (drag && event.pointerId === drag.id) {
      turn(event.clientX - drag.x, event.clientY - drag.y)
      drag.x = event.clientX
      drag.y = event.clientY
    }
  }
  const onPointerUp = (event: PointerEvent) => {
    touches.delete(event.pointerId)
    if (touches.size < 2) endGesture()
    if (event.pointerId === drag?.id) drag = null
  }
  // Stops middle-click autoscroll.
  const onMouseDown = (event: MouseEvent) => {
    if (event.button === 1 && inEarthFocus()) event.preventDefault()
  }

  dom.addEventListener('pointerdown', onPointerDown)
  dom.addEventListener('mousedown', onMouseDown)
  doc.addEventListener('pointermove', onPointerMove)
  doc.addEventListener('pointerup', onPointerUp)
  doc.addEventListener('pointercancel', onPointerUp)
  return () => {
    endGesture()
    dom.removeEventListener('pointerdown', onPointerDown)
    dom.removeEventListener('mousedown', onMouseDown)
    doc.removeEventListener('pointermove', onPointerMove)
    doc.removeEventListener('pointerup', onPointerUp)
    doc.removeEventListener('pointercancel', onPointerUp)
  }
}

const easeToZero = (value: number) =>
  Math.abs(value) < 1e-4 ? 0 : value * (1 - PIVOT_EASE)

/**
 * Earth focus: a right-drag (two-finger click-drag on a trackpad), a
 * middle-drag or a two-finger touch drag tilts the camera toward the horizon and turns its heading
 * (tides-7yt). Leaving Earth focus eases both back to zero. `dom` is the
 * element OrbitControls listens on, which drei swaps when the View's event
 * layer reconnects.
 */
function useEarthPivot(
  camera: Camera,
  controls: OrbitControlsImpl | null,
  cameraFocus: CameraFocus,
  dom: HTMLElement | undefined
) {
  const pivot = useRef<Pivot>({ tilt: 0, heading: 0, depth: 0 })

  useEffect(
    () =>
      controls
        ? tiltControls(
            controls,
            camera,
            pivot.current,
            () => useStore.getState().earthRadius ?? 0
          )
        : undefined,
    [camera, controls]
  )

  useEffect(
    () =>
      controls && cameraFocus === 'earth' ? takeEarthInputs(controls) : undefined,
    [controls, cameraFocus]
  )

  useEffect(
    () =>
      controls && dom ? listenForPivot(dom, controls, pivot.current) : undefined,
    [controls, dom]
  )

  useFrame(() => {
    if (!controls) return
    const p = pivot.current
    if (inEarthFocus()) {
      p.depth = pivotDepth(controls.rotateSpeed)
    } else {
      p.tilt = easeToZero(p.tilt)
      p.heading = easeToZero(p.heading)
      p.depth = easeToZero(p.depth)
    }
  })
}

export const useCamera = () => useContext(CameraContext)

export const CameraProvider = ({ children }: { children: any }) => {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls)
  const cameraTarget = useRef(new Vector3())
  const rideRef = useClockRide(controls)
  const focusedObject = useRef<{
    object: Object3D
    instanceId?: number
  } | null>(null)
  const cameraFocus = useStore((s) => s.cameraFocus)
  const setCameraFocus = useStore((s) => s.setCameraFocus)
  const earth = useStore((s) => s.earth)
  const sun = useStore((s) => s.sun)
  const moon = useStore((s) => s.moon)
  const clock = useStore((s) => s.clock)
  const locationPin = useStore((s) => s.locationPin)
  const location = useStore((s) => s.location)
  const earthRadius = useStore((s) => s.earthRadius)

  // drei's OrbitControls connects to the same element.
  const connected = useThree((s) => s.events.connected) as
    | HTMLElement
    | undefined
  const canvas = useThree((s) => s.gl.domElement)
  useEarthPivot(
    camera,
    controls as OrbitControlsImpl | null,
    cameraFocus,
    connected || canvas
  )

  useFrame((state) => {
    const target = new Vector3()
    let hasTarget = false

    if (cameraFocus) {
      if (cameraFocus === 'location') {
        if (locationPin?.current) {
          locationPin.current.getWorldPosition(target)
          hasTarget = true
        } else if (location && earth?.current && earthRadius != null) {
          const { position } = calculateLocationAndRotationForLatLng(
            location.lat,
            location.lon,
            earthRadius
          )
          target.set(position.x, position.y, position.z)
          earth.current.localToWorld(target)
          hasTarget = true
        }
      } else {
        const ref =
          cameraFocus === 'clock'
            ? clock
            : cameraFocus === 'earth'
            ? earth
            : cameraFocus === 'sun'
            ? sun
            : moon
        if (ref?.current) {
          if (cameraFocus === 'clock') {
            ref.current.getWorldPosition(target)
          } else {
            target.copy(ref.current.position)
          }
          hasTarget = true
        }
      }
    }

    const focused = focusedObject.current
    if (!hasTarget && focused) {
      if (focused.instanceId !== undefined) {
        const instanced = focused.object as InstancedMesh
        const instanceMatrix = new Matrix4()
        instanced.getMatrixAt(focused.instanceId, instanceMatrix)
        target.copy(new Vector3().setFromMatrixPosition(instanceMatrix))
      } else {
        focused.object.getWorldPosition(target)
      }
      hasTarget = true
    }

    if (hasTarget && controls) {
      const smoothness = 0.05
      if (cameraFocus === 'clock' && clock?.current) {
        rideWithClock(
          camera.position,
          // @ts-ignore
          controls.target,
          cameraTarget.current,
          target,
          rideRef.current,
          smoothness
        )
      } else {
        leaveClock(rideRef.current)
        cameraTarget.current.lerp(target, smoothness)
      }
      camera.lookAt(cameraTarget.current)
      // @ts-ignore
      controls.target.copy(cameraTarget.current)
      const ortho = camera as OrthographicCamera
      // @ts-ignore
      controls.rotateSpeed =
        cameraFocus === 'earth' && earthRadius != null && ortho.isOrthographicCamera
          ? surfaceGrabRotateSpeed(
              (ortho.top - ortho.bottom) / (ortho.zoom * state.size.height),
              // @ts-ignore
              controls.domElement.clientHeight,
              earthRadius
            )
          : 1
      // @ts-ignore
      controls.update()
    }
  })

  // Handle focus: update store (and thus dropdown) when a known body is clicked.
  const handleFocus = useCallback(
    (event: any) => {
      const object = event.intersection?.object ?? event.object
      const instanceId = event.instanceId
      const focus = getFocusForObject(object)
      if (focus) {
        setCameraFocus(focus)
      }
      focusedObject.current =
        instanceId !== undefined ? { object, instanceId } : { object }
    },
    [setCameraFocus]
  )
  const value = useMemo(() => ({ handleFocus }), [handleFocus])

  return (
    <CameraContext.Provider value={value}>
      {children}
    </CameraContext.Provider>
  )
}
