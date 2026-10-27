import { useEffect, useRef, type RefObject } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { MAX_DT } from './flight'
import { shipTelemetry } from './ship-telemetry'
import { SHIP_SHAKE_PRIORITY, SHIP_SHAKE_RESTORE_PRIORITY } from './ship-session'
import { easeShake, shakeAngles, shakeRadiansPerPx, shakeTarget, type ShakeAngles } from './shake'
import { prefersReducedMotion } from './reduced-motion'

/**
 * Shakes the ship view in Earth's air (tides-xxg, shake.ts): with the
 * dynamic pressure, more while the boost raises the cap, eased in and out.
 * Off under prefers-reduced-motion. Touches only the camera's quaternion,
 * and only from SHIP_SHAKE_PRIORITY (after ShipController's settle, just
 * before drei's View renders) to SHIP_SHAKE_RESTORE_PRIORITY (just after
 * it), which puts the clean pose back: every useFrame, the targeting, the
 * pointer and the HUD read the ship's own pose; only the render (and its
 * onBeforeRender hooks) sees the shake. Never the position, fov, near or
 * far. The surface tiles cull against the clean pose (SURFACE_FRAME_PRIORITY),
 * a few px off the drawn one at most, boosted low in thick air.
 */
export function useShipShake(): void {
  const intensity = useRef(0)
  // The camera turned this frame, until it is put back.
  const shaken = useRef<THREE.Camera | null>(null)
  const clean = useRef(new THREE.Quaternion())
  const angles = useRef<ShakeAngles>({ pitch: 0, yaw: 0, roll: 0 })
  const euler = useRef(new THREE.Euler(0, 0, 0, 'YXZ'))
  const turn = useRef(new THREE.Quaternion())

  useFrame(({ camera, clock, size }, delta) => {
    if (!('isPerspectiveCamera' in camera)) return
    const dt = Math.min(delta, MAX_DT)
    const reduced = prefersReducedMotion()
    const target = shakeTarget(shipTelemetry.air.dynamicPressure, shipTelemetry.boost, shipTelemetry.boosted, reduced)
    // Reduced motion cuts it at once rather than easing it out.
    intensity.current = reduced ? 0 : easeShake(intensity.current, target, dt)
    if (intensity.current === 0) return
    const radiansPerPx = shakeRadiansPerPx(camera.fov, size.height)
    const { pitch, yaw, roll } = shakeAngles(clock.elapsedTime, intensity.current, radiansPerPx, angles.current)
    clean.current.copy(camera.quaternion)
    turn.current.setFromEuler(euler.current.set(pitch, yaw, roll, 'YXZ'))
    camera.quaternion.multiply(turn.current)
    shaken.current = camera
  }, SHIP_SHAKE_PRIORITY)

  useFrame(() => restore(shaken, clean.current), SHIP_SHAKE_RESTORE_PRIORITY)

  // On unmount the store's camera may already be another (drei's makeDefault
  // cleanup), so put back the one that was turned.
  useEffect(() => () => restore(shaken, clean.current), [])
}

/** Puts the turned camera, if any, back to its clean quaternion. */
function restore(shaken: RefObject<THREE.Camera | null>, clean: THREE.Quaternion): void {
  const camera = shaken.current
  if (!camera) return
  camera.quaternion.copy(clean)
  camera.updateMatrixWorld()
  shaken.current = null
}

/** useShipShake as a component, for the ship View's scene. */
export function ShipShake(): null {
  useShipShake()
  return null
}
