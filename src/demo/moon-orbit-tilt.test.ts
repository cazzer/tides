import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { moonOffset } from '../ephemeris'
import { eclipticCirclePoints, moonOrbitPlane, nodeLinePoints } from './moon-orbit-tilt'

const DEG = Math.PI / 180

/** Ecliptic longitude (deg) of a scene-axes direction (φ = λ + 180°, ephemeris.ts). */
function longitude(v: THREE.Vector3): number {
  return (((Math.atan2(-v.z, v.x) / DEG + 180) % 360) + 360) % 360
}

/** Angle in degrees from the Moon at t to the node line, either end. */
function moonFromNodeLine(t: number): number {
  const moon = new THREE.Vector3(...moonOffset(t)).normalize()
  const angle = moon.angleTo(moonOrbitPlane(t).ascendingNode) / DEG
  return Math.min(angle, 180 - angle)
}

describe('moonOrbitPlane', () => {
  it.each(['2024-04-08T18:17:16Z', '2024-03-10T09:00:00Z', '2025-01-01T00:00:00Z', '2026-08-12T17:46:00Z'])(
    '%s: tilted about 5° to the ecliptic',
    (iso) => {
      const { tiltDeg } = moonOrbitPlane(Date.parse(iso))
      expect(tiltDeg).toBeGreaterThan(4.9)
      expect(tiltDeg).toBeLessThan(5.4)
    }
  )

  it('puts the ascending node where the mean node is', () => {
    const t = Date.parse('2024-04-08T18:17:16Z')
    const T = (t - Date.parse('2000-01-01T12:00:00Z')) / 86_400_000 / 36525
    const mean = (((125.04452 - 1934.136261 * T) % 360) + 360) % 360
    const node = longitude(moonOrbitPlane(t).ascendingNode)
    const diff = Math.abs(((node - mean + 540) % 360) - 180)
    expect(diff).toBeLessThan(2)
  })

  it('has the eclipse’s new moon on the node line and the next one well off it', () => {
    expect(moonFromNodeLine(Date.parse('2024-04-08T18:17:16Z'))).toBeLessThan(5)
    expect(moonFromNodeLine(Date.parse('2024-05-08T03:22:29Z'))).toBeGreaterThan(15)
  })
})

describe('nodeLinePoints', () => {
  it('runs through Earth, both ways past the orbit', () => {
    const plane = moonOrbitPlane(Date.parse('2024-04-08T18:17:16Z'))
    const p = nodeLinePoints(plane)
    const a = new THREE.Vector3(p[0], p[1], p[2])
    const b = new THREE.Vector3(p[3], p[4], p[5])
    expect(a.clone().add(b).length()).toBeLessThan(1e-6)
    expect(a.length()).toBeGreaterThan(plane.radius)
    expect(Math.abs(a.y)).toBeLessThan(1e-6)
  })
})

describe('eclipticCirclePoints', () => {
  it('is a flat circle of the radius asked', () => {
    const points = eclipticCirclePoints(10, 16)
    for (let i = 0; i < 16; i++) {
      expect(points[i * 3 + 1]).toBe(0)
      expect(Math.hypot(points[i * 3], points[i * 3 + 2])).toBeCloseTo(10, 5)
    }
  })
})
