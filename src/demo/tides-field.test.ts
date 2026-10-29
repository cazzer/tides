import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { findDemo } from './demos'
import { ARROW_POINTS, arrowLength, ringArrows, ringFrame, ringPoint, shellVertices } from './tides-field'
import { sceneTideDirections, tidePulls } from './tides'

const DEG = Math.PI / 180
const R = 2.95
const demo = findDemo('tides')!
const step1 = Date.parse(demo.steps[0].date)
const neap = Date.parse(demo.steps[3].date)

describe('the tide shell', () => {
  it('stands highest toward the Moon at the first step', () => {
    const moon = new THREE.Vector3()
    const sun = new THREE.Vector3()
    sceneTideDirections(step1, moon, sun)
    const sphere = new THREE.SphereGeometry(1, 128, 64)
    const directions = Float32Array.from(sphere.getAttribute('position').array as Float32Array)
    const positions = new Float32Array(directions.length)
    const colors = new Float32Array((directions.length / 3) * 4)
    shellVertices(directions, moon, sun, tidePulls(step1), R, positions, colors)
    let best = 0
    let top = -Infinity
    for (let i = 0; i < positions.length; i += 3) {
      const r = Math.hypot(positions[i], positions[i + 1], positions[i + 2])
      if (r > top) {
        top = r
        best = i
      }
    }
    const highest = new THREE.Vector3(positions[best], positions[best + 1], positions[best + 2]).normalize()
    // Toward the Moon or straight away from it: the bulges are alike.
    expect(Math.acos(Math.abs(highest.dot(moon))) / DEG).toBeLessThan(2)
    // ~8% of R above the ground at spring tide, ×1,000,000.
    expect(top / R - 1).toBeGreaterThan(0.06)
    expect(top / R - 1).toBeLessThan(0.1)
    // Shown there, faded to nothing where it meets the ground.
    expect(colors[(best / 3) * 4 + 3]).toBe(1)
    expect(Math.min(...colors.filter((_, k) => k % 4 === 3))).toBe(0)
  })
})

describe('the arrows', () => {
  it.each([step1, neap])('draw the Sun’s at k_s/k_m of the Moon’s under the Moon at %i', (t) => {
    const moon = new THREE.Vector3()
    const sun = new THREE.Vector3()
    const normal = new THREE.Vector3()
    const side = new THREE.Vector3()
    sceneTideDirections(t, moon, sun)
    ringFrame(t, moon, normal, side)
    const pulls = tidePulls(t)
    const p = ringPoint(0, moon, side, new THREE.Vector3())
    expect(p.distanceTo(moon)).toBeLessThan(1e-9)
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const sum = new THREE.Vector3()
    ringArrows(p, moon, sun, pulls, a, b, sum)
    const ratio = arrowLength(b, R) / arrowLength(a, R)
    if (t === step1) {
      // Lined up at New Moon: the Sun's arrow is ~46% of the Moon's.
      expect(Math.abs(ratio / (pulls.sun / pulls.moon) - 1)).toBeLessThan(0.01)
      expect(Math.abs(ratio - 0.47)).toBeLessThan(0.02)
    } else {
      // Square at first quarter: the Sun presses in at half its strength.
      expect(Math.abs(ratio / (pulls.sun / pulls.moon) - 0.5)).toBeLessThan(0.02)
      expect(b.dot(moon)).toBeLessThan(0)
    }
  })

  it('lie in the Moon’s orbit plane, round the ring', () => {
    const moon = new THREE.Vector3()
    const sun = new THREE.Vector3()
    const normal = new THREE.Vector3()
    const side = new THREE.Vector3()
    sceneTideDirections(step1, moon, sun)
    ringFrame(step1, moon, normal, side)
    const p = new THREE.Vector3()
    for (let j = 0; j < ARROW_POINTS; j++) {
      ringPoint(j, moon, side, p)
      expect(Math.abs(p.length() - 1)).toBeLessThan(1e-9)
      expect(Math.abs(p.dot(normal))).toBeLessThan(1e-9)
    }
  })
})
