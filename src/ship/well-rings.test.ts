import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { K_WELL, V_TOP, WELL_EDGE_SPEED, bandEdgeGap, wellEdgeGap, wellFactor, wellSpeedOf } from './flight'
import { BODY_MASS_KG } from './ship-bodies'
import { MOONS } from '../moons/moons'
import {
  RING_FADE_PX,
  gapForSpeed,
  placeRing,
  ringParent,
  ringRadiusPx,
  ringStrength,
  showsOuter,
  wellRings,
  type RingBody,
  type Rings,
} from './well-rings'

const rings = (): Rings => ({ inner: NaN, outer: NaN })
const T = (mass: number) => wellFactor(mass) / K_WELL

function at(key: string, mass: number, radius: number, x = 0, y = 0, z = 0): RingBody {
  return { key, mass, radius, position: new THREE.Vector3(x, y, z) }
}

describe('gapForSpeed', () => {
  test("is wellSpeedOf's inverse, in the well and the band, and V_TOP's at the band's edge", () => {
    for (const mass of [BODY_MASS_KG.moon, BODY_MASS_KG.earth, BODY_MASS_KG.jupiter, BODY_MASS_KG.sun]) {
      for (const speed of [0.5, WELL_EDGE_SPEED, 10, 80, V_TOP]) {
        expect(wellSpeedOf(gapForSpeed(speed, T(mass)), T(mass))).toBeCloseTo(speed, 9)
      }
      expect(gapForSpeed(V_TOP, T(mass))).toBeCloseTo(bandEdgeGap(T(mass)), 9)
      expect(gapForSpeed(1e6, T(mass))).toBeCloseTo(bandEdgeGap(T(mass)), 9)
    }
    expect(gapForSpeed(NaN, 2)).toBeNaN()
  })
})

describe('wellRings', () => {
  test("a planet far from the Sun: inner at its well's edge, outer at its band's", () => {
    const sun = at('sun', BODY_MASS_KG.sun, 114)
    const jupiter = at('jupiter', BODY_MASS_KG.jupiter, 20, 5200)
    const r = wellRings(jupiter, sun, rings())
    expect(r.inner).toBeCloseTo(20 + wellEdgeGap(T(BODY_MASS_KG.jupiter)), 9)
    expect(r.outer).toBeCloseTo(20 + bandEdgeGap(T(BODY_MASS_KG.jupiter)), 9)
    // 40.8 and ~336 at truescale 0.7's radius.
    expect(r.inner).toBeCloseTo(40.8, 0)
  })

  test("a planet in the Sun's band: its outer ring stops where the Sun's cap is the slower", () => {
    const sun = at('sun', BODY_MASS_KG.sun, 114)
    const mercury = at('mercury', BODY_MASS_KG.mercury, 1.2, 330)
    const r = wellRings(mercury, sun, rings())
    const sunCap = wellSpeedOf(330 - 114, T(BODY_MASS_KG.sun))
    expect(sunCap).toBeLessThan(V_TOP)
    expect(r.outer).toBeCloseTo(1.2 + gapForSpeed(sunCap, T(BODY_MASS_KG.mercury)), 9)
    expect(r.outer).toBeLessThan(1.2 + bandEdgeGap(T(BODY_MASS_KG.mercury)))
    // There Mercury's cap is the Sun's at Mercury.
    expect(wellSpeedOf(r.outer - 1.2, T(BODY_MASS_KG.mercury))).toBeCloseTo(sunCap, 9)
  })

  test("a moon has one ring, where its well takes over from its planet's, if it clears the moon", () => {
    const jupiter = at('jupiter', BODY_MASS_KG.jupiter, 20)
    const callisto = at('callisto', MOONS.callisto.massKg, 1.2, 57)
    const c = wellRings(callisto, jupiter, rings())
    const jupiterCap = wellSpeedOf(57 - 20, T(BODY_MASS_KG.jupiter))
    expect(c.inner).toBeCloseTo(1.2 + gapForSpeed(jupiterCap, T(MOONS.callisto.massKg)), 9)
    expect(c.outer).toBeNaN()
    // Io, deep in Jupiter's well: its own takes over close in.
    const io = wellRings(at('io', MOONS.io.massKg, 0.9, 26.4), jupiter, rings())
    expect(io.inner).toBeLessThan(3 * 0.9)
    // A moon whose ring would hug it draws none.
    expect(wellRings(at('io', MOONS.io.massKg, 0.9, 21), jupiter, rings()).inner).toBeNaN()
    // Earth's Moon, ~10 out in Earth's well.
    const earth = at('earth', BODY_MASS_KG.earth, 2.95)
    const moon = wellRings(at('moon', BODY_MASS_KG.moon, 0.86, 10), earth, rings())
    expect(moon.inner).toBeGreaterThan(2 * 0.86)
    expect(moon.inner).toBeLessThan(10 - 2.95)
  })

  test('the Sun has both rings', () => {
    const r = wellRings(at('sun', BODY_MASS_KG.sun, 114), null, rings())
    expect(r.inner).toBeCloseTo(114 + wellEdgeGap(T(BODY_MASS_KG.sun)), 9)
    expect(r.outer).toBeCloseTo(114 + bandEdgeGap(T(BODY_MASS_KG.sun)), 9)
  })
})

