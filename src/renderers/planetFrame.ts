// Pure geometry for the planet renderers (PlanetRenderer.tsx).
import * as THREE from 'three'

const _position = new THREE.Vector3()
const _quaternion = new THREE.Quaternion()
const _scale = new THREE.Vector3()

/** The unit direction to the Sun (world origin) in `object`'s local frame. */
export function sunDirectionInFrame(
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

/**
 * A flat annulus in the XZ plane, front face toward +Y, with u running from
 * the inner edge (0) to the outer (1).
 */
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

/** One ring or ringlet, radii in planet radii, opacity 0–1. */
export interface RingBand {
  inner: number
  outer: number
  opacity: number
}

/** The shaders' fixed uniform array size (shaders/ring/profile.glsl). */
export const MAX_RING_BANDS = 16

/**
 * Bands as the shaders take them: (centre, half-width, opacity) in u, the
 * ring's 0 (inner edge) to 1 (outer edge) coordinate, zero-padded to
 * MAX_RING_BANDS. Writes into `out` and returns the band count.
 */
export function ringBandUniforms(
  bands: readonly RingBand[],
  inner: number,
  outer: number,
  out: readonly THREE.Vector3[]
): number {
  if (bands.length > MAX_RING_BANDS) {
    throw new Error(`At most ${MAX_RING_BANDS} ring bands, got ${bands.length}`)
  }
  const span = outer - inner
  for (let i = 0; i < MAX_RING_BANDS; i++) {
    const band = bands[i]
    if (band) {
      out[i].set(
        ((band.inner + band.outer) / 2 - inner) / span,
        (band.outer - band.inner) / 2 / span,
        band.opacity
      )
    } else {
      out[i].set(0, 0, 0)
    }
  }
  return bands.length
}
