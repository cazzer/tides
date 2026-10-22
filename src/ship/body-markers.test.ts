import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { PLANETS } from '../planets'
import { FLIGHT_UNITS_PER_AU } from '../flight-scale'
import { createScreenBody, projectBody, type ScreenBody } from './ship-targeting'
import {
  MARKER_FADE_PX,
  createMarkerPlacement,
  isMarked,
  isOccluded,
  markerOpacity,
  placeMarker,
} from './body-markers'

const WIDTH = 390
const HEIGHT = 844

function screenBody(key: string, x: number, y: number, radiusPx: number, distance: number): ScreenBody {
  return { ...createScreenBody(), key, x, y, radiusPx, distance, inFront: true }
}

describe('isMarked', () => {
  test('planets and Earth always, the Sun never, a moon only as the target', () => {
    expect(isMarked('earth', null)).toBe(true)
    expect(isMarked('jupiter', null)).toBe(true)
    expect(isMarked('sun', null)).toBe(false)
    expect(isMarked('sun', 'sun')).toBe(false)
    expect(isMarked('io', null)).toBe(false)
    expect(isMarked('io', 'jupiter')).toBe(false)
    expect(isMarked('io', 'io')).toBe(true)
    expect(isMarked('moon', null)).toBe(false)
    expect(isMarked('moon', 'moon')).toBe(true)
  })
})

describe('markerOpacity', () => {
  test('full for a sub-pixel disc, fading out as the disc grows', () => {
    expect(markerOpacity(0)).toBe(1)
    expect(markerOpacity(MARKER_FADE_PX[0])).toBe(1)
    expect(markerOpacity(2.5)).toBeGreaterThan(0)
    expect(markerOpacity(2.5)).toBeLessThan(1)
    expect(markerOpacity(MARKER_FADE_PX[1])).toBe(0)
    expect(markerOpacity(Infinity)).toBe(0)
    expect(markerOpacity(NaN)).toBe(0)
  })

  test("Jupiter from Earth's orbit is a sub-pixel disc with a full dot", () => {
    const camera = new THREE.PerspectiveCamera(60, WIDTH / HEIGHT, 0.1, 1e6)
    camera.updateMatrixWorld()
    const jupiter = {
      key: 'jupiter',
      position: new THREE.Vector3(0, 0, -4.2 * FLIGHT_UNITS_PER_AU),
      radius: PLANETS.jupiter.radius,
    }
    const s = projectBody(jupiter, camera, WIDTH, HEIGHT, createScreenBody())
    expect(s.radiusPx).toBeLessThan(1.5)
    expect(placeMarker(s, [s], WIDTH, HEIGHT, createMarkerPlacement())).toMatchObject({
      visible: true,
      opacity: 1,
    })
  })
})

describe('placement', () => {
  test('hidden behind a nearer disc, not a further one', () => {
    const far = screenBody('mars', 100, 100, 0.2, 5000)
    const near = screenBody('earth', 102, 100, 40, 10)
    expect(isOccluded(far, [far, near])).toBe(true)
    expect(isOccluded(near, [far, near])).toBe(false)
    expect(placeMarker(far, [far, near], WIDTH, HEIGHT, createMarkerPlacement()).visible).toBe(false)
    const beside = screenBody('earth', 200, 100, 40, 10)
    expect(isOccluded(far, [far, beside])).toBe(false)
    // A sub-pixel moon in front of its planet doesn't hide the planet's dot.
    const io = screenBody('io', 100.1, 100, 0.3, 4990)
    expect(isOccluded(far, [far, io])).toBe(false)
  })

  test('hidden off screen and behind the camera', () => {
    const out = createMarkerPlacement()
    expect(placeMarker(screenBody('mars', -5, 100, 0.2, 100), [], WIDTH, HEIGHT, out).visible).toBe(false)
    expect(placeMarker(screenBody('mars', 100, HEIGHT + 5, 0.2, 100), [], WIDTH, HEIGHT, out).visible).toBe(false)
    const behind = { ...screenBody('mars', 100, 100, 0.2, 100), inFront: false }
    expect(placeMarker(behind, [], WIDTH, HEIGHT, out).visible).toBe(false)
    expect(placeMarker(screenBody('mars', 100, 100, 0.2, 100), [], WIDTH, HEIGHT, out)).toMatchObject({
      visible: true,
      x: 100,
      y: 100,
    })
  })
})
