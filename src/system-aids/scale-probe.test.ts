import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { MAIN_DISTANCE, MAIN_FOV, targetUnitsPerPixel } from '../main-view'
import { measureScale, resetScaleProbe, scaleProbe } from './scale-probe'

function eyeAt(distance: number, target: THREE.Vector3) {
  const camera = new THREE.PerspectiveCamera(MAIN_FOV, 1, 0.1, 1e5)
  camera.position.copy(target).add(new THREE.Vector3(0, 0, distance))
  camera.lookAt(target)
  camera.updateMatrixWorld()
  return camera
}

describe('measureScale', () => {
  const target = new THREE.Vector3(30, 5, -20)

  it('reads the scale at the controls target, as the main view frames it', () => {
    measureScale(eyeAt(MAIN_DISTANCE, target), target, 844)
    expect(scaleProbe.unitsPerPixel).toBeCloseTo(targetUnitsPerPixel(MAIN_DISTANCE, 844))
  })

  it('grows as the eye backs away', () => {
    measureScale(eyeAt(MAIN_DISTANCE, target), target, 844)
    const near = scaleProbe.unitsPerPixel!
    measureScale(eyeAt(5 * MAIN_DISTANCE, target), target, 844)
    expect(scaleProbe.unitsPerPixel! / near).toBeCloseTo(5)
  })

  it('is unmeasured without controls or a view', () => {
    measureScale(eyeAt(MAIN_DISTANCE, target), undefined, 844)
    expect(scaleProbe.unitsPerPixel).toBeNull()
    measureScale(eyeAt(MAIN_DISTANCE, target), target, 0)
    expect(scaleProbe.unitsPerPixel).toBeNull()
    measureScale(eyeAt(MAIN_DISTANCE, target), target, 844)
    resetScaleProbe()
    expect(scaleProbe.unitsPerPixel).toBeNull()
  })
})
