import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { earthPosition, moonOffset } from '../ephemeris'
import { positionsFor } from '../flight-scale'
import { MAIN_FOV } from '../main-view'
import { eyeDirection, poseDistance } from './demo-script'
import { solarEclipse } from './demos/solar-eclipse'
import {
  createShadowAxis,
  eclipticCirclePoints,
  moonOrbitPlane,
  shadowAxis,
  shadowAxisOpacity,
} from './moon-orbit-tilt'

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

describe('eclipticCirclePoints', () => {
  it('is a flat circle of the radius asked', () => {
    const points = eclipticCirclePoints(10, 16)
    for (let i = 0; i < 16; i++) {
      expect(points[i * 3 + 1]).toBe(0)
      expect(Math.hypot(points[i * 3], points[i * 3 + 2])).toBeCloseTo(10, 5)
    }
  })
})

describe('shadowAxis', () => {
  it('hits Earth at the eclipse', () => {
    const axis = shadowAxis(Date.parse('2024-04-08T18:17:00Z'))
    expect(axis.missR).toBeLessThan(1)
    expect(axis.sunward).toBe(true)
    expect(shadowAxisOpacity(axis)).toBe(1)
  })

  it('passes 2.82 Earth radii north of Earth at the next new moon, a month on', () => {
    const axis = shadowAxis(Date.parse('2024-05-08T03:22:00Z'))
    expect(Math.abs(axis.missR - 2.82)).toBeLessThan(0.05)
    expect(axis.sunward).toBe(true)
    // At Earth's drawn scale, above it.
    const earthR = positionsFor('system').radius.earth
    expect(axis.closest.length() / earthR).toBeCloseTo(axis.missR, 6)
    expect(axis.closest.y).toBeGreaterThan(2.7 * earthR)
    expect(shadowAxisOpacity(axis)).toBe(1)
  })

  it('fills the axis it is given', () => {
    const out = createShadowAxis()
    expect(shadowAxis(Date.parse('2024-05-08T03:22:00Z'), out)).toBe(out)
  })

  it('runs away from the Sun, square to its nearest point', () => {
    const t = Date.parse('2024-05-08T03:22:00Z')
    const axis = shadowAxis(t)
    const fromSun = new THREE.Vector3(...earthPosition(t)).setY(0).normalize()
    expect(axis.direction.angleTo(fromSun) / DEG).toBeLessThan(1)
    expect(Math.abs(axis.direction.dot(axis.closest))).toBeLessThan(1e-6)
  })

  it('is behind Earth, and hidden, at the full moon', () => {
    const axis = shadowAxis(Date.parse('2024-04-23T23:49:00Z'))
    expect(axis.sunward).toBe(false)
    expect(shadowAxisOpacity(axis)).toBe(0)
  })

  it('fades out between 8 and 10 Earth radii', () => {
    const at = (missR: number) =>
      shadowAxisOpacity({ ...createShadowAxis(), missR, sunward: true })
    expect(at(8)).toBe(1)
    expect(at(9)).toBeCloseTo(0.5)
    expect(at(10)).toBe(0)
  })
})

describe('the solar eclipse tour’s last step', () => {
  const step = solarEclipse.steps.find((s) => s.aids?.moonNodes)!
  const pose = step.camera!

  it('has the Moon on a phone at the 8 May stop, with the pose set at the step’s start', () => {
    // DemoPlayer sets the pose against the Sun at the step's start; the eye
    // then keeps that direction while the Sun turns.
    const start = new THREE.Vector3(...earthPosition(Date.parse(step.date)))
    const eye = eyeDirection(start, new THREE.Vector3(), start, pose.azimuth, pose.elevation)
    const t = Date.parse(step.until!)
    const moon = new THREE.Vector3(...moonOffset(t))
    const toMoon = moon.clone().sub(eye.clone().multiplyScalar(poseDistance(pose, MAIN_FOV, 390 / 844)))
    const offAxis = toMoon.angleTo(eye.clone().negate()) / DEG
    const moonDisc = Math.asin(positionsFor('system').radius.moon / toMoon.length()) / DEG
    const phoneHalfFov = Math.atan(Math.tan((MAIN_FOV / 2) * DEG) * (390 / 844)) / DEG
    expect(offAxis + moonDisc).toBeLessThan(phoneHalfFov)
  })
})
