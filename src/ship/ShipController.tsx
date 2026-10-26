import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../store'
import { mainCameraPose } from '../main-camera-session'
import { settleShip, stepShip, type ShipState } from './flight'
import { shipInput } from './ship-input'
import { getShipTarget, shipTelemetry } from './ship-telemetry'
import { createShipBodies, EARTH_SHELL_RADII, updateShipBodies, updateShipBody } from './ship-bodies'
import {
  SHIP_SETTLE_PRIORITY,
  shellGap,
  shipFar,
  shipNear,
  shipNearFloor,
  spawnPose,
  spawnPoseFromCamera,
} from './ship-session'
import { clearLimbView, disposeLimbSpheres, updateLimbView } from './limb-detail'
import { setTerrainEye } from '../terrain-scale'
import { reversedFloatDepth } from '../renderers/depth-precision'

// Ship mode runs the sim at 1×, where bodies move ~1e-5 units/s: re-running
// the ephemeris every frame would buy nothing, so it waits for this much sim
// time to pass. Not Earth's: the ship can stand 30 m over its ground, which
// its orbit and spin move ~0.2 m a frame (tides-zmw.9.8).
const BODY_REFRESH_MS = 250

/**
 * Flies the ship view's camera: each frame, steps the flight model with the
 * pilot's input against the bodies at the sim time, then puts the camera
 * where the ship is. Mount inside the ship View, next to its default
 * PerspectiveCamera.
 */
export function ShipController() {
  const bodies = useMemo(createShipBodies, [])
  const earth = useMemo(() => bodies.find((body) => body.key === 'earth'), [bodies])
  const bodiesAt = useRef<number | null>(null)
  const ship = useRef<ShipState | null>(null)

  useEffect(
    () => () => {
      clearLimbView()
      disposeLimbSpheres()
      setTerrainEye(Infinity)
    },
    []
  )

  // Priority 0: after SimClock (−1) has set this frame's time, before drei's
  // View renders (≥ 1), so the frame draws where the ship is now.
  useFrame(({ camera, gl, size, viewport }, delta) => {
    if (!('isPerspectiveCamera' in camera)) return
    const t = useStore.getState().timestamp ?? Date.now()
    if (bodiesAt.current == null || Math.abs(t - bodiesAt.current) >= BODY_REFRESH_MS) {
      updateShipBodies(bodies, t)
      bodiesAt.current = t
    } else if (earth) {
      updateShipBody(earth, t)
    }
    // On the first frame rather than on mount: a ?ship=1 link mounts this
    // before the clock has ticked, and the view's size is known by now.
    ship.current ??= spawnPoseFromCamera(
      mainCameraPose(),
      useStore.getState().shipSaved?.cameraFocus ?? 'earth',
      bodies
    ) ?? spawnPose(bodies, size.width / size.height)
    const state = ship.current
    setTerrainEye(earth ? state.position.distanceTo(earth.position) - earth.radius : Infinity)
    // Read each frame: the depth probe may answer after the first ones.
    earth?.floor?.beginFrame(reversedFloatDepth(gl))
    stepShip(state, shipInput, delta, { bodies, targetKey: getShipTarget() }, shipTelemetry)
    earth?.floor?.mark(state.position)
    updateLimbView(shipTelemetry.nearest.key, bodies, state.position, size.height * viewport.dpr, camera.fov)

    camera.position.copy(state.position)
    camera.quaternion.copy(state.orientation)
  })

  // After the surface tiles' update (they're the ground this frame draws):
  // take in what changed under the ship, put it back over the ground, and
  // set the near plane from there, so the eye stands at least the hard
  // clearance over the ground of the frame it draws.
  useFrame(({ camera, gl }, delta) => {
    const state = ship.current
    if (!state || !('isPerspectiveCamera' in camera)) return
    earth?.floor?.settle(delta)
    settleShip(state, { bodies })
    earth?.floor?.mark(state.position)
    camera.position.copy(state.position)
    // Earth's shells stand off its ground, so the ground's gap alone would let
    // the near plane cut them on the way down through them.
    const nearest = shipTelemetry.nearest
    const groundGap =
      earth?.floor && nearest.key === earth.key ? earth.floor.nearGap(state.position) : nearest.surfaceDistance
    const near = shipNear(
      groundGap,
      earth ? shellGap(state.position.distanceTo(earth.position), EARTH_SHELL_RADII) : Infinity,
      shipNearFloor(reversedFloatDepth(gl))
    )
    // The Sun sits at the origin.
    const far = shipFar(state.position.length())
    if (camera.near !== near || camera.far !== far) {
      camera.near = near
      camera.far = far
      camera.updateProjectionMatrix()
    }
  }, SHIP_SETTLE_PRIORITY)

  return null
}
