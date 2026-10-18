import type * as THREE from 'three'
import type { Vec3 } from './ephemeris'

export interface BodyMotion {
  axialTilt?: number // degrees
  spinAt?: (t: number) => number
  positionAt?: (t: number) => Vec3
}

// Tilt about X, then spin about the tilted Y axis (Euler XYZ).
export function applyBodyTransform(
  object: THREE.Object3D,
  { axialTilt = 0, spinAt, positionAt }: BodyMotion,
  t: number
) {
  object.rotation.x = (axialTilt * Math.PI) / 180
  if (spinAt) object.rotation.y = spinAt(t)
  if (positionAt) object.position.set(...positionAt(t))
}
