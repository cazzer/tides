import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  MAX_RING_BANDS,
  ringBandUniforms,
  ringGeometry,
  sunDirectionInFrame,
} from './planetFrame'

describe('sunDirectionInFrame', () => {
  it('points from the body to the origin, in the body frame', () => {
    const parent = new THREE.Group()
    parent.position.set(100, 0, 0)
    const body = new THREE.Mesh()
    // A quarter turn about +Y takes local −Z to world −X, toward the origin.
    body.rotation.y = Math.PI / 2
    parent.add(body)
    parent.updateMatrixWorld()

    const sun = sunDirectionInFrame(body, new THREE.Vector3())
    expect(sun.distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-12)
  })

  it('ignores the body scale', () => {
    const body = new THREE.Mesh()
    body.position.set(0, 0, -30)
    body.scale.setScalar(4)
    body.updateMatrixWorld()
    const sun = sunDirectionInFrame(body, new THREE.Vector3())
    expect(sun.toArray().map((v) => +v.toFixed(12))).toEqual([0, 0, 1])
  })
})

describe('ringGeometry', () => {
  const geometry = ringGeometry(2, 5)
  const position = geometry.attributes.position
  const uv = geometry.attributes.uv

  it('lies in the equatorial XZ plane, front face toward +Y', () => {
    const normal = geometry.attributes.normal
    for (let i = 0; i < position.count; i++) {
      expect(position.getY(i)).toBeCloseTo(0, 12)
      expect(normal.getY(i)).toBeCloseTo(1, 12)
    }
    // The first triangle winds counter-clockwise seen from +Y.
    const index = geometry.index!
    const [a, b, c] = [0, 1, 2].map((k) =>
      new THREE.Vector3().fromBufferAttribute(position, index.getX(k))
    )
    const facing = b.clone().sub(a).cross(c.clone().sub(a))
    expect(facing.y).toBeGreaterThan(0)
  })

  it('maps u from the inner edge (0) to the outer edge (1)', () => {
    for (let i = 0; i < position.count; i++) {
      const r = Math.hypot(position.getX(i), position.getZ(i))
      const u = uv.getX(i)
      expect(u).toBeCloseTo((r - 2) / 3, 6)
      // One radial segment: every vertex is on an edge.
      expect(Math.min(u, 1 - u)).toBeCloseTo(0, 6)
    }
  })
})

describe('ringBandUniforms', () => {
  const out = Array.from({ length: MAX_RING_BANDS }, () => new THREE.Vector3(9, 9, 9))

  it('maps bands in planet radii to (centre, half-width, opacity) in u', () => {
    const count = ringBandUniforms(
      [
        { inner: 2, outer: 3, opacity: 0.5 },
        { inner: 4.5, outer: 5, opacity: 1 },
      ],
      2,
      5,
      out
    )
    expect(count).toBe(2)
    expect(out[0].x).toBeCloseTo(1 / 6)
    expect(out[0].y).toBeCloseTo(1 / 6)
    expect(out[0].z).toBe(0.5)
    expect(out[1].x).toBeCloseTo(4.75 / 3 - 2 / 3)
    expect(out[1].y).toBeCloseTo(0.25 / 3)
    expect(out[1].z).toBe(1)
  })

  it('zeroes the unused slots', () => {
    ringBandUniforms([{ inner: 2, outer: 5, opacity: 1 }], 2, 5, out)
    expect(out[0].toArray()).toEqual([0.5, 0.5, 1])
    for (let i = 1; i < MAX_RING_BANDS; i++) {
      expect(out[i].toArray()).toEqual([0, 0, 0])
    }
  })

  it('refuses more bands than the shaders hold', () => {
    const bands = Array.from({ length: MAX_RING_BANDS + 1 }, () => ({
      inner: 2,
      outer: 3,
      opacity: 1,
    }))
    expect(() => ringBandUniforms(bands, 2, 5, out)).toThrow()
  })
})
