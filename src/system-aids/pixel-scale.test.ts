import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { orthoUnitsPerPixel, worldUnitsPerPixel } from './pixel-scale'

describe('orthoUnitsPerPixel', () => {
  it('is the frustum height over the zoomed pixel height', () => {
    expect(orthoUnitsPerPixel(422, -422, 10, 844)).toBeCloseTo(0.1)
    expect(orthoUnitsPerPixel(422, -422, 1, 844)).toBeCloseTo(1)
    expect(orthoUnitsPerPixel(5, -5, 2, 100)).toBeCloseTo(0.05)
  })
})

describe('worldUnitsPerPixel', () => {
  it("reads the ortho main view's zoom, the same at every point", () => {
    // drei's OrthographicCamera spans the canvas in pixels: top − bottom = height.
    const camera = new THREE.OrthographicCamera(-200, 200, 422, -422, 0, 1000)
    camera.zoom = 10
    camera.updateMatrixWorld()
    expect(worldUnitsPerPixel(camera, new THREE.Vector3(0, 0, 0), 844)).toBeCloseTo(0.1)
    expect(worldUnitsPerPixel(camera, new THREE.Vector3(300, 0, -50), 844)).toBeCloseTo(0.1)
  })

  it('grows with depth in front of a perspective eye', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1e5)
    camera.position.set(10, 0, 0)
    camera.lookAt(10, 0, -1)
    camera.updateMatrixWorld()
    const near = worldUnitsPerPixel(camera, new THREE.Vector3(10, 0, -100), 800)
    const far = worldUnitsPerPixel(camera, new THREE.Vector3(10, 0, -1000), 800)
    expect(near).toBeCloseTo((2 * 100 * Math.tan(Math.PI / 6)) / 800)
    expect(far / near).toBeCloseTo(10)
    // Off to the side counts only its depth.
    expect(worldUnitsPerPixel(camera, new THREE.Vector3(60, 0, -100), 800)).toBeCloseTo(near)
  })

  it('never reads a point behind the eye as larger than at the near plane', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1e5)
    camera.updateMatrixWorld()
    const behind = worldUnitsPerPixel(camera, new THREE.Vector3(0, 0, 50), 800)
    expect(behind).toBeCloseTo((2 * 0.1 * Math.tan(Math.PI / 6)) / 800)
  })
})
