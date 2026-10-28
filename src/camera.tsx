import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  Vector3,
  Matrix4,
  Quaternion,
  type Camera,
  type InstancedMesh,
  type Object3D,
  type PerspectiveCamera,
  type WebGLRenderer,
} from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import {
  FOCUS_VALUES,
  isSystemFocus,
  useStore,
  type CameraFocus,
} from './store'
import { calculateLocationAndRotationForLatLng } from './utils'
import { clockRideAllowed, leaveClock, rideWithClock, useClockRide } from './clock-view'
import {
  FOCUS_EASE,
  MAIN_DISTANCE,
  allowDistance,
  focusedRef,
  followMotion,
  framingDistance,
  mainNearFar,
  maxDistance,
  minDistance,
  nearReach,
  nearestSurface,
  stepFocusDistance,
  turnTarget,
  targetUnitsPerPixel,
  type FollowAnchor,
  type NearBody,
} from './main-view'
import { LABEL_KEYS } from './system-aids/label-visibility'
import { CLOCK_HALF_WIDTH } from './clock-size'
import { mainCameraPose, takeFocusSnap, takeMainCameraRestore } from './main-camera-session'
import {
  canPivot,
  clampTilt,
  pivotDepth,
  pixelsToPivot,
  settlePivot,
  tiltControls,
  wrapAngle,
  type Pivot,
} from './pivot'
import { closeZoomState, earthGroundRadius, groundAngle, useCloseZoom } from './close-zoom'
import { reversedFloatDepth } from './renderers/depth-precision'
import { shellGap, shipNearFloor } from './ship/ship-session'
import { EARTH_SHELL_RADII } from './ship/ship-bodies'

const CameraContext = createContext({
  handleFocus: null,
})

