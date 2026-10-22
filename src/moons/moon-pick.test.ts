import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { MOON_TAP_RADIUS_PX, moonRaycast, type MoonPickData } from './moon-pick'

// An ortho camera sized in CSS px as drei's is (800 × 600), at zoom 10: a
// pixel is 0.1 units.
const ZOOM = 10
const camera = new THREE.OrthographicCamera(-400, 400, 300, -300, 0.1, 1000)
camera.zoom = ZOOM
camera.position.set(0, 0, 100)
camera.updateProjectionMatrix()
camera.updateMatrixWorld()

function moonAt(x: number, y: number, parent: [number, number, number], parentRadius = 2) {
  const mesh = new THREE.Mesh()
  mesh.position.set(x, y, 0)
  mesh.updateMatrixWorld()
  const data: MoonPickData = {
    radius: 0.2,
    parentPosition: new THREE.Vector3(...parent),
    parentRadius,
  }
  mesh.userData = data
  return mesh
}

// Tap the screen over world point (x, y) on the z = 0 plane.
function tap(mesh: THREE.Mesh, x: number, y: number) {
  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(new THREE.Vector2((x * ZOOM) / 400, (y * ZOOM) / 300), camera)
  const hits: THREE.Intersection[] = []
  moonRaycast.call(mesh, raycaster, hits)
  return hits
}

describe('moonRaycast', () => {
  const far: [number, number, number] = [50, 0, 0]

  it(`picks a tiny moon within ${MOON_TAP_RADIUS_PX} px of its centre, not beyond`, () => {
    const moon = moonAt(0, 0, far)
    const px = 1 / ZOOM
    expect(tap(moon, 15 * px, 0)).toHaveLength(1)
    expect(tap(moon, 0, -21 * px)).toHaveLength(1)
    expect(tap(moon, 23 * px, 0)).toHaveLength(0)
    expect(tap(moon, 0, 0)[0].object).toBe(moon)
  })

  it('leaves taps on the parent’s disc to the parent, unless the moon itself is hit', () => {
    // The moon 2.5 units off a radius-2 parent: 0.5 units (5 px) beyond its limb.
    const moon = moonAt(2.5, 0, [0, 0, 0])
    expect(tap(moon, 1.9, 0)).toHaveLength(0)
    expect(tap(moon, 2.4, 0)).toHaveLength(1)
    // Off the disc, the grown radius applies again.
    expect(tap(moon, 3.9, 0)).toHaveLength(1)
  })

  it('uses the real radius under a perspective camera (ship mode)', () => {
    const perspective = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 1000)
    perspective.position.set(0, 0, 100)
    perspective.updateMatrixWorld()
    const moon = moonAt(0, 0, far)
    const raycaster = new THREE.Raycaster()
    raycaster.camera = perspective
    raycaster.ray.set(new THREE.Vector3(1, 0, 100), new THREE.Vector3(0, 0, -1))
    const hits: THREE.Intersection[] = []
    moonRaycast.call(moon, raycaster, hits)
    expect(hits).toHaveLength(0)
  })
})
