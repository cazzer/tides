import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { SUN_CLICK_MARGIN, sunRaycast } from './sun-pick'

const RADIUS = 10
const sun = new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 8, 8))
sun.position.set(5, -3, 0)
sun.updateMatrixWorld()

// A ray straight down the z axis through (x, y), from in front of the Sun.
function click(x: number, y: number) {
  const raycaster = new THREE.Raycaster(new THREE.Vector3(x, y, 100), new THREE.Vector3(0, 0, -1))
  const hits: THREE.Intersection[] = []
  sunRaycast.call(sun, raycaster, hits)
  return hits
}

describe('sunRaycast (tides-9us)', () => {
  it('hits the disc, at its near side', () => {
    const [hit] = click(5, -3)
    expect(hit.object).toBe(sun)
    expect(hit.distance).toBeCloseTo(100 - RADIUS - SUN_CLICK_MARGIN, 9)
  })

  it('hits within the margin outside the limb, and misses past it', () => {
    expect(click(5 + RADIUS + SUN_CLICK_MARGIN - 0.1, -3)).toHaveLength(1)
    expect(click(5, -3 - RADIUS - 2)).toHaveLength(1)
    expect(click(5 + RADIUS + SUN_CLICK_MARGIN + 0.1, -3)).toHaveLength(0)
  })

  it('scales with the mesh', () => {
    const group = new THREE.Group()
    group.scale.setScalar(2)
    group.add(sun)
    group.updateMatrixWorld()
    expect(click(10 + 2 * (RADIUS + SUN_CLICK_MARGIN) - 0.1, -6)).toHaveLength(1)
    group.remove(sun)
    sun.updateMatrixWorld()
  })
})
