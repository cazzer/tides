import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../store'
import { stepShip, type ShipState } from './flight'
import { shipInput } from './ship-input'
import { getShipTarget, shipTelemetry } from './ship-telemetry'
import { createShipBodies, updateShipBodies } from './ship-bodies'
import { shipFar, shipNear, spawnPose } from './ship-session'
import { clearLimbView, disposeLimbSpheres, updateLimbView } from './limb-detail'

// Ship mode runs the sim at 1×, where bodies move ~1e-5 units/s: re-running
// the ephemeris every frame would buy nothing, so it waits for this much sim
// time to pass.
const BODY_REFRESH_MS = 250

/**
 * Flies the ship view's camera: each frame, steps the flight model with the
 * pilot's input against the bodies at the sim time, then puts the camera
 * where the ship is. Mount inside the ship View, next to its default
 * PerspectiveCamera.
 */
export function ShipController() {
  const bodies = useMemo(createShipBodies, [])
  const bodiesAt = useRef<number | null>(null)
  const ship = useRef<ShipState | null>(null)

  useEffect(
    () => () => {
      clearLimbView()
      disposeLimbSpheres()
    },
    []
  )

  // Priority 0: after SimClock (−1) has set this frame's time, before drei's
  // View renders (≥ 1), so the frame draws where the ship is now.
  useFrame(({ camera, size, viewport }, delta) => {
    if (!('isPerspectiveCamera' in camera)) return
    const t = useStore.getState().timestamp ?? Date.now()
    if (bodiesAt.current == null || Math.abs(t - bodiesAt.current) >= BODY_REFRESH_MS) {
      updateShipBodies(bodies, t)
      bodiesAt.current = t
    }
    // On the first frame rather than on mount: a ?ship=1 link mounts this
    // before the clock has ticked, and the view's size is known by now.
    ship.current ??= spawnPose(bodies, size.width / size.height)
    const state = ship.current
    stepShip(state, shipInput, delta, { bodies, targetKey: getShipTarget() }, shipTelemetry)
    updateLimbView(shipTelemetry.nearest.key, bodies, state.position, size.height * viewport.dpr, camera.fov)

    camera.position.copy(state.position)
    camera.quaternion.copy(state.orientation)
    const near = shipNear(shipTelemetry.nearest.surfaceDistance)
    // The Sun sits at the origin.
    const far = shipFar(state.position.length())
    if (camera.near !== near || camera.far !== far) {
      camera.near = near
      camera.far = far
      camera.updateProjectionMatrix()
    }
  })

  return null
}
