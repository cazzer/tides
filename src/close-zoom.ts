// Close zoom (tides-tvr.7.1): the system view zooms into Earth past
// minDistance's barrier (MIN_DISTANCE_FACTOR × Earth's radius) down to about
// a kilometre over the ground, in real time only.
//
// Below the barrier, in Earth focus, the zoom floor follows the ground's
// drawn height (the DEM terrain floor, ship/terrain-floor.ts), each zoom step
// eases toward the floor and lands on it, and the eye turns with Earth
// (frame-carry) so the ground doesn't sweep under it. In any focus the near
// plane follows the ground and Earth's shells as ship mode's does. The
// store's `closeZoom` is the shared predicate the later beads (tides-tvr.7.2
// tiles, 7.3 detail) read.
//
// In close zoom the main camera also feeds the limb view (ship/limb-detail.ts,
// tides-tvr.7.3), as the ship's does in flight: Earth trades up to the limb
// sphere with the DEM's fine mesh and morph, and its shells, haze and cloud
// march draw from inside for that camera alone (earth-shells.ts
// eyeNearEarth). On leaving, the view clears and its spheres are let go once
// Earth's meshes have let go of them.

import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Quaternion, Vector3, type Camera, type Object3D, type PerspectiveCamera } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { MIN_DISTANCE_FACTOR } from './main-view'
import type { Pivot, Spin } from './pivot'
import { useStore } from './store'
import { EARTH_KM_PER_UNIT, SURFACE_TOP, tileGroundRadius } from './surface-handover'
import { isTileRange } from './close-zoom-rules'
import { TERRAIN_DISPLACEMENT } from './cloud-layer'
import { NEAR_MIN as SHIP_NEAR_MIN } from './ship/ship-session'
import {
  clearLimbView,
  limbEye,
  limbSphereInUse,
  releaseLimbSpheres,
  updateLimbView,
  type LimbCandidate,
} from './ship/limb-detail'
import {
  earthLimbTerrain,
  earthTerrain,
  loadEarthTerrain,
  terrainFloorGreyAround,
  terrainFloorRadius,
} from './ship/terrain-floor'
import { reversedFloatDepth } from './renderers/depth-precision'

/** How far past the barrier the eye must back out before close zoom ends, as a share of it. */
export const CLOSE_ZOOM_HYSTERESIS = 0.01

/**
 * Whether an eye `eyeDistance` from Earth's centre is in close zoom: below
 * the barrier (MIN_DISTANCE_FACTOR · `earthRadius`) to enter, and past it by
 * CLOSE_ZOOM_HYSTERESIS to leave, so an eye resting on it doesn't flicker.
 */
export function isCloseZoom(
  eyeDistance: number,
  earthRadius: number,
  wasClose: boolean
): boolean {
  const barrier = MIN_DISTANCE_FACTOR * earthRadius
  return eyeDistance < (wasClose ? barrier * (1 + CLOSE_ZOOM_HYSTERESIS) : barrier)
}

/**
 * How far over the ground the eye stops, scene units: 1 km on a reversed-Z
 * float depth buffer, whose near plane can come that close. Elsewhere the
 * near plane stops at ship mode's NEAR_MIN, so twice that keeps it off the
 * ground (~4 km).
 */
export function closeZoomClearance(reversedFloat: boolean): number {
  return reversedFloat ? 1 / EARTH_KM_PER_UNIT : 2 * SHIP_NEAR_MIN
}

/**
 * The untilted eye distance (from Earth's centre) the zoom stops at: the
 * ground under the target `gT` (the pivot, at screen centre), plus enough
 * that the eye, tipped `tilt` about that ground (pivot.ts applyTilt), stays
 * `clearance` over the ground under itself, `gE`.
 */
export function closeZoomFloor(
  gT: number,
  gE: number,
  clearance: number,
  tilt: number
): number {
  return gT + (Math.max(gE - gT, 0) + clearance) / Math.cos(tilt)
}

/** Keeps zoomSpeed positive (a scroll that never reverses) with the eye transiently under the ground. */
const MIN_ZOOM_SPEED = 1e-5

