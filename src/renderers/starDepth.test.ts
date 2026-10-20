import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import starsMeta from '../assets/stars.meta.json'
import { MAIN_ZOOM } from '../main-view'
import { centreStarfieldOn, DEFAULT_RADIUS, orientStarfield, starDirectionsEQJ } from './Starfield'
import {
  FULL_DEPTH_ZOOM,
  SHELL_FAR_RADIUS,
  SHELL_NEAR_RADIUS,
  depthAmount,
  shellDepth,
  shellPositions,
  shellRadius,
} from './starDepth'

const readFloats = (name: string) =>
  new Float32Array(readFileSync(new URL(`../assets/${name}`, import.meta.url)).buffer.slice(0))

const starData = readFloats('stars.bin')
const distances = readFloats('stars.distance.bin')
const directions = starDirectionsEQJ(starData, starsMeta.stride)
const depths = distances.map(shellDepth)

// The catalog star of this magnitude and declination (src/assets/ybsc5).
const starIndex = (vmag: number, dec: number) =>
  [...Array(starsMeta.count).keys()].find(
    (i) =>
      Math.abs(starData[i * starsMeta.stride + 6] - vmag) < 0.005 &&
      Math.abs(directions[i * 3 + 2] - Math.sin((dec * Math.PI) / 180)) < 0.01
  )!

describe('stars.distance.bin', () => {
  it('has one distance per star', () => {
    expect(distances.length).toBe(starsMeta.count)
    expect(distances.every((d) => Number.isFinite(d) && d > 0)).toBe(true)
  })

  it('uses the parallax where the catalog has a usable one', () => {
    expect(distances[starIndex(-1.46, -16.7)]).toBeCloseTo(1 / 0.375, 2) // Sirius
    expect(distances[starIndex(-0.01, -60.8)]).toBeCloseTo(1 / 0.751, 2) // α Cen A
  })

  it('puts luminous stars without one far away', () => {
    expect(distances[starIndex(1.25, 45.3)]).toBeGreaterThan(200) // Deneb, A2Ia
    expect(distances[starIndex(2.02, 89.3)]).toBeGreaterThan(100) // Polaris, F7Ib-II
  })
})

describe('depthAmount', () => {
  it('is off at the default zoom and anywhere closer in', () => {
    expect(depthAmount(MAIN_ZOOM)).toBe(0)
    expect(depthAmount(40)).toBe(0)
  })

  it('fades in steadily to a full shell zoomed out', () => {
    let previous = 0
    for (let zoom = MAIN_ZOOM; zoom >= FULL_DEPTH_ZOOM; zoom -= 0.25) {
      expect(depthAmount(zoom)).toBeGreaterThanOrEqual(previous)
      previous = depthAmount(zoom)
    }
    expect(depthAmount(FULL_DEPTH_ZOOM)).toBe(1)
    expect(depthAmount(0.1)).toBe(1)
  })
})

describe('shellRadius', () => {
  it('is the plain star sphere with no depth', () => {
    expect(shellRadius(0, 0)).toBe(1)
    expect(shellRadius(1, 0)).toBe(1)
  })

  it('orders the stars by distance at full depth', () => {
    expect(shellRadius(shellDepth(1.34), 1)).toBe(SHELL_NEAR_RADIUS)
    expect(shellRadius(shellDepth(10), 1)).toBeLessThan(shellRadius(shellDepth(100), 1))
    expect(shellRadius(shellDepth(5000), 1)).toBe(SHELL_FAR_RADIUS)
  })
})

describe('shellPositions', () => {
  it('leaves the star directions untouched with no depth', () => {
    expect(shellPositions(directions, depths, 0)).toEqual(directions)
  })

  it.each([0.3, 1])('keeps every star in its catalog direction at depth %s', (amount) => {
    const positions = shellPositions(directions, depths, amount)
    const position = new THREE.Vector3()
    const direction = new THREE.Vector3()
    for (let i = 0; i < starsMeta.count; i += 1) {
      position.fromArray(positions, i * 3).normalize()
      direction.fromArray(directions, i * 3)
      expect(position.angleTo(direction)).toBeLessThan(1e-6)
    }
  })

  it('shows every star in its true direction from the camera it is centred on', () => {
    const positions = shellPositions(directions, depths, 1)
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(40, -12, 25)
    camera.updateMatrixWorld()
    const stars = new THREE.Object3D()
    stars.scale.setScalar(DEFAULT_RADIUS)
    const t = Date.parse('2026-10-20T00:00:00Z')
    orientStarfield(stars, t)
    centreStarfieldOn(stars, camera)

    const sphere = new THREE.Vector3()
    const shell = new THREE.Vector3()
    for (let i = 0; i < starsMeta.count; i += 97) {
      sphere.fromArray(directions, i * 3).applyMatrix4(stars.matrixWorld).sub(camera.position)
      shell.fromArray(positions, i * 3).applyMatrix4(stars.matrixWorld).sub(camera.position)
      expect(shell.angleTo(sphere)).toBeLessThan(1e-6)
    }
  })
})
