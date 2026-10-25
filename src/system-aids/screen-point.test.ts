import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { MAIN_DISTANCE, MAIN_FOV, targetUnitsPerPixel } from '../main-view'
import { screenPointInto, type ScreenPoint } from './screen-point'

const W = 1200
const H = 800

// The main view: MAIN_FOV, looking at the origin from MAIN_DISTANCE, tilted.
function mainCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(MAIN_FOV, W / H, 0.1, 4000)
  camera.position.set(100, 80, 80).setLength(MAIN_DISTANCE)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  return camera
}

const at = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const point = (): ScreenPoint => ({ x: 0, y: 0, depth: 0, upp: 0 })

describe('screenPointInto', () => {
  it('puts the target at the centre, MAIN_DISTANCE deep', () => {
    const p = screenPointInto(mainCamera(), at(0, 0, 0), W, H, point())
    expect(p.x).toBeCloseTo(0)
    expect(p.y).toBeCloseTo(0)
    expect(p.depth).toBeCloseTo(MAIN_DISTANCE)
    expect(p.upp).toBeCloseTo(targetUnitsPerPixel(MAIN_DISTANCE, H))
  })

  it('moves a point one px per upp along the camera’s right and up at its depth', () => {
    const camera = mainCamera()
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
    const forward = camera.getWorldDirection(new THREE.Vector3())
    // Far behind the target and off to one side: a body's name offset there.
    const body = at(0, 0, 0).addScaledVector(forward, 300).addScaledVector(right, 40)
    const p = screenPointInto(camera, body, W, H, point())
    const shifted = body.clone().addScaledVector(right, 30 * p.upp).addScaledVector(up, -12 * p.upp)
    const q = screenPointInto(camera, shifted, W, H, point())
    expect(q.x - p.x).toBeCloseTo(30)
    expect(q.y - p.y).toBeCloseTo(-12)
    expect(q.depth).toBeCloseTo(p.depth)
  })

  it('spans the view’s edges at the frustum’s', () => {
    const camera = mainCamera()
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
    const { upp } = screenPointInto(camera, at(0, 0, 0), W, H, point())
    const corner = at(0, 0, 0).addScaledVector(right, (W / 2) * upp).addScaledVector(up, (H / 2) * upp)
    const p = screenPointInto(camera, corner, W, H, point())
    expect(p.x).toBeCloseTo(W / 2)
    expect(p.y).toBeCloseTo(H / 2)
  })

  it('reads a nearer point at a smaller upp', () => {
    const camera = mainCamera()
    const near = screenPointInto(camera, camera.position.clone().multiplyScalar(0.5), W, H, point())
    expect(near.depth).toBeCloseTo(MAIN_DISTANCE / 2)
    expect(near.upp).toBeCloseTo(targetUnitsPerPixel(MAIN_DISTANCE / 2, H))
  })

  it('gives a point behind the eye a negative depth', () => {
    const camera = mainCamera()
    const behind = camera.position.clone().multiplyScalar(1.5)
    expect(screenPointInto(camera, behind, W, H, point()).depth).toBeCloseTo(-MAIN_DISTANCE / 2)
  })
})