/** The share of the way left a wheel notch moves far over the floor… */
const ZOOM_SHARE_FAR = 0.2
/** …and at it. */
const ZOOM_SHARE_NEAR = 0.08
/** The height over the floor the share eases across, scene units (30 km). */
const ZOOM_EASE = 30 / EARTH_KM_PER_UNIT
/**
 * How far past the floor a notch reaches, scene units (1 km): a feel, not the
 * depth buffer's clearance, which is ~4 km without reversed-Z and would keep
 * the last notches long.
 */
const ZOOM_LANDING = 1 / EARTH_KM_PER_UNIT

/**
 * OrbitControls' zoomSpeed zooming in, for an eye `d` from Earth's centre
 * over the zoom `floor`: a wheel notch (0.95^zoomSpeed of the distance)
 * moves a share of the way left to the floor plus ZOOM_LANDING, so the last
 * notch overshoots it and OrbitControls' minDistance clamp lands the eye on
 * it. The share is about a fifth far out, easing to 8% within tens of km of
 * the floor; at the barrier and above the cap holds it at 1.
 */
export function closeZoomInSpeed(d: number, floor: number): number {
  const h = Math.max(d - floor, 0)
  const share = ZOOM_SHARE_FAR - (ZOOM_SHARE_FAR - ZOOM_SHARE_NEAR) * Math.exp(-h / ZOOM_EASE)
  const step = share * (h + ZOOM_LANDING)
  const s = Math.log(1 - step / d) / Math.log(0.95)
  // A step of the whole distance (s = +Infinity) is a whole notch; NaN (a
  // step past the centre, or no distance) the least.
  return s > 0 ? Math.min(1, Math.max(MIN_ZOOM_SPEED, s)) : MIN_ZOOM_SPEED
}

/** The barrier's altitude as a share of its distance: where a zoom step is still a whole one. */
const BARRIER_SHARE = (MIN_DISTANCE_FACTOR - 1) / MIN_DISTANCE_FACTOR

/**
 * OrbitControls' zoomSpeed zooming out, for an eye `d` from Earth's centre
 * over ground `gT`: 1 at the barrier and above, then falling with the
 * altitude's share of the distance, so a wheel notch (1/0.95^zoomSpeed of
 * the distance) adds about a fifth of the altitude all the way up, as
 * close zoom has since tides-tvr.7.1.
 */
export function closeZoomOutSpeed(d: number, gT: number): number {
  return Math.min(1, Math.max(MIN_ZOOM_SPEED, (d - gT) / d / BARRIER_SHARE))
}

/** The zoomSpeed each way, set each frame; zoomWays hands OrbitControls the one an input zooms. */
const zoomSpeeds = { in: 1, out: 1 }

function setZoomSpeeds(controls: OrbitControlsImpl, zoomIn: number, zoomOut: number) {
  zoomSpeeds.in = zoomIn
  zoomSpeeds.out = zoomOut
  if (controls.zoomSpeed !== zoomIn) controls.zoomSpeed = zoomIn
}

/**
 * Which way a two-finger touch zooms on each move, from its spread against
 * the last move's, as OrbitControls' pinch measures it: 'in' as the fingers
 * spread, 'out' as they close, null while not two fingers or not spreading.
 */
export function pinchWays() {
  const touches = new Map<number, { x: number; y: number }>()
  const spread = () => {
    const [a, b] = touches.values()
    return Math.hypot(a.x - b.x, a.y - b.y)
  }
  return {
    down(id: number, x: number, y: number) {
      touches.set(id, { x, y })
    },
    up(id: number) {
      touches.delete(id)
    },
    move(id: number, x: number, y: number): 'in' | 'out' | null {
      const touch = touches.get(id)
      if (!touch) return null
      const before = touches.size === 2 ? spread() : null
      touch.x = x
      touch.y = y
      if (before === null) return null
      const after = spread()
      return after > before ? 'in' : after < before ? 'out' : null
    },
  }
}

/**
 * Hands `controls` the zoomSpeed for the way each wheel step or pinch move
 * zooms before OrbitControls takes it (capture on the document runs ahead of
 * its listeners), so zooming in eases to the floor while zooming out keeps
 * its old pace. Returns the undo.
 */
