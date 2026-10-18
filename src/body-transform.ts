import type * as THREE from 'three'
import type { Vec3 } from './ephemeris'

export interface BodyMotion {
  axialTilt?: number // degrees
  spinAt?: (t: number) => number
  // Full orientation; replaces axialTilt and spinAt when given.
  orientationAt?: (t: number) => THREE.Quaternion
  positionAt?: (t: number) => Vec3
}

// Tilt about X, then spin about the tilted Y axis (Euler XYZ).
export function applyBodyTransform(
  object: THREE.Object3D,
  { axialTilt = 0, spinAt, orientationAt, positionAt }: BodyMotion,
  t: number
) {
  if (orientationAt) {
    object.quaternion.copy(orientationAt(t))
  } else {
    object.rotation.x = (axialTilt * Math.PI) / 180
    if (spinAt) object.rotation.y = spinAt(t)
  }
  if (positionAt) object.position.set(...positionAt(t))
}
