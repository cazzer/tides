import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { MAX_DT } from './flight'
import { shipTelemetry } from './ship-telemetry'
import { SHIP_SHAKE_PRIORITY, SHIP_SHAKE_RESTORE_PRIORITY } from './ship-session'
import { easeShake, shakeAngles, shakeTarget, type ShakeAngles } from './shake'
import { prefersReducedMotion } from './reduced-motion'

/**
 * Shakes the ship view in Earth's air (tides-xxg, shake.ts): with the
 * dynamic pressure, more while the boost raises the cap, eased in and out.
 * Off under prefers-reduced-motion. Touches only the camera's quaternion,
 * and only from SHIP_SHAKE_PRIORITY (after ShipController's settle, just
 * before drei's View renders) to SHIP_SHAKE_RESTORE_PRIORITY (just after
 * it), which puts the clean pose back: everything else in the frame loop,
 * the targeting and the HUD read the ship's own pose. Never the position,
 * fov, near or far.
 */
export function useShipShake(): void {
  const get = useThree((s) => s.get)
  const intensity = useRef(0)
  const applied = useRef(false)
  const clean = useRef(new THREE.Quaternion())
  const angles = useRef<ShakeAngles>({ pitch: 0, yaw: 0, roll: 0 })
  const euler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'))
  const turn = useRef(new THREE.Quaternion())

  useFrame(({ camera, clock }, delta) => {
    if (!('isPerspectiveCamera' in camera)) return
    const dt = Math.min(delta, MAX_DT)
    const target = shakeTarget(shipTelemetry.air.dynamicPressure, shipTelemetry.boost, shipTelemetry.boosted)
    intensity.current = prefersReducedMotion() ? 0 : easeShake(intensity.current, target, dt)
    if (intensity.current === 0) return
    const { pitch, yaw, roll } = shakeAngles(clock.elapsedTime, intensity.current, angles.current)
    clean.current.copy(camera.quaternion)
    turn.current.setFromEuler(euler.current.set(pitch, yaw, roll, 'YXZ'))
    camera.quaternion.multiply(turn.current)
    applied.current = true
  }, SHIP_SHAKE_PRIORITY)

  useFrame(({ camera }) => {
    if (!applied.current) return
    camera.quaternion.copy(clean.current)
    camera.updateMatrixWorld()
    applied.current = false
  }, SHIP_SHAKE_RESTORE_PRIORITY)

  useEffect(
    () => () => {
      if (!applied.current) return
      const { camera } = get()
      camera.quaternion.copy(clean.current)
      camera.updateMatrixWorld()
      applied.current = false
    },
    [get]
  )
}

/** useShipShake as a component, for the ship View's scene. */
export function ShipShake(): null {
  useShipShake()
  return null
}