function zoomWays(controls: OrbitControlsImpl): () => void {
  const doc = controls.domElement?.ownerDocument
  if (!doc) return () => {}
  const inside = (event: Event) =>
    event.target instanceof Node && !!controls.domElement?.contains(event.target)
  const pinch = pinchWays()
  const onWheel = (event: WheelEvent) => {
    if (!inside(event) || event.deltaY === 0) return
    controls.zoomSpeed = event.deltaY < 0 ? zoomSpeeds.in : zoomSpeeds.out
  }
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'touch' && inside(event)) {
      pinch.down(event.pointerId, event.pageX, event.pageY)
    }
  }
  const onPointerMove = (event: PointerEvent) => {
    const way = pinch.move(event.pointerId, event.pageX, event.pageY)
    if (way) controls.zoomSpeed = zoomSpeeds[way]
  }
  const onPointerUp = (event: PointerEvent) => pinch.up(event.pointerId)
  const capture = { capture: true }
  doc.addEventListener('wheel', onWheel, capture)
  doc.addEventListener('pointerdown', onPointerDown, capture)
  doc.addEventListener('pointermove', onPointerMove, capture)
  doc.addEventListener('pointerup', onPointerUp, capture)
  doc.addEventListener('pointercancel', onPointerUp, capture)
  return () => {
    doc.removeEventListener('wheel', onWheel, capture)
    doc.removeEventListener('pointerdown', onPointerDown, capture)
    doc.removeEventListener('pointermove', onPointerMove, capture)
    doc.removeEventListener('pointerup', onPointerUp, capture)
    doc.removeEventListener('pointercancel', onPointerUp, capture)
  }
}

/**
 * How far round the ground under a point to look for the highest ground, in
 * radians, at `altitude` over a sphere of `radius`: about the near plane's
 * reach there (as ship mode's tides-42p), capped where the terrain floor's
 * search would grow costly.
 */
export function groundAngle(altitude: number, radius: number): number {
  return Math.min(0.05, Math.max(0, (0.75 * altitude) / radius))
}

const _local = new Vector3()

/**
 * The globe's ground around `at` (unit, Earth's frame), highest within
 * `reach`: the limb sphere's floor while Earth's ground draws that sphere,
 * whose finer quads stand its peaks higher (ship-bodies.ts reads it so too),
 * else the base sphere's.
 */
function globeGroundRadius(at: Vector3, reach: number, radius: number): number {
  const floor = (limbSphereInUse(radius) ? earthLimbTerrain() : null) ?? earthTerrain()
  return floor
    ? radius + (TERRAIN_DISPLACEMENT * terrainFloorGreyAround(floor, at, reach / radius)) / 255
    : terrainFloorRadius(null, radius, at)
}

/**
 * How far from Earth's centre the drawn ground stands under the world point
 * `p`, highest within `angle` of it, scene units, for Earth's sphere of
 * `radius` (`earth` its spinning object, whose own frame is the terrain
 * floor's: lon 0 on +X, east toward −Z).
 *
 * The globe's ground is the drawn sphere's floor: the limb sphere's while
 * close zoom's limb view has swapped it in (tides-tvr.7.3), else the base
 * 128 × 128 sphere's (before they load, the fixed sphere over any ground).
 * Where the streamed tiles draw (tides-tvr.7.2), theirs, as the ship's floor reads it
 * (surface-handover.ts tileGroundRadius). Called from useCloseZoom's frame,
 * before SurfaceTiles' (SURFACE_FRAME_PRIORITY): the floor and near plane see
 * the previous frame's tile share and tiles, the one-frame lag ship mode's
 * floor has between the handover and the tiles' update.
 */
export function earthGroundRadius(
  earth: Object3D,
  p: Vector3,
  radius: number,
  angle: number
): number {
  _local.copy(p)
  earth.worldToLocal(_local).normalize()
  return tileGroundRadius(_local, radius, angle * radius, globeGroundRadius)
}

