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
  MathUtils,
  Vector3,
  Matrix4,
  type Camera,
  type InstancedMesh,
  type Object3D,
  type PerspectiveCamera,
} from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import {
  FOCUS_VALUES,
  isSystemFocus,
  useStore,
  type CameraFocus,
} from './store'
import { calculateLocationAndRotationForLatLng } from './utils'
import { leaveClock, rideWithClock, useClockRide } from './clock-view'
import {
  MAIN_DISTANCE,
  focusedRef,
  framingDistance,
  mainNearFar,
  targetUnitsPerPixel,
} from './main-view'
import {
  LABEL_KEYS,
  bodyRadius,
  bodyReach,
} from './system-aids/label-visibility'
import { CLOCK_HALF_WIDTH } from './orbit-label'
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
 * on, which drei swaps when the View's event layer reconnects.
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
    settlePivot(
      pivot.current,
      inEarthFocus() ? pivotDepth(controls.rotateSpeed) : null
    )
  })
}

// Covers Earth's atmosphere and aurora shells beyond its sphere.
const NEAR_CLEARANCE = 1.1

// How far each body reaches for the near plane: its shells, or its rings.
const NEAR_REACH = LABEL_KEYS.map((key) =>
  Math.max(NEAR_CLEARANCE * bodyRadius(key), bodyReach(key))
)

/**
 * Sets the main view's near plane short of the nearest body's reach (and of
 * the clock round its centre in clock focus) and its far plane past the whole
 * system, every frame (mainNearFar). Call it after CameraProvider's frame,
 * which moves the eye.
 */
function useMainNearFar() {
  const centre = useMemo(() => new Vector3(), [])
  useFrame(({ camera, controls }) => {
    const perspective = camera as PerspectiveCamera
    if (!controls || !perspective.isPerspectiveCamera) return
    const state = useStore.getState()
    const eye = perspective.position
    let surface =
      eye.distanceTo((controls as OrbitControlsImpl).target) -
      (state.cameraFocus === 'clock' ? CLOCK_HALF_WIDTH : 0)
    LABEL_KEYS.forEach((key, i) => {
      const object = (state[key] as { current?: Object3D | null } | undefined)
        ?.current
      if (!object) return
      surface = Math.min(
        surface,
        object.getWorldPosition(centre).distanceTo(eye) - NEAR_REACH[i]
      )
    })
    const sun = state.sun?.current
    const eyeFromSun = sun ? sun.getWorldPosition(centre).distanceTo(eye) : eye.length()
    const { near, far } = mainNearFar(surface, eyeFromSun)
    if (near !== perspective.near || far !== perspective.far) {
      perspective.near = near
      perspective.far = far
      perspective.updateProjectionMatrix()
    }
  })
}

const FRAMING_EASE = 0.05

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
 * Choosing a planet dollies the eye to framingDistance once the planet has
 * registered its mesh (with userData.radius); leaving a planet dollies it
 * back to MAIN_DISTANCE. The ease runs on the inverse distance, i.e. the
 * apparent size, as the ortho zoom did. Any other distance change, i.e. the
 * user scrolling or pinching, ends the framing so it never fights them.
 */
function usePlanetFraming(cameraFocus: CameraFocus) {
  // The distance this hook last saw or wrote; null until the first frame
  // after the focus changed.
  const framing = useRef<{ written: number | null } | null>(null)
  const previousFocus = useRef<CameraFocus | null>(null)

  useEffect(() => {
    const leftPlanet =
      previousFocus.current !== null && isSystemFocus(previousFocus.current)
    previousFocus.current = cameraFocus
    framing.current =
      isSystemFocus(cameraFocus) || leftPlanet ? { written: null } : null
  }, [cameraFocus])

  // Only the main view has controls; the other panels' cameras stay put.
  useFrame(({ camera, controls }) => {
    const f = framing.current
    if (!f || !controls || !(camera as PerspectiveCamera).isPerspectiveCamera) {
      return
    }
    const orbit = controls as OrbitControlsImpl
    const distance = orbit.getDistance()
    if (f.written === null) {
      f.written = distance
    } else if (Math.abs(distance - f.written) > f.written * 1e-6) {
      framing.current = null
      return
    }
    const goal = framingGoal(cameraFocus)
    if (goal === null) return
    const next = 1 / MathUtils.lerp(1 / distance, 1 / goal, FRAMING_EASE)
    const done = Math.abs(goal - next) < goal * 1e-3
    orbit.setScale((done ? goal : next) / distance)
    if (done) framing.current = null
    else f.written = orbit.getDistance()
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
  usePlanetFraming(cameraFocus)

  useFrame((state) => {
    const target = new Vector3()
    let hasTarget = false
    let ref: { current?: Object3D | null } | undefined

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
        ref = focusedRef(useStore.getState(), cameraFocus)
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
      if (cameraFocus === 'clock' && ref?.current) {
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
      // @ts-ignore
      controls.rotateSpeed =
        cameraFocus === 'earth' && earthRadius != null
          ? surfaceGrabRotateSpeed(
              targetUnitsPerPixel(
                (controls as OrbitControlsImpl).getDistance() - earthRadius,
                state.size.height
              ),
              // @ts-ignore
              controls.domElement.clientHeight,
              earthRadius
            )
          : 1
      // @ts-ignore
      controls.update()
    }
  })
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
