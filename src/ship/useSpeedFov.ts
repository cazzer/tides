import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { MAX_DT } from './flight'
import { shipTelemetry } from './ship-telemetry'
import { SHIP_FOV } from './ship-session'
import { FOV_TAU, easeToward, speedFov, speedFraction } from './dust'

// Below this the change isn't visible and the projection is left alone.
const FOV_EPSILON = 1e-3

/**
 * Widens the ship camera's FOV with speed (tides-3bl.6): from SHIP_FOV at
 * rest toward SHIP_FOV + FOV_KICK at the cruise cap, eased so it swells and
 * settles rather than tracking every throttle twitch. Touches only fov (and
 * the projection), never the pose, near or far that ShipController owns.
 */
export function useSpeedFov(): void {
  const get = useThree((s) => s.get)
  const fraction = useRef(0)

  // Priority 0, mounted after ShipController: this frame's telemetry, before
  // drei's View renders.
  useFrame(({ camera }, delta) => {
    if (!('isPerspectiveCamera' in camera)) return
    const target = speedFraction(shipTelemetry.speed, shipTelemetry.speedCap)
    fraction.current = easeToward(fraction.current, target, Math.min(delta, MAX_DT), FOV_TAU)
    const fov = speedFov(fraction.current)
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