/**
 * Close zoom's per-frame state for CameraProvider, written only by the
 * instance with controls (the main view's). `floor` is useEyeDistance's
 * lower limit in Earth focus, null until one has been worked out;
 * `groundUnderTarget` the pivot's radius and `groundUnderEye` the highest
 * ground in the eye's window (the tiles' sweep reads it), null while not in
 * close zoom in Earth focus; `guard` that the shown eye is within half the clearance of
 * the ground, so the floor must hold at once rather than be eased to.
 */
export const closeZoomState = {
  floor: null as number | null,
  groundUnderTarget: null as number | null,
  groundUnderEye: null as number | null,
  guard: false,
}

const _centre = new Vector3()
const _normal = new Vector3()
const _right = new Vector3()
const _point = new Vector3()
const _up = new Vector3(0, 1, 0)
const _now = new Quaternion()
// Earth as the limb view reads it, refilled each frame.
const _earthLimb: LimbCandidate = { key: 'earth', position: _centre, radius: 0 }
const _limbCandidates: readonly LimbCandidate[] = [_earthLimb]

/**
 * One CameraProvider's close zoom: whether it owns the shared state (it has
 * controls), Earth's last turn, the camera it feeds the limb view for (null
 * while it doesn't), and whether it still has limb spheres to let go of
 * since it stopped.
 */
interface CloseZoomOwner {
  owns: boolean
  wasClose: boolean
  hasPrevious: boolean
  previous: Quaternion
  fedCamera: Camera | null
  releasing: boolean
}

/** Start the terrain floor's fetch and build once the eye is within this many barriers of Earth's centre. */
const TERRAIN_LOAD_BARRIERS = 2

/**
 * Stops `owner` feeding the limb view: clears it while it is still the one
 * `owner` fed, and leaves its spheres to be let go (releaseLimbSpheres).
 * Never another feeder's view or spheres, such as the ship's on the frame
 * ship mode starts.
 */
function stopFeedingLimb(owner: CloseZoomOwner) {
  if (!owner.fedCamera) return
  if (limbEye() === owner.fedCamera) {
    clearLimbView()
    owner.releasing = true
  }
  owner.fedCamera = null
}

function leaveCloseZoom(
  owner: CloseZoomOwner,
  controls: OrbitControlsImpl | null,
  spin: Spin
) {
  stopFeedingLimb(owner)
  owner.wasClose = false
  owner.hasPrevious = false
  spin.turn.identity()
  closeZoomState.groundUnderTarget = null
  closeZoomState.groundUnderEye = null
  closeZoomState.guard = false
  if (controls) setZoomSpeeds(controls, 1, 1)
  if (useStore.getState().closeZoom) useStore.getState().setCloseZoom(false)
  if (useStore.getState().closeZoomTiles) useStore.getState().setCloseZoomTiles(false)
}

/**
 * Steps close zoom each frame: the store's flag, and in Earth focus the
 * floor, zoom speed and Earth's turn since last frame into `spin`, which
 * tiltControls spends on the next update. Call it before CameraProvider's
 * frame, so that frame's update carries the eye.
 */
