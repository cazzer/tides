import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { MAX_DT } from './flight'
import { shipTelemetry } from './ship-telemetry'
import { SHIP_FOV } from './ship-session'
import { FOV_TAU, easeToward, fovKickShare, speedFov } from './dust'
import { prefersReducedMotion } from './reduced-motion'

// Below this the change isn't visible and the projection is left alone.
const FOV_EPSILON = 1e-3

/**
 * Widens the ship camera's FOV with speed (tides-3bl.6): from SHIP_FOV at
 * rest toward SHIP_FOV + FOV_KICK at the cruise cap in real cruise (see
 * fovKickShare), eased so it swells and settles rather than tracking every
 * throttle twitch. Off under prefers-reduced-motion. Touches only fov (and
 * the projection), never the pose, near or far that ShipController owns.
 */
export function useSpeedFov(): void {
  const get = useThree((s) => s.get)
  const share = useRef(0)

  // Priority 0, mounted after ShipController: this frame's telemetry, before
  // drei's View renders.
  useFrame(({ camera }, delta) => {
    if (!('isPerspectiveCamera' in camera)) return
    const target = fovKickShare(shipTelemetry.speed, shipTelemetry.speedCap)
    share.current = easeToward(share.current, target, Math.min(delta, MAX_DT), FOV_TAU)
    const fov = speedFov(share.current, prefersReducedMotion())
    if (Math.abs(camera.fov - fov) > FOV_EPSILON) {
      camera.fov = fov
      camera.updateProjectionMatrix()
    }
  })

  useEffect(
    () => () => {
      const { camera } = get()
      if (!('isPerspectiveCamera' in camera)) return
      camera.fov = SHIP_FOV
      camera.updateProjectionMatrix()
    },
    [get]
  )
}

/** useSpeedFov as a component, for the ship View's scene. */
export function SpeedFov(): null {
  useSpeedFov()
  return null
}
