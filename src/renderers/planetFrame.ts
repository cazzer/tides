// Pure geometry for the planet renderers (PlanetRenderer.tsx).
import * as THREE from 'three'

const _position = new THREE.Vector3()
const _quaternion = new THREE.Quaternion()
const _scale = new THREE.Vector3()

/** The unit direction to the Sun (world origin) in `object`'s local frame. */
export function sunDirectionLocal(
  object: THREE.Object3D,
  out: THREE.Vector3
): THREE.Vector3 {
  object.matrixWorld.decompose(_position, _quaternion, _scale)
  return out
    .copy(_position)
    .negate()
    .normalize()
    .applyQuaternion(_quaternion.invert())
}

/** A flat annulus in the XZ plane with u running inner → outer edge. */
export function ringGeometry(inner: number, outer: number): THREE.BufferGeometry {
  const geometry = new THREE.RingGeometry(inner, outer, 256, 1)
  geometry.rotateX(-Math.PI / 2)
  const position = geometry.attributes.position
  const uv = geometry.attributes.uv
  for (let i = 0; i < position.count; i++) {
    const r = Math.hypot(position.getX(i), position.getZ(i))
    uv.setXY(i, (r - inner) / (outer - inner), 0.5)
  }
  return geometry
}
