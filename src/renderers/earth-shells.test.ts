import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { clearLimbView, updateLimbView } from '../ship/limb-detail'
import { ATMOSPHERE_OUTER, eyeNearEarth, insideShell, withinShellReach } from './earth-shells'

const R = 3

// A camera `r` from Earth's centre, near plane `near`.
function cameraAt(r: number, near = 0.001): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(30, 1.6, near, 100)
  camera.position.set(r, 0, 0)
  camera.updateMatrixWorld()
  return camera
}

// The limb view fed for `camera` over Earth, as ShipController or close zoom feeds it.
function feed(camera: THREE.Camera) {
  const earth = { key: 'earth', position: new THREE.Vector3(), radius: R }
  updateLimbView('earth', [earth], camera.position, 1600, 30, camera)
}

describe('the near-Earth camera (tides-tvr.7.3)', () => {
  afterEach(() => clearLimbView())
  const shell = new THREE.Object3D()
  const outer = R * ATMOSPHERE_OUTER

  it('is only the camera the limb view was fed for', () => {
    const fed = cameraAt(R * 1.01)
    const other = cameraAt(R * 1.01)
    expect(eyeNearEarth(fed)).toBe(false)
    feed(fed)
    expect(eyeNearEarth(fed)).toBe(true)
    expect(insideShell(shell, fed, outer)).toBe(true)
    expect(withinShellReach(shell, fed, outer)).toBe(true)
    // An overview panel's camera at the same eye draws front faces alone.
    expect(eyeNearEarth(other)).toBe(false)
    expect(insideShell(shell, other, outer)).toBe(false)
    expect(withinShellReach(shell, other, outer)).toBe(false)
    clearLimbView()
    expect(eyeNearEarth(fed)).toBe(false)
    expect(insideShell(shell, fed, outer)).toBe(false)
  })

  it('is never an orthographic camera, even one fed for', () => {
    const ortho = new THREE.OrthographicCamera()
    ortho.position.set(R * 1.01, 0, 0)
    ortho.updateMatrixWorld()
    feed(ortho)
    expect(eyeNearEarth(ortho)).toBe(false)
    expect(insideShell(shell, ortho, outer)).toBe(false)
    expect(withinShellReach(shell, ortho, outer)).toBe(false)
  })

  it('reaches the shell from just outside it by its near plane, but is not inside', () => {
    const fed = cameraAt(outer + 0.01, 0.02)
    feed(fed)
    expect(insideShell(shell, fed, outer)).toBe(false)
    expect(withinShellReach(shell, fed, outer)).toBe(true)
  })
})
