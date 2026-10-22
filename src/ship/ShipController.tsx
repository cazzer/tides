import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useStore } from '../store'
import { stepShip, type ShipState } from './flight'
import { shipInput } from './ship-input'
import { getShipTarget, shipTelemetry } from './ship-telemetry'
import { createShipBodies, updateShipBodies } from './ship-bodies'
import { shipNear, spawnPose } from './ship-session'

/**
 * Flies the ship view's camera: each frame, steps the flight model with the
 * pilot's input against the bodies at the sim time, then puts the camera
 * where the ship is. Mount inside the ship View, next to its default
 * PerspectiveCamera.
 */
export function ShipController() {
  const bodies = useMemo(createShipBodies, [])
  const ship = useRef<ShipState | null>(null)

  // Priority 0: after SimClock (−1) has set this frame's time, before drei's
  // View renders (≥ 1), so the frame draws where the ship is now.
  useFrame(({ camera }, delta) => {
    if (!('isPerspectiveCamera' in camera)) return
    const t = useStore.getState().timestamp ?? Date.now()
    updateShipBodies(bodies, t)
    // On the first frame rather than on mount: a ?ship=1 link mounts this
    // before the clock has ticked.
    ship.current ??= spawnPose(bodies)
    const state = ship.current
    stepShip(state, shipInput, delta, { bodies, targetKey: getShipTarget() }, shipTelemetry)

    camera.position.copy(state.position)
    camera.quaternion.copy(state.orientation)
    const near = shipNear(shipTelemetry.nearest.surfaceDistance)
    if (camera.near !== near) {
      camera.near = near
      camera.updateProjectionMatrix()
    }
  })

  return null
}
