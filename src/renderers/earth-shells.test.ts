import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { clearLimbView, updateLimbView } from '../ship/limb-detail'
import {
  ATMOSPHERE_OUTER,
  eyeNearBody,
  eyeNearEarth,
  insideShell,
  pickShellFaces,
  withinShellReach,
} from './earth-shells'
import { planetAtmosphereMaterial } from './planetMaterials'
import { MARS_HAZE_OUTER, SATURN_HAZE_OUTER } from './planets/haze-shells'

const R = 3

// A camera `r` from Earth's centre, near plane `near`.
function cameraAt(r: number, near = 0.001): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(30, 1.6, near, 100)
  camera.position.set(r, 0, 0)
  camera.updateMatrixWorld()
  return camera
}

// The limb view fed for `camera` over `key` (Earth by default), as
// ShipController or close zoom feeds it.
function feed(camera: THREE.Camera, key = 'earth') {
  const body = { key, position: new THREE.Vector3(), radius: R }
  updateLimbView(key, [body], camera.position, 1600, 30, camera)
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

describe("a planet's haze from inside (tides-ufyr.4)", () => {
  afterEach(() => clearLimbView())
  const outer = R * MARS_HAZE_OUTER

  // A haze shell at the origin (Mars' by default), with its material's
  // outer radius set.
  function haze(shellOuter = outer) {
    const material = planetAtmosphereMaterial({ value: new THREE.Vector3(1, 0, 0) })
    material.uniforms.uOuter.value = shellOuter
    return { mesh: new THREE.Object3D(), material }
  }

  it.each([
    ['mars', MARS_HAZE_OUTER],
    ['saturn', SATURN_HAZE_OUTER],
  ])('draws both faces with no depth test for the camera near %s, under the haze', (key, hazeOuter) => {
    const shellOuter = R * hazeOuter
    const fed = cameraAt(R * 1.02)
    feed(fed, key)
    const { mesh, material } = haze(shellOuter)
    expect(eyeNearBody(fed, key)).toBe(true)
    expect(eyeNearEarth(fed)).toBe(false)
    expect(withinShellReach(mesh, fed, shellOuter, key)).toBe(true)
    expect(insideShell(mesh, fed, shellOuter, key)).toBe(true)
    pickShellFaces(mesh, material, fed, undefined, key)
    expect(material.side).toBe(THREE.DoubleSide)
    expect(material.depthTest).toBe(false)
  })

  it("keeps Earth's shells front-faced while Mars is the limb body", () => {
    const fed = cameraAt(R * 1.02)
    feed(fed, 'mars')
    const { mesh, material } = haze()
    expect(withinShellReach(mesh, fed, outer)).toBe(false)
    expect(insideShell(mesh, fed, outer)).toBe(false)
    pickShellFaces(mesh, material, fed)
    expect(material.side).toBe(THREE.FrontSide)
    expect(material.depthTest).toBe(true)
  })

  it('keeps the Mars haze front-faced near Earth, or for another camera', () => {
    const fed = cameraAt(R * 1.02)
    const other = cameraAt(R * 1.02)
    for (const [key, camera] of [
      ['earth', fed],
      ['mars', other],
    ] as const) {
      clearLimbView()
      feed(fed, key)
      const { mesh, material } = haze()
      pickShellFaces(mesh, material, camera, undefined, 'mars')
      expect(material.side).toBe(THREE.FrontSide)
      expect(material.depthTest).toBe(true)
    }
  })

  it('turns back to front faces with the depth test on far from the shell', () => {
    const fed = cameraAt(R * 1.02)
    feed(fed, 'mars')
    const { mesh, material } = haze()
    pickShellFaces(mesh, material, fed, undefined, 'mars')
    expect(material.side).toBe(THREE.DoubleSide)
    fed.position.set(R * 3, 0, 0)
    fed.updateMatrixWorld()
    pickShellFaces(mesh, material, fed, undefined, 'mars')
    expect(material.side).toBe(THREE.FrontSide)
    expect(material.depthTest).toBe(true)
  })
})
