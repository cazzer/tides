import { EquatorFromVector, GeoMoon, RotateVector, Rotation_EQJ_EQD, SiderealTime } from 'astronomy-engine'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { applyBodyTransform } from '../body-transform'
import { earthPosition, earthSpin, earthTilt } from '../ephemeris'
import { calculateLocationAndRotationForLatLng } from '../utils'
import {
  equilibriumHeight,
  H_MOON_MEAN_M,
  MOON_MEAN_KM,
  sceneTideDirections,
  spotTide,
  SUN_MOON_GM,
  tidalAccel,
  tidePulls,
  TIDES_DEFAULT_SPOT,
  tidesSpot,
} from './tides'

const DEG = Math.PI / 180
const AU_KM = 149_597_870.7
const SPRING = Date.parse('2026-10-10T15:50:36Z')
const NEAP = Date.parse('2026-10-18T16:13:19Z')
const KING = Date.parse('2026-12-24T01:28:45Z')

describe('tide constants', () => {
  it('give the textbook equilibrium tides', () => {
    // The Moon's ~0.36 m and the Sun's ~0.16 m (Cartwright; Pugh & Woodworth).
    expect(Math.abs(H_MOON_MEAN_M - 0.357)).toBeLessThan(0.002)
    const sunAt1Au = SUN_MOON_GM * (MOON_MEAN_KM / AU_KM) ** 3
    expect(Math.abs(sunAt1Au - 0.4592)).toBeLessThan(0.001)
    expect(Math.abs(H_MOON_MEAN_M * sunAt1Au - 0.164)).toBeLessThan(0.002)
  })
})

describe('tidePulls', () => {
  it.each([
    ['spring', SPRING, 0.975, 0.461, 1.434],
    ['neap', NEAP, 0.87, 0.464, 0.405],
    ['king', KING, 1.251, 0.483, 1.731],
  ])('at the %s step', (_, t, moon, sun, range) => {
    const p = tidePulls(t)
    expect(Math.abs(p.moon - moon)).toBeLessThan(0.003)
    expect(Math.abs(p.sun - sun)).toBeLessThan(0.003)
    expect(Math.abs(p.range - range)).toBeLessThan(0.003)
    expect(p.sun / p.moon).toBeGreaterThanOrEqual(0.38)
    expect(p.sun / p.moon).toBeLessThanOrEqual(0.54)
  })

  it('ranks king > spring > neap', () => {
    expect(tidePulls(KING).range).toBeGreaterThan(tidePulls(SPRING).range)
    expect(tidePulls(SPRING).range).toBeGreaterThan(tidePulls(NEAP).range)
  })

  it('quotes the distances the demo’s captions do', () => {
    expect(Math.round(tidePulls(SPRING).moonKm)).toBeCloseTo(387_631, -1)
    expect(Math.round(tidePulls(KING).moonKm)).toBeCloseTo(356_729, -1)
  })
})

describe('tidalAccel', () => {
  const u = new THREE.Vector3(1, 0, 0)
  const out = new THREE.Vector3()

  it('pulls out 2k under the body and in k at 90°', () => {
    tidalAccel(u, u, 0.8, out)
    expect(out.distanceTo(new THREE.Vector3(1.6, 0, 0))).toBeLessThan(1e-12)
    const side = new THREE.Vector3(0, 0, 1)
    tidalAccel(side, u, 0.8, out)
    expect(out.distanceTo(side.clone().multiplyScalar(-0.8))).toBeLessThan(1e-12)
  })

  it('is 1.5k along the surface at 45°', () => {
    const p = new THREE.Vector3(1, 1, 0).normalize()
    tidalAccel(p, u, 0.8, out)
    const radial = out.dot(p)
    const tangential = out.clone().addScaledVector(p, -radial).length()
    expect(tangential).toBeCloseTo(1.2, 10)
    expect(radial).toBeCloseTo(0.4, 10)
  })
})

describe('equilibriumHeight', () => {
  const mean = { moon: 1, sun: 0 }

  it('is H under the mean Moon and −H/2 at 90°', () => {
    expect(equilibriumHeight(1, 0, mean)).toBeCloseTo(H_MOON_MEAN_M, 12)
    expect(equilibriumHeight(0, 0, mean)).toBeCloseTo(-H_MOON_MEAN_M / 2, 12)
  })

  it('averages zero over the globe', () => {
    const n = 4000
    const moon = new THREE.Vector3(0.3, 0.8, -0.2).normalize()
    const sun = new THREE.Vector3(-0.6, 0.1, 0.7).normalize()
    const pulls = { moon: 1.1, sun: 0.47 }
    let sum = 0
    const golden = Math.PI * (3 - Math.sqrt(5))
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n
      const r = Math.sqrt(1 - y * y)
      const p = new THREE.Vector3(r * Math.cos(golden * i), y, r * Math.sin(golden * i))
      sum += equilibriumHeight(p.dot(moon), p.dot(sun), pulls)
    }
    expect(Math.abs(sum / n)).toBeLessThan(1e-4)
  })
})