function getFocusForObject(object: Object3D): CameraFocus | null {
  let o: Object3D | null = object
  while (o) {
    const focus = (o as Object3D & { userData?: { focus?: string } }).userData
      ?.focus
    if (focus && (FOCUS_VALUES as readonly string[]).includes(focus)) {
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

const inEarthFocus = () => useStore.getState().cameraFocus === 'earth'

/**
 * Hands the right and middle buttons and the second finger's travel to the
 * pivot. Returns the undo.
 */
function takeEarthInputs(controls: OrbitControlsImpl): () => void {
  const { MIDDLE: middle, RIGHT: right } = controls.mouseButtons
  controls.mouseButtons.MIDDLE = undefined
  controls.mouseButtons.RIGHT = undefined
  return () => {
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
    if (!canPivot(pivot)) return
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

/**
 * Earth focus: a right-drag (two-finger click-drag on a trackpad), a
 * middle-drag or a two-finger touch drag tilts the camera toward the horizon
 * and turns its heading (tides-7yt). Zooming out or leaving Earth focus eases
 * both back to zero (tides-nqy). `dom` is the element OrbitControls listens
 * on, which drei swaps when the View's event layer reconnects. Returns the
 * pivot.
 */
function useEarthPivot(
  camera: Camera,
  controls: OrbitControlsImpl | null,
  cameraFocus: CameraFocus,
  dom: HTMLElement | undefined,
  carry: Vector3,
  outsideMoveRef: { current: boolean },
  spin: Quaternion
): Pivot {
  const [pivot] = useState<Pivot>(() => ({ tilt: 0, heading: 0, depth: 0 }))

  useEffect(
    () =>
      controls
        ? tiltControls(
            controls,
            camera,
            pivot,
            // In close zoom the pivot is the ground, not the sphere.
            () =>
              closeZoomState.groundUnderTarget ??
              useStore.getState().earthRadius ??
              0,
            carry,
            () => {
              outsideMoveRef.current = true
            },
            spin
          )
        : undefined,
    [camera, controls, pivot, carry, outsideMoveRef, spin]
  )

  useEffect(
    () =>
      controls && cameraFocus === 'earth' ? takeEarthInputs(controls) : undefined,
    [controls, cameraFocus]
  )

  useEffect(
    () =>
      controls && dom ? listenForPivot(dom, controls, pivot) : undefined,
    [controls, dom, pivot]
  )

  useFrame(() => {
    if (!controls) return
    settlePivot(
      pivot,
      inEarthFocus() ? pivotDepth(controls.rotateSpeed) : null
    )
  })

  return pivot
}

// useMainNearFar's per-frame scratch: LABEL_KEYS' bodies, then the clock.
const nearBodies: NearBody[] = [...LABEL_KEYS, 'clock'].map(() => ({
  centre: new Vector3(),
  reach: 0,
}))
const nearPlanes = { near: 0, far: 0 }
const sunCentre = new Vector3()
const EARTH_NEAR_INDEX = LABEL_KEYS.indexOf('earth')

/**
 * Sets the main view's near plane short of the nearest body's reach (the
 * clock's text included) and its far plane past the whole system, every
 * frame (mainNearFar). In close zoom Earth's reach gives way to its ground
 * and shells, as ship mode's near plane takes them, down to ship mode's
 * floor. Call it after CameraProvider's frame, which moves the eye.
 */
function useMainNearFar() {
  useFrame(({ camera, controls, gl }) =>
    updateMainNearFar(camera, controls, gl)
  )
}

/** One frame of useMainNearFar, for anything that moves the main eye later in the frame. */
export function updateMainNearFar(
  camera: Camera,
  controls: unknown,
  gl: WebGLRenderer
) {
  const perspective = camera as PerspectiveCamera
  if (!controls || !perspective.isPerspectiveCamera) return
  const state = useStore.getState()
  for (let i = 0; i < LABEL_KEYS.length; i++) {
    const key = LABEL_KEYS[i]
    const object = (state[key] as { current?: Object3D | null } | undefined)
      ?.current
    nearBodies[i].reach = object ? nearReach(key) : 0
    object?.getWorldPosition(nearBodies[i].centre)
  }
  const clock = nearBodies[LABEL_KEYS.length]
  clock.reach = state.clock?.current ? CLOCK_HALF_WIDTH : 0
  state.clock?.current?.getWorldPosition(clock.centre)
  const eye = perspective.position
  const earth = state.earth?.current as Object3D | null | undefined
  const close = state.closeZoom && earth && state.earthRadius != null
  if (close) nearBodies[EARTH_NEAR_INDEX].reach = 0
  let surface = nearestSurface(
    eye,
    (controls as OrbitControlsImpl).target,
    nearBodies
  )
  let nearMin: number | undefined
  if (close) {
    const radius = state.earthRadius as number
    const eyeR = eye.distanceTo(nearBodies[EARTH_NEAR_INDEX].centre)
    const ground = earthGroundRadius(earth, eye, radius, groundAngle(eyeR - radius, radius))
    surface = Math.min(surface, eyeR - ground, shellGap(eyeR, EARTH_SHELL_RADII))
    nearMin = shipNearFloor(reversedFloatDepth(gl))
  }
  const sun = state.sun?.current
  const eyeFromSun = sun
    ? sun.getWorldPosition(sunCentre).distanceTo(eye)
    : eye.length()
  const { near, far } = mainNearFar(surface, eyeFromSun, nearPlanes, nearMin)
  if (near !== perspective.near || far !== perspective.far) {
    perspective.near = near
    perspective.far = far
    perspective.updateProjectionMatrix()
  }
}

/** The distance framing eases toward, or null while a planet or moon hasn't registered. */
function framingGoal(focus: CameraFocus): number | null {
  if (!isSystemFocus(focus)) return MAIN_DISTANCE
  const { earthRadius, [focus]: ref } = useStore.getState()
  const radius = ref?.current?.userData?.radius
  return radius > 0 && earthRadius != null
    ? framingDistance(radius, earthRadius)
    : null
}

/**
 * Eases the eye distance (stepEyeDistance) into the focus's range
 * (minDistance, maxDistance) and, on choosing a planet, to framingDistance
 * once the planet has registered its mesh (with userData.radius); leaving a
 * planet eases back to MAIN_DISTANCE, both from when the target reaches the
 * focus (stepFocusDistance). The user scrolling, pinching or middle-dragging
 * ends the framing, so it never fights them, as does anything else moving
 * the camera itself (`outsideMoveRef`, from tiltControls: a restored pose, or
 * the clock ride). Call it after CameraProvider's frame, which moves the
 * target and the anchor.
 */
function useEyeDistance(
  cameraFocus: CameraFocus,
  dom: HTMLElement | undefined,
  anchor: FollowAnchor,
  outsideMoveRef: { current: boolean }
) {
  const framing = useRef(false)
  const previousFocus = useRef<CameraFocus | null>(null)

  useEffect(() => {
    const leftPlanet =
      previousFocus.current !== null && isSystemFocus(previousFocus.current)
    const restoring = previousFocus.current === null && mainCameraPose() !== null
    previousFocus.current = cameraFocus
    framing.current =
      !restoring && (isSystemFocus(cameraFocus) || leftPlanet)
  }, [cameraFocus])

  useEffect(() => {
    if (!dom) return
    const stop = () => {
      framing.current = false
    }
    const touches = new Set<number>()
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'touch') {
        if (event.isPrimary) touches.clear()
        touches.add(event.pointerId)
        if (touches.size > 1) stop()
      } else if (event.button === 1) {
        stop()
      }
    }
    const onPointerUp = (event: PointerEvent) => touches.delete(event.pointerId)
    dom.addEventListener('wheel', stop)
    dom.addEventListener('pointerdown', onPointerDown)
    dom.addEventListener('pointerup', onPointerUp)
    dom.addEventListener('pointercancel', onPointerUp)
    return () => {
      dom.removeEventListener('wheel', stop)
      dom.removeEventListener('pointerdown', onPointerDown)
      dom.removeEventListener('pointerup', onPointerUp)
      dom.removeEventListener('pointercancel', onPointerUp)
    }
  }, [dom])

  // Only the main view has controls; the other panels' cameras stay put.
  useFrame(({ camera, controls, size }) => {
    if (!controls || !(camera as PerspectiveCamera).isPerspectiveCamera) return
    if (outsideMoveRef.current) framing.current = false
    outsideMoveRef.current = false
    const landed = stepFocusDistance(
      controls as OrbitControlsImpl,
      anchor,
      framing.current ? framingGoal(cameraFocus) : null,
      cameraFocus === 'earth'
        ? (closeZoomState.floor ?? minDistance(cameraFocus))
        : minDistance(cameraFocus),
      maxDistance(useStore.getState().showPlanets, size)
    )
    if (landed) framing.current = false
    // The shown eye is nearly in the ground: hold the floor now. The scale
    // too, as the next frame's allowDistance would widen minDistance again.
    const floor = closeZoomState.floor
    if (cameraFocus === 'earth' && closeZoomState.guard && floor !== null) {
      const orbit = controls as OrbitControlsImpl
      orbit.minDistance = floor
      const distance = orbit.getDistance()
      if (distance < floor) orbit.setScale(floor / distance)
    }
  })
}

export const useCamera = () => useContext(CameraContext)

export const CameraProvider = ({ children }: { children: any }) => {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls)
  const cameraTarget = useRef(new Vector3())
  useEffect(() => {
    if (controls) cameraTarget.current.copy((controls as OrbitControlsImpl).target)
  }, [controls])
  const anchor = useRef<FollowAnchor>({
    key: null,
    position: new Vector3(),
    speed: 0,
  })
  const carry = useMemo(() => new Vector3(), [])
  const spin = useMemo(() => new Quaternion(), [])
  const outsideMoveRef = useRef(false)
  const rideRef = useClockRide(controls)
  const focusedObject = useRef<{
    object: Object3D
    instanceId?: number
  } | null>(null)
  const cameraFocus = useStore((s) => s.cameraFocus)
  const setCameraFocus = useStore((s) => s.setCameraFocus)
  const earth = useStore((s) => s.earth)
  const locationPin = useStore((s) => s.locationPin)
  const location = useStore((s) => s.location)
  const earthRadius = useStore((s) => s.earthRadius)

  // drei's OrbitControls connects to the same element.
  const connected = useThree((s) => s.events.connected) as
    | HTMLElement
    | undefined
  const canvas = useThree((s) => s.gl.domElement)
  const pivot = useEarthPivot(
    camera,
    controls as OrbitControlsImpl | null,
    cameraFocus,
    connected || canvas,
    carry,
    outsideMoveRef,
    spin
  )
  // Before the frame below, whose update spends the spin.
  useCloseZoom(camera, pivot, spin)

  useFrame((state) => {
    // Leaving a demo: back to the pose saved on entry, once. tiltControls
    // takes it as a move from outside, which ends any framing ease.
    if (controls) {
      const restore = takeMainCameraRestore()
      if (restore) {
        camera.position.fromArray(restore.position)
        camera.up.fromArray(restore.up)
        ;(controls as OrbitControlsImpl).target.fromArray(restore.target)
        cameraTarget.current.fromArray(restore.target)
        outsideMoveRef.current = true
      }
    }

    const target = new Vector3()
    let hasTarget = false
    // What the target is on, for followMotion.
    let key: unknown = null
    let ref: { current?: Object3D | null } | undefined

    if (cameraFocus) {
      if (cameraFocus === 'location') {
        if (locationPin?.current) {
          locationPin.current.getWorldPosition(target)
          hasTarget = true
          key = cameraFocus
        } else if (location && earth?.current && earthRadius != null) {
          const { position } = calculateLocationAndRotationForLatLng(
            location.lat,
            location.lon,
            earthRadius
          )
          target.set(position.x, position.y, position.z)
          earth.current.localToWorld(target)
          hasTarget = true
          key = cameraFocus
        }
      } else {
        ref = focusedRef(useStore.getState(), cameraFocus)
        if (ref?.current) {
          if (cameraFocus === 'clock') {
            ref.current.getWorldPosition(target)
          } else {
            target.copy(ref.current.position)
          }
          hasTarget = true
          key = ref.current
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
      key = focused
    }
    followMotion(anchor.current, key, target, carry)

    if (hasTarget && controls) {
      const smoothness = FOCUS_EASE
      if (cameraFocus === 'clock' && ref?.current && clockRideAllowed(pivot)) {
        rideWithClock(
          camera.position,
          // @ts-ignore
          controls.target,
          cameraTarget.current,
          target,
          rideRef.current,
          smoothness,
          (camera as PerspectiveCamera).isPerspectiveCamera ? (camera as PerspectiveCamera).aspect : Infinity
        )
      } else {
        leaveClock(rideRef.current)
        // A demo under reduced motion has the target jump to the focus.
        turnTarget(cameraTarget.current, camera.position, target, takeFocusSnap() ? 1 : smoothness)
      }
      camera.lookAt(cameraTarget.current)
      // @ts-ignore
      controls.target.copy(cameraTarget.current)
      allowDistance(controls as OrbitControlsImpl)
      // In close zoom the surface grabbed is the ground's, not the sphere's.
      const grabRadius = closeZoomState.groundUnderTarget ?? earthRadius
      // @ts-ignore
      controls.rotateSpeed =
        cameraFocus === 'earth' && grabRadius != null
          ? surfaceGrabRotateSpeed(
              targetUnitsPerPixel(
                (controls as OrbitControlsImpl).getDistance() - grabRadius,
                state.size.height
              ),
              // @ts-ignore
              controls.domElement.clientHeight,
              grabRadius
            )
          : 1
      // @ts-ignore
      controls.update()
    }
  })
  useEyeDistance(cameraFocus, connected || canvas, anchor.current, outsideMoveRef)
  useMainNearFar()

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
