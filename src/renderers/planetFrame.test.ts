import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { ringGeometry, sunDirectionLocal } from './planetFrame'

describe('sunDirectionLocal', () => {
  it('points from the body to the origin, in the body frame', () => {
    const parent = new THREE.Group()
    parent.position.set(100, 0, 0)
    const body = new THREE.Mesh()
    // A quarter turn about +Y takes local −Z to world −X, toward the origin.
    body.rotation.y = Math.PI / 2
    parent.add(body)
    parent.updateMatrixWorld()

    const sun = sunDirectionLocal(body, new THREE.Vector3())
    expect(sun.distanceTo(new THREE.Vector3(0, 0, -1))).toBeLessThan(1e-12)
  })

  it('ignores the body scale', () => {
    const body = new THREE.Mesh()
    body.position.set(0, 0, -30)
    body.scale.setScalar(4)
    body.updateMatrixWorld()
    const sun = sunDirectionLocal(body, new THREE.Vector3())
    expect(sun.toArray().map((v) => +v.toFixed(12))).toEqual([0, 0, 1])
  })
})

describe('ringGeometry', () => {
  const geometry = ringGeometry(2, 5)
  const position = geometry.attributes.position
  const uv = geometry.attributes.uv

  it('lies in the equatorial XZ plane', () => {
    for (let i = 0; i < position.count; i++) {
      expect(position.getY(i)).toBeCloseTo(0, 12)
    }
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