describe('the default spot through the daily step', () => {
  const STEP = 89_400_000
  const samples = Array.from({ length: STEP / 300_000 + 1 }, (_, k) => spotTide(TIDES_DEFAULT_SPOT.lat, TIDES_DEFAULT_SPOT.lon, SPRING + k * 300_000))

  function extremes(kind: 'low' | 'high') {
    const out: { k: number; h: number }[] = []
    for (let k = 1; k < samples.length - 1; k++) {
      const h = samples[k]
      const is = kind === 'low' ? h < samples[k - 1] && h <= samples[k + 1] : h > samples[k - 1] && h >= samples[k + 1]
      if (is) out.push({ k, h })
    }
    return out
  }

  it('starts at a high of about +49 cm', () => {
    expect(Math.abs(samples[0] - 0.49)).toBeLessThan(0.01)
    expect(Math.max(...samples.slice(0, 12)) - samples[0]).toBeLessThan(0.002)
  })

  it('passes two lows of about −25 cm and a high between', () => {
    const lows = extremes('low')
    expect(lows).toHaveLength(2)
    const hours = lows.map((l) => (l.k * 5) / 60)
    expect(Math.abs(hours[0] - 6.25)).toBeLessThan(0.5)
    expect(Math.abs(hours[1] - 18.4)).toBeLessThan(0.5)
    for (const low of lows) expect(Math.abs(low.h + 0.25)).toBeLessThan(0.015)
    // Back to a high as the lunar day ends; one between the lows.
    const highs = extremes('high').filter((h) => h.k > lows[0].k && h.k < lows[1].k)
    expect(highs).toHaveLength(1)
    expect(Math.abs((highs[0].k * 5) / 60 - 12.35)).toBeLessThan(0.5)
    expect(Math.abs(highs[0].h - 0.475)).toBeLessThan(0.01)
  })

  it('is on the equator under the Moon at the step’s start', () => {
    const date = new Date(SPRING)
    const moon = EquatorFromVector(RotateVector(Rotation_EQJ_EQD(date), GeoMoon(date)))
    const subLunarLon = ((((moon.ra - SiderealTime(date)) * 15) % 360) + 540) % 360 - 180
    expect(TIDES_DEFAULT_SPOT.lat).toBe(0)
    expect(Math.abs(subLunarLon - TIDES_DEFAULT_SPOT.lon)).toBeLessThan(0.5)
  })
})

describe('spotTide against the scene', () => {
  it.each([SPRING, NEAP, KING])('matches the scene’s Moon and Sun under the globe at %i', (t) => {
    // The spot's tide worked in the equator of date equals the one from the
    // scene's directions at the point the globe puts the spot.
    const globe = new THREE.Object3D()
    applyBodyTransform(globe, { tiltAt: earthTilt, spinAt: earthSpin, positionAt: earthPosition }, t)
    globe.updateMatrixWorld(true)
    const moon = new THREE.Vector3()
    const sun = new THREE.Vector3()
    sceneTideDirections(t, moon, sun)
    const pulls = tidePulls(t)
    for (const [lat, lon] of [[0, -62.4], [40.7, -74], [-33.9, 18.4], [64, 150]]) {
      const { x, y, z } = calculateLocationAndRotationForLatLng(lat, lon, 1).position
      const p = globe.localToWorld(new THREE.Vector3(x, y, z)).sub(globe.position).normalize()
      const scene = equilibriumHeight(p.dot(moon), p.dot(sun), pulls)
      expect(Math.abs(scene - spotTide(lat, lon, t))).toBeLessThan(0.005)
    }
  })

  it('has the Sun lined up with the Moon at New Moon', () => {
    const moon = new THREE.Vector3()
    const sun = new THREE.Vector3()
    sceneTideDirections(SPRING, moon, sun)
    expect(Math.acos(moon.dot(sun)) / DEG).toBeLessThan(6)
    sceneTideDirections(KING, moon, sun)
    expect(Math.acos(-moon.dot(sun)) / DEG).toBeLessThan(6)
  })
})

describe('tidesSpot', () => {
  it('is the pin, or the default spot', () => {
    expect(tidesSpot(null)).toEqual({ ...TIDES_DEFAULT_SPOT, pinned: false })
    expect(tidesSpot({ lat: 50.4, lon: -4.1 })).toEqual({ lat: 50.4, lon: -4.1, pinned: true })
  })
})


