import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../store'
import { mainCameraPose } from '../main-camera-session'
import { settleShip, stepShip, type ShipState } from './flight'
import { shipInput } from './ship-input'
import { getShipTarget, shipTelemetry } from './ship-telemetry'
import { createShipBodies, EARTH_SHELL_RADII, shipBodyVelocity, updateShipBodies, updateShipBody } from './ship-bodies'
import {
  NEAR_MIN,
  SHIP_SETTLE_PRIORITY,
  fineGroundDepth,
  shellGap,
  shipFar,
  shipNear,
  shipNearFloor,
  spawnPose,
  spawnPoseFromCamera,
} from './ship-session'
import { clearLimbView, disposeLimbSpheres, updateLimbView } from './limb-detail'
import { setSurfaceEye } from '../surface-handover'
import { reversedFloatDepth } from '../renderers/depth-precision'
import { SURFACE_TILES_ON } from '../surface'
import { carryShip, earthSpinRate, fillAir, fillAirUncarried, fillEarthEye, resetFrameCarry, shipCarry } from './frame-carry'

// Ship mode runs the sim at 1×, where bodies move ~1e-5 units/s: re-running
// the ephemeris every frame would buy nothing, so it waits for this much sim
// time to pass. Not Earth's (nor the Moon's) over the streamed tiles: the
// ship can stand 30 m over their ground, and Earth carries the ship by
// exactly how far it moved each frame (tides-zmw.9.8, tides-zmw.9.18).
const BODY_REFRESH_MS = 250

// Without the carry, Earth's velocity, scene units per sim second, as of the
// last refresh: the air's speed takes it out (fillAirUncarried).
const earthVelocity = new THREE.Vector3()
const earthVelocityNow = new THREE.Vector3()

/**
 * Flies the ship view's camera: each frame, steps the flight model with the
 * pilot's input against the bodies at the sim time, then puts the camera
 * where the ship is. Mount inside the ship View, next to its default
 * PerspectiveCamera.
 */
export function ShipController() {
  const bodies = useMemo(createShipBodies, [])
  const earth = useMemo(() => bodies.find((body) => body.key === 'earth'), [bodies])
  const moon = useMemo(() => bodies.find((body) => body.key === 'moon'), [bodies])
  const bodiesAt = useRef<number | null>(null)
  const ship = useRef<ShipState | null>(null)

  useEffect(
    () => () => {
      clearLimbView()
      disposeLimbSpheres()
      setSurfaceEye(Infinity)
      resetFrameCarry(shipCarry)
    },
    []
  )

  // The near and far planes for the ship at `position`, `groundGap` over the
  // ground and on a depth buffer whose floor is `nearFloor`.
  const setPlanes = (camera: THREE.PerspectiveCamera, position: THREE.Vector3, groundGap: number, nearFloor: number) => {
    // Earth's shells stand off its ground, so the ground's gap alone would let
    // the near plane cut them on the way down through them.
    const near = shipNear(
      groundGap,
      earth ? shellGap(position.distanceTo(earth.position), EARTH_SHELL_RADII) : Infinity,
      nearFloor
    )
    // The Sun sits at the origin.
    const far = shipFar(position.length())
    if (camera.near !== near || camera.far !== far) {
      camera.near = near
      camera.far = far
      camera.updateProjectionMatrix()
    }
  }

  // Priority 0: after SimClock (−1) has set this frame's time, before drei's
  // View renders (≥ 1), so the frame draws where the ship is now.
  useFrame(({ camera, gl, size, viewport }, delta) => {
    if (!('isPerspectiveCamera' in camera)) return
    const t = useStore.getState().timestamp ?? Date.now()
    if (bodiesAt.current == null || Math.abs(t - bodiesAt.current) >= BODY_REFRESH_MS) {
      updateShipBodies(bodies, t)
      bodiesAt.current = t
      if (!SURFACE_TILES_ON && earth) shipBodyVelocity(earth, t, earthVelocity)
    } else if (SURFACE_TILES_ON && earth) {
      updateShipBody(earth, t)
      if (moon) updateShipBody(moon, t)
    }
    // On the first frame rather than on mount: a ?ship=1 link mounts this
    // before the clock has ticked, and the view's size is known by now.
    ship.current ??= spawnPoseFromCamera(
      mainCameraPose(),
      useStore.getState().shipSaved?.cameraFocus ?? 'earth',
      bodies
    ) ?? spawnPose(bodies, size.width / size.height)
    const state = ship.current
    // Over the tiles, Earth (or the Moon) carries the ship over the frame
    // before it steps, so the step, the floor's marks and the settle see the
    // ship where the ground left it (frame-carry.ts, tides-zmw.9.18).
    const timeScale = useStore.getState().timeScale
    const spinRate = earthSpinRate(timeScale)
    if (SURFACE_TILES_ON && earth) carryShip(shipCarry, state, earth, moon ?? null, delta, spinRate)
    setSurfaceEye(earth ? state.position.distanceTo(earth.position) - earth.radius : Infinity)
    // Read each frame: the depth probe may answer after the first ones.
    if (SURFACE_TILES_ON) earth?.floor?.beginFrame(fineGroundDepth(SURFACE_TILES_ON, reversedFloatDepth(gl)))
    stepShip(state, shipInput, delta, { bodies, targetKey: getShipTarget() }, shipTelemetry)
    if (SURFACE_TILES_ON && earth) fillAir(shipCarry, shipTelemetry, state, earth, spinRate)
    // Without the carry the ship flies in the heliocentric frame: the air's
    // speed (the HUD's, tides-d9f.1) takes Earth's orbit and spin out of it.
    else if (earth) {
      earthVelocityNow.copy(earthVelocity).multiplyScalar(Number.isFinite(timeScale) ? timeScale : 0)
      fillAirUncarried(shipTelemetry, state, earth, earthVelocityNow, spinRate)
    }
    if (earth) fillEarthEye(shipTelemetry, state.position, earth)
    if (SURFACE_TILES_ON) earth?.floor?.mark(state.position)
    updateLimbView(shipTelemetry.nearest.key, bodies, state.position, size.height * viewport.dpr, camera.fov, camera)

    camera.position.copy(state.position)
    camera.quaternion.copy(state.orientation)
    // Without the tiles, the planes from the gap under the ship, here, as
    // before tides-zmw.9.8.
    if (!SURFACE_TILES_ON) setPlanes(camera, state.position, shipTelemetry.nearest.surfaceDistance, NEAR_MIN)
  })

  // Over the tiles, after their update (they're the ground this frame
  // draws): take in what changed under the ship, put it back over the
  // ground, and set the near plane from the ground across its reach, so the
  // eye stands at least the hard clearance over the ground of the frame it
  // draws (tides-zmw.9.8).
  useFrame(({ camera, gl }, delta) => {
    const state = ship.current
    if (!SURFACE_TILES_ON || !state || !('isPerspectiveCamera' in camera)) return
    earth?.floor?.settle(delta)
    settleShip(state, { bodies })
    earth?.floor?.mark(state.position)
    camera.position.copy(state.position)
    const nearest = shipTelemetry.nearest
    const groundGap =
      earth?.floor && nearest.key === earth.key ? earth.floor.nearGap(state.position) : nearest.surfaceDistance
    setPlanes(camera, state.position, groundGap, shipNearFloor(fineGroundDepth(SURFACE_TILES_ON, reversedFloatDepth(gl))))
  }, SHIP_SETTLE_PRIORITY)

  return null
}
