// Close zoom (tides-tvr.7.1): the system view zooms into Earth past
// minDistance's barrier (MIN_DISTANCE_FACTOR × Earth's radius) down to about
// a kilometre over the ground, in real time only.
//
// Below the barrier, in Earth focus, the zoom floor follows the ground's
// drawn height (the DEM terrain floor, ship/terrain-floor.ts), each zoom step
// shrinks with altitude, and the eye turns with Earth (frame-carry) so the
// ground doesn't sweep under it. In any focus the near plane follows the
// ground and Earth's shells as ship mode's does. The store's `closeZoom` is
// the shared predicate the later beads (tides-tvr.7.2 tiles, 7.3 detail) read.

import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Quaternion, Vector3, type Camera, type Object3D } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { MIN_DISTANCE_FACTOR } from './main-view'
import type { Pivot } from './pivot'
import { useStore } from './store'
import { EARTH_KM_PER_UNIT } from './surface-handover'
import { TERRAIN_DISPLACEMENT } from './cloud-layer'
import { NEAR_MIN as SHIP_NEAR_MIN } from './ship/ship-session'
import {
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

/** The barrier's altitude as a share of its distance: where a zoom step is still a whole one. */
const BARRIER_SHARE = (MIN_DISTANCE_FACTOR - 1) / MIN_DISTANCE_FACTOR

/** Keeps zoomSpeed positive (a scroll that never reverses) with the eye transiently under the ground. */
const MIN_ZOOM_SPEED = 1e-5

/**
 * OrbitControls' zoomSpeed for an eye `d` from Earth's centre over ground
 * `gT`: 1 at the barrier and above, then falling with the altitude's share
 * of the distance, so a wheel notch (0.95^zoomSpeed of the distance) cuts
 * about a fifth of the altitude all the way down.
 */
export function closeZoomSpeed(d: number, gT: number): number {
  return Math.min(1, Math.max(MIN_ZOOM_SPEED, (d - gT) / d / BARRIER_SHARE))
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
 * How far from Earth's centre the drawn ground stands under the world point
 * `p`, highest within `angle` of it, scene units, for Earth's sphere of
 * `radius` (`earth` its spinning object, whose own frame is the terrain
 * floor's: lon 0 on +X, east toward −Z). Before the floor loads, the fixed
 * sphere over any ground. The base 128 × 128 sphere's floor: once tides-tvr.7.3
 * draws the limb sphere in the system view, this must read earthLimbTerrain().
 */
export function earthGroundRadius(
  earth: Object3D,
  p: Vector3,
  radius: number,
  angle: number
): number {
  _local.copy(p)
  earth.worldToLocal(_local).normalize()
  const floor = earthTerrain()
  return floor
    ? radius + (TERRAIN_DISPLACEMENT * terrainFloorGreyAround(floor, _local, angle)) / 255
    : terrainFloorRadius(null, radius, _local)
}

/**
 * Close zoom's per-frame state for CameraProvider, written only by the
 * instance with controls (the main view's). `floor` is useEyeDistance's
 * lower limit in Earth focus, null until one has been worked out;
 * `groundUnderTarget` the pivot's radius, null while not in close zoom in
 * Earth focus; `guard` that the shown eye is within half the clearance of
 * the ground, so the floor must hold at once rather than be eased to.
 */
export const closeZoomState = {
  floor: null as number | null,
  groundUnderTarget: null as number | null,
  guard: false,
}

const _centre = new Vector3()
const _normal = new Vector3()
const _right = new Vector3()
const _point = new Vector3()
const _up = new Vector3(0, 1, 0)
const _now = new Quaternion()

/** One CameraProvider's close zoom: whether it owns the shared state (it has controls), and Earth's last turn. */
interface CloseZoomOwner {
  owns: boolean
  wasClose: boolean
  hasPrevious: boolean
  previous: Quaternion
}

/** Start the terrain floor's fetch and build once the eye is within this many barriers of Earth's centre. */
const TERRAIN_LOAD_BARRIERS = 2

function leaveCloseZoom(
  owner: CloseZoomOwner,
  controls: OrbitControlsImpl | null,
  spin: Quaternion
) {
  owner.wasClose = false
  owner.hasPrevious = false
  spin.identity()
  closeZoomState.groundUnderTarget = null
  closeZoomState.guard = false
  if (controls && controls.zoomSpeed !== 1) controls.zoomSpeed = 1
  if (useStore.getState().closeZoom) useStore.getState().setCloseZoom(false)
}

/**
 * Steps close zoom each frame: the store's flag, and in Earth focus the
 * floor, zoom speed and Earth's turn since last frame into `spin`, which
 * tiltControls spends on the next update. Call it before CameraProvider's
 * frame, so that frame's update carries the eye.
 */
export function useCloseZoom(camera: Camera, pivot: Pivot, spin: Quaternion) {
  const get = useThree((s) => s.get)
  const ownerRef = useRef<CloseZoomOwner>({
    owns: false,
    wasClose: false,
    hasPrevious: false,
    previous: new Quaternion(),
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
      if (owner.wasClose || state.closeZoom) leaveCloseZoom(owner, controls, spin)
      return
    }
    earth.getWorldPosition(_centre)
    const eyeR = camera.position.distanceTo(_centre)
    const close = isCloseZoom(eyeR, radius, owner.wasClose)
    if (close !== state.closeZoom) state.setCloseZoom(close)
    owner.wasClose = close

    const earthFocus = state.cameraFocus === 'earth'
    // Not while zoomed out: the fallback floor covers it until it lands.
    if (earthFocus && eyeR < TERRAIN_LOAD_BARRIERS * MIN_DISTANCE_FACTOR * radius) {
      loadEarthTerrain()
    }
    const clearance = closeZoomClearance(reversedFloatDepth(frame.gl))
    if (!close || !earthFocus) {
      owner.hasPrevious = false
      spin.identity()
      closeZoomState.groundUnderTarget = null
      closeZoomState.guard = false
      if (controls.zoomSpeed !== 1) controls.zoomSpeed = 1
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
    const gT = earthGroundRadius(earth, _point.addVectors(_centre, _normal), radius, 0)
    const gE = earthGroundRadius(
      earth,
      camera.position,
      radius,
      groundAngle(eyeR - radius, radius)
    )
    closeZoomState.floor = closeZoomFloor(gT, gE, clearance, pivot.tilt)
    closeZoomState.groundUnderTarget = gT
    closeZoomState.guard = eyeR < gE + clearance / 2

    const speed = closeZoomSpeed(controls.getDistance(), gT)
    if (controls.zoomSpeed !== speed) controls.zoomSpeed = speed

    earth.getWorldQuaternion(_now)
    if (owner.hasPrevious) spin.copy(_now).multiply(owner.previous.invert())
    else spin.identity()
    owner.previous.copy(_now)
    owner.hasPrevious = true
  })
}