describe('which outer rings show', () => {
  test("the nearest body's and the target's, a moon standing for its planet", () => {
    expect(ringParent('moon')).toBe('earth')
    expect(ringParent('io')).toBe('jupiter')
    expect(ringParent('mars')).toBe('sun')
    expect(ringParent('sun')).toBeNull()
    expect(showsOuter('jupiter', 'jupiter', null)).toBe(true)
    expect(showsOuter('jupiter', 'callisto', null)).toBe(true)
    expect(showsOuter('jupiter', null, 'io')).toBe(true)
    expect(showsOuter('saturn', 'callisto', 'mars')).toBe(false)
    expect(showsOuter('mars', 'callisto', 'mars')).toBe(true)
    expect(showsOuter('earth', 'moon', null)).toBe(true)
    expect(showsOuter('sun', 'earth', null)).toBe(false)
    expect(showsOuter('sun', 'sun', null)).toBe(true)
  })
})

describe('ring strength and placement', () => {
  const fov = THREE.MathUtils.degToRad(60)

  test('fades in by size on screen and is hidden under RING_FADE_PX', () => {
    // A ring of radius 40 from far enough that it is under the threshold.
    const far = 40 / Math.sin(Math.atan((RING_FADE_PX[0] / (800 / 2)) * Math.tan(fov / 2)))
    expect(ringRadiusPx(40, far, fov, 800)).toBeCloseTo(RING_FADE_PX[0], 6)
    expect(ringStrength(40, far * 1.01, fov, 800)).toBe(0)
    expect(ringStrength(40, 400, fov, 800)).toBe(1)
  })

  test('fades out as the ship nears the ring and is gone inside it', () => {
    expect(ringStrength(40, 39, fov, 800)).toBe(0)
    expect(ringStrength(40, 40, fov, 800)).toBe(0)
    const near = ringStrength(40, 42, fov, 800)
    expect(near).toBeGreaterThan(0)
    expect(near).toBeLessThan(1)
    expect(ringStrength(40, 47, fov, 800)).toBe(1)
    expect(ringStrength(NaN, 47, fov, 800)).toBe(0)
  })

  test("places the unit circle on the sphere's outline: every point on it grazes the sphere from the eye", () => {
    const object = new THREE.Object3D()
    const centre = new THREE.Vector3(3, -2, 5)
    const eye = new THREE.Vector3(40, 30, -20)
    placeRing(object, centre, 12, eye)
    object.updateMatrixWorld()
    for (const a of [0, 1, 2.5, 4]) {
      const p = new THREE.Vector3(Math.cos(a), Math.sin(a), 0).applyMatrix4(object.matrixWorld)
      // On the sphere, and the sight line to it is tangent there.
      expect(p.distanceTo(centre)).toBeCloseTo(12, 9)
      expect(p.clone().sub(centre).dot(p.clone().sub(eye))).toBeCloseTo(0, 6)
    }
  })
})