export function useCloseZoom(camera: Camera, pivot: Pivot, spin: Spin) {
  const get = useThree((s) => s.get)
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null
  useEffect(() => (controls ? zoomWays(controls) : undefined), [controls])
  const ownerRef = useRef<CloseZoomOwner>({
    owns: false,
    wasClose: false,
    hasPrevious: false,
    previous: new Quaternion(),
    fedCamera: null,
    releasing: false,
  })
  // Every panel mounts a CameraProvider; only the one with controls clears
  // the shared state, so closing a panel leaves the main view's close zoom.
  useEffect(() => {
    const owner = ownerRef.current
    return () => {
      if (!owner.owns) return
      owner.owns = false
      closeZoomState.floor = null
      leaveCloseZoom(owner, get().controls as OrbitControlsImpl | null, spin)
      // Once Earth's meshes, unmounting after this, have let go of their
      // spheres; not as ship mode starts, whose ship reuses them and drops
      // them all on exit.
      if (owner.releasing && !useStore.getState().shipMode) {
        owner.releasing = false
        queueMicrotask(releaseLimbSpheres)
      }
    }
  }, [get, spin])

  useFrame((frame) => {
    const controls = frame.controls as OrbitControlsImpl | null
    if (!controls) return
    const owner = ownerRef.current
    owner.owns = true
    const state = useStore.getState()
    const earth = state.earth?.current as Object3D | null | undefined
    const radius = state.earthRadius
    if (!earth || radius == null || state.shipMode) {
      if (owner.wasClose || owner.fedCamera || state.closeZoom || state.closeZoomTiles) {
        leaveCloseZoom(owner, controls, spin)
      }
      return
    }
    earth.getWorldPosition(_centre)
    const eyeR = camera.position.distanceTo(_centre)
    const close = isCloseZoom(eyeR, radius, owner.wasClose)
    if (close !== state.closeZoom) state.setCloseZoom(close)
    owner.wasClose = close
    // The limb view (tides-tvr.7.3), in any focus: Earth is the only body
    // close zoom brings the eye near.
    if (close && (camera as PerspectiveCamera).isPerspectiveCamera) {
      const { fov } = camera as PerspectiveCamera
      _earthLimb.radius = radius
      updateLimbView(
        'earth',
        _limbCandidates,
        camera.position,
        frame.size.height * frame.viewport.dpr,
        fov,
        camera
      )
      owner.fedCamera = camera
      owner.releasing = false
    } else {
      stopFeedingLimb(owner)
    }
    // Each frame until Earth's meshes have let go of every sphere.
    if (owner.releasing && releaseLimbSpheres()) owner.releasing = false
    // The tiles' range (tides-tvr.7.2): only in close zoom, from the eye's
    // height over the sea-level sphere.
    const tiles = close && isTileRange(eyeR - radius, SURFACE_TOP, state.closeZoomTiles)
    if (tiles !== state.closeZoomTiles) state.setCloseZoomTiles(tiles)

    const earthFocus = state.cameraFocus === 'earth'
    // Not while zoomed out: the fallback floor covers it until it lands.
    if (earthFocus && eyeR < TERRAIN_LOAD_BARRIERS * MIN_DISTANCE_FACTOR * radius) {
      loadEarthTerrain()
    }
    const clearance = closeZoomClearance(reversedFloatDepth(frame.gl))
    if (!close || !earthFocus) {
      owner.hasPrevious = false
      spin.turn.identity()
      closeZoomState.groundUnderTarget = null
      closeZoomState.groundUnderEye = null
      closeZoomState.guard = false
      setZoomSpeeds(controls, 1, 1)
      // Over any ground, unsampled: the eye only crosses the barrier on it,
      // and the next frame, in close zoom, takes the ground's own.
      closeZoomState.floor = closeZoomFloor(
        radius,
        terrainFloorRadius(null, radius, _up),
        clearance,
        pivot.tilt
      )
      return
    }

    // The untilted eye looks at the target (Earth's centre): undo the tilt
    // (applyTilt turns the view about its own right axis) for its direction.
    _right.set(1, 0, 0).applyQuaternion(camera.quaternion)
    _normal
      .set(0, 0, 1)
      .applyQuaternion(camera.quaternion)
      .applyAxisAngle(_right, -pivot.tilt)
    // Over the streamed tiles, last frame's share and tiles: this runs before
    // SurfaceTiles' frame (0.5), the lag ship mode's floor has too.
    const gT = earthGroundRadius(earth, _point.addVectors(_centre, _normal), radius, 0)
    const gE = earthGroundRadius(
      earth,
      camera.position,
      radius,
      groundAngle(eyeR - radius, radius)
    )
    const floor = closeZoomFloor(gT, gE, clearance, pivot.tilt)
    closeZoomState.floor = floor
    closeZoomState.groundUnderTarget = gT
    closeZoomState.groundUnderEye = gE
    closeZoomState.guard = eyeR < gE + clearance / 2

    const distance = controls.getDistance()
    setZoomSpeeds(controls, closeZoomInSpeed(distance, floor), closeZoomOutSpeed(distance, gT))

    earth.getWorldQuaternion(_now)
    if (owner.hasPrevious) spin.turn.copy(_now).multiply(owner.previous.invert())
    else spin.turn.identity()
    spin.centre.copy(_centre)
    owner.previous.copy(_now)
    owner.hasPrevious = true
  })
}
