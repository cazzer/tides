// Rain and snow around the ship (tides-bl3.3): falling-precip.ts, and the
// eye's place read back through earthLatLon into the precipitation grid.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { latLonToLocal } from '../aurora'
import { CLOUD_CLEARANCE, CLOUD_FLAT_ALTITUDE, CLOUD_UNITS_PER_KM, EXAGGERATED_DECK, FINE_DECK, FINE_DECK_BASE_KM, TRUE_CLOUD_UNITS_PER_KM } from '../cloud-layer'
import { encodePrecip, precipFromFrames } from '../cloud-precip'
import { TYPE_H, TYPE_W, typeTexelLat, typeTexelLon } from '../cloud-types'
import { EARTH_UNITS_PER_METRE } from '../surface-handover'
import { earthLatLon } from '../surface-ground'
import { wrapCoord } from './dust'
import { fillEarthEye, type Carrier } from './frame-carry'
import { createShipTelemetry } from './ship-telemetry'
import {
  MAX_STREAK_SHARE,
  NIGHT_LIGHT,
  PRECIP_HALF,
  PRECIP_PARTICLES,
  SNOW_PARTICLES,
  PRECIP_TOP,
  RAIN_FALL_MS,
  REDUCED_RAIN_STREAK_M,
  SHUTTER_S,
  SNOW_FALL_MS,
  altitudeFade,
  baseOverGround,
  cloudCoverAt,
  coverGate,
  daylight,
  fallSpeed,
  particleCount,
  particlePool,
  precipIntensity,
  precipShown,
  shouldSample,
  speedFade,
  stepAnchor,
  streakVector,
  swayAmplitude,
} from './falling-precip'

const M = EARTH_UNITS_PER_METRE
const DOWN = new THREE.Vector3(0, -1, 0)
const ZERO = new THREE.Vector3()

describe('the scale (tides-bl3.3)', () => {
  it("sizes the drops in true metres, the scale of FINE_DECK's base", () => {
    expect(TRUE_CLOUD_UNITS_PER_KM / (1000 * M)).toBeCloseTo(1, 1)
    expect(FINE_DECK.clearance / M / 1000).toBeCloseTo(FINE_DECK_BASE_KM, 1)
    expect(PRECIP_HALF / M).toBeCloseTo(15, 9)
  })
})

describe('how much falls (tides-bl3.3)', () => {
  it('is nothing without data or under the least rate', () => {
    expect(precipIntensity(null)).toEqual({ amount: 0, snowShare: 0 })
    expect(precipIntensity({ rain: 0.02, showers: 0, snow: 0 }).amount).toBe(0)
  })

  it('shows light rain, reads heavy at 1-2 mm/h, and is full from 2', () => {
    const at = (rain: number) => precipIntensity({ rain, showers: 0, snow: 0 }).amount
    expect(at(0.1)).toBeCloseTo(0.19, 2)
    expect(at(0.5)).toBeCloseTo(0.49, 2)
    expect(at(1)).toBeCloseTo(0.7, 2)
    expect(at(2)).toBe(1)
    expect(at(8)).toBe(1)
    for (let r = 0.03; r < 2; r += 0.05) expect(at(r + 0.05)).toBeGreaterThan(at(r))
  })

  it('counts showers as rain, snow 2.5 times its water, and splits rain from snow', () => {
    expect(precipIntensity({ rain: 0, showers: 0.4, snow: 0 })).toEqual(precipIntensity({ rain: 0.4, showers: 0, snow: 0 }))
    expect(precipIntensity({ rain: 0, showers: 0, snow: 0.2 }).amount).toBeCloseTo(
      precipIntensity({ rain: 0.5, showers: 0, snow: 0 }).amount,
      12
    )
    expect(precipIntensity({ rain: 0, showers: 0, snow: 1 })).toEqual({ amount: 1, snowShare: 1 })
    expect(precipIntensity({ rain: 0.2, showers: 0, snow: 0.2 }).snowShare).toBe(0.5)
    expect(precipIntensity({ rain: 0.5, showers: 0, snow: 0 }).snowShare).toBe(0)
  })

  it('draws the tier’s drops at full, none at 0, more with more', () => {
    expect(particleCount('high', 1)).toBe(PRECIP_PARTICLES.high)
    expect(particleCount('low', 1)).toBe(PRECIP_PARTICLES.low)
    expect(PRECIP_PARTICLES).toEqual({ high: 4000, low: 1500 })
    expect(particleCount('high', 0)).toBe(0)
    expect(particleCount('low', 2)).toBe(PRECIP_PARTICLES.low)
    for (let a = 0; a < 1; a += 0.1) expect(particleCount('high', a + 0.1)).toBeGreaterThanOrEqual(particleCount('high', a))
    // Snow draws its own, larger count (tides-bl3.7), within the pool.
    expect(particleCount('high', 1, 1)).toBe(SNOW_PARTICLES.high)
    expect(particleCount('low', 1, 1)).toBe(SNOW_PARTICLES.low)
    expect(particleCount('high', 1, 0.5)).toBe(2 * PRECIP_PARTICLES.high)
    for (const tier of ['high', 'low'] as const) {
      expect(SNOW_PARTICLES[tier]).toBeGreaterThan(PRECIP_PARTICLES[tier])
      for (const s of [0, 0.3, 1]) expect(particleCount(tier, 1, s)).toBeLessThanOrEqual(particlePool(tier))
      // The rain drawn in a mix is never more than in an all-rain fall.
      for (const s of [0.1, 0.5, 0.9]) expect(particleCount(tier, 1, s) * (1 - s)).toBeLessThanOrEqual(PRECIP_PARTICLES[tier] + 0.5)
    }
  })
})

describe('where it falls (tides-bl3.3)', () => {
  it('falls under the base and fades out over a band above it', () => {
    expect(altitudeFade(0.5, 1, 1)).toBe(1)
    expect(altitudeFade(1, 1, 1)).toBe(1)
    expect(altitudeFade(1.5, 1, 1)).toBeCloseTo(0.5, 12)
    expect(altitudeFade(2, 1, 1)).toBe(0)
    expect(altitudeFade(10, 1, 1)).toBe(0)
  })

  it("takes the base from the deck, or the flat shell's altitude over the ground", () => {
    expect(baseOverGround(false, FINE_DECK, 0.0001)).toBe(FINE_DECK.clearance)
    expect(baseOverGround(false, EXAGGERATED_DECK, 0.0001)).toBe(EXAGGERATED_DECK.clearance)
    expect(baseOverGround(true, EXAGGERATED_DECK, 0.0001)).toBeCloseTo(CLOUD_FLAT_ALTITUDE - 0.0001, 15)
  })

  it("stands its ceiling over every deck's base and band", () => {
    // The highest ground, as CLOUD_FLAT_ALTITUDE is built over it.
    const ground = CLOUD_FLAT_ALTITUDE - CLOUD_CLEARANCE - 1.5 * CLOUD_UNITS_PER_KM
    for (const deck of [FINE_DECK, EXAGGERATED_DECK]) {
      expect(ground + deck.clearance + deck.unitsPerKm).toBeLessThan(PRECIP_TOP)
    }
    expect(altitudeFade(PRECIP_TOP, baseOverGround(true, EXAGGERATED_DECK, 0), CLOUD_UNITS_PER_KM)).toBe(0)
  })

  it('falls only under the cloud drawn overhead, read as the shell lays out its map', () => {
    // A small map, bottom row first: cloud over the northern hemisphere's
    // eastern half only (lon 0..180, the map's right half), alpha in green.
    const width = 72
    const height = 36
    const data = new Uint8Array(width * height * 4)
    for (let y = height / 2; y < height; y++) {
      for (let x = width / 2; x < width; x++) data[(y * width + x) * 4 + 1] = 255
    }
    const map = { data, width, height }
    expect(cloudCoverAt(map, map, 0.4, 45, 90)).toBe(1)
    expect(cloudCoverAt(map, map, 0.4, -45, 90)).toBe(0)
    expect(cloudCoverAt(map, map, 0.4, 45, -90)).toBe(0)
    // Wrapping: 270° east is 90° west.
    expect(cloudCoverAt(map, null, 0, 45, 270)).toBe(0)
    // Mixed a to b, a missing map clear; soft at an edge.
    expect(cloudCoverAt(map, null, 0.25, 45, 90)).toBeCloseTo(0.75, 12)
    const edge = cloudCoverAt(map, map, 0, 0, 90)
    expect(edge).toBeGreaterThan(0)
    expect(edge).toBeLessThan(1)
    expect(coverGate(0)).toBe(0)
    expect(coverGate(0.15)).toBe(0)
    expect(coverGate(0.5)).toBe(1)
    expect(coverGate(0.3)).toBeGreaterThan(0)
  })

  it('draws nothing (hidden, no draw) when dry, over the base or too fast', () => {
    expect(precipShown(0, 1, 1)).toBe(false)
    expect(precipShown(1, 0, 1)).toBe(false)
    expect(precipShown(1, 1, 0)).toBe(false)
    expect(precipShown(0.001, 1, 1)).toBe(false)
    expect(precipShown(0.5, 1, 1)).toBe(true)
    expect(speedFade(0)).toBe(1)
    expect(speedFade(300)).toBe(1)
    expect(speedFade(2000)).toBe(0)
  })

  it('reads the rate a few times a second', () => {
    expect(shouldSample(0, -Infinity)).toBe(true)
    expect(shouldSample(100, 0)).toBe(false)
    expect(shouldSample(250, 0)).toBe(true)
  })

  it('is lit by day, dim at night', () => {
    expect(daylight(1)).toBe(1)
    expect(daylight(-1)).toBe(NIGHT_LIGHT)
    expect(daylight(0)).toBeGreaterThan(NIGHT_LIGHT)
    expect(daylight(0)).toBeLessThan(1)
  })

  it("reads the grid where the eye is, through Earth's spin and earthLatLon", () => {
    const lat = typeTexelLat(17)
    const lon = typeTexelLon(96)
    const grid = new Uint8Array(TYPE_W * TYPE_H * 4)
    for (let i = 3; i < grid.length; i += 4) grid[i] = 255
    grid[(17 * TYPE_W + 96) * 4] = encodePrecip(1)
    const spin = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 1.3, 0, 'XYZ'))
    const earth: Carrier = { position: new THREE.Vector3(3, 1, -2), radius: 1, spin }
    const telemetry = createShipTelemetry()
    const rateAt = (latDeg: number, lonDeg: number) => {
      const up = latLonToLocal(latDeg, lonDeg).applyQuaternion(spin)
      fillEarthEye(telemetry, earth.position.clone().addScaledVector(up, 1.001), earth)
      const [la, lo] = earthLatLon(telemetry.earthEye.local)
      return precipFromFrames(grid, grid, 0.3, la / (Math.PI / 180), lo / (Math.PI / 180))
    }
    expect(rateAt(lat, lon)!.rain).toBeCloseTo(1, 1)
    expect(rateAt(-lat, lon)!.rain).toBe(0)
    expect(rateAt(lat, lon - 180)!.rain).toBe(0)
  })
})

describe('how it falls (tides-bl3.3)', () => {
  it('moves the drops down past a still eye, wrapped in the box', () => {
    const anchor = new THREE.Vector3(0.6, 0.6, 0.6).multiplyScalar(PRECIP_HALF)
    const fall = fallSpeed('rain', false)
    expect(fall / M).toBe(RAIN_FALL_MS)
    expect(fallSpeed('snow', false) / M).toBe(SNOW_FALL_MS)
    const before = wrapCoord(0.5, PRECIP_HALF, anchor.y)
    stepAnchor(anchor, ZERO, DOWN, fall, 0.1, PRECIP_HALF)
    const after = wrapCoord(0.5, PRECIP_HALF, anchor.y)
    expect((after - before) / M).toBeCloseTo(-0.8, 6)
    expect(anchor.x).toBe(0.6 * PRECIP_HALF)
    expect(anchor.z).toBe(0.6 * PRECIP_HALF)
  })

  it('streams them past a moving eye, many small steps as one big one', () => {
    const air = new THREE.Vector3(90, -5, 40).multiplyScalar(M)
    const fall = fallSpeed('rain', false)
    const small = new THREE.Vector3()
    for (let k = 0; k < 600; k++) stepAnchor(small, air, DOWN, fall, 1 / 60, PRECIP_HALF)
    const big = stepAnchor(new THREE.Vector3(), air, DOWN, fall, 10, PRECIP_HALF)
    const side = 2 * PRECIP_HALF
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(small[axis]).toBeGreaterThanOrEqual(0)
      expect(small[axis]).toBeLessThan(side)
      const gap = Math.abs(small[axis] - big[axis])
      expect(Math.min(gap, side - gap) / M).toBeLessThan(1e-6)
    }
  })

  it('streaks along the motion through the air, longer with speed, capped', () => {
    const fall = fallSpeed('rain', false)
    const still = streakVector(new THREE.Vector3(), ZERO, DOWN, fall, PRECIP_HALF, false, 'rain')
    // The tail where it was a shutter ago: above the head.
    expect(still.x).toBe(0)
    expect(still.y / M).toBeCloseTo(RAIN_FALL_MS * SHUTTER_S, 9)
    const slow = streakVector(new THREE.Vector3(), new THREE.Vector3(20 * M, 0, 0), DOWN, fall, PRECIP_HALF, false, 'rain')
    const fast = streakVector(new THREE.Vector3(), new THREE.Vector3(100 * M, 0, 0), DOWN, fall, PRECIP_HALF, false, 'rain')
    expect(fast.length()).toBeGreaterThan(slow.length())
    expect(slow.x / M).toBeCloseTo(20 * SHUTTER_S, 9)
    const capped = streakVector(new THREE.Vector3(), new THREE.Vector3(1e4 * M, 0, 0), DOWN, fall, PRECIP_HALF, false, 'rain')
    expect(capped.length()).toBeCloseTo(MAX_STREAK_SHARE * PRECIP_HALF, 15)
    const flake = streakVector(new THREE.Vector3(), new THREE.Vector3(20 * M, 0, 0), DOWN, fallSpeed('snow', false), PRECIP_HALF, false, 'snow')
    expect(flake.x / M).toBeCloseTo(20 * SHUTTER_S, 9)
    expect(flake.y).toBe(0)
  })
})

describe('under prefers-reduced-motion (tides-bl3.3)', () => {
  it('stops the fall and the sway', () => {
    expect(fallSpeed('rain', true)).toBe(0)
    expect(fallSpeed('snow', true)).toBe(0)
    expect(swayAmplitude(true)).toBe(0)
    expect(swayAmplitude(false)).toBeGreaterThan(0)
  })

  it('leaves the drops still around a still eye', () => {
    const anchor = new THREE.Vector3(1, 2, 3).multiplyScalar(M)
    const start = anchor.clone()
    for (const kind of ['rain', 'snow'] as const) {
      for (let k = 0; k < 120; k++) stepAnchor(anchor, ZERO, DOWN, fallSpeed(kind, true), 1 / 60, PRECIP_HALF)
    }
    expect(anchor.equals(start)).toBe(true)
  })

  it('draws rain as short still streaks and snow as still flakes', () => {
    const rain = streakVector(new THREE.Vector3(), ZERO, DOWN, fallSpeed('rain', true), PRECIP_HALF, true, 'rain')
    expect(rain.distanceTo(new THREE.Vector3(0, REDUCED_RAIN_STREAK_M * M, 0))).toBeLessThan(1e-18)
    const snow = streakVector(new THREE.Vector3(), ZERO, DOWN, fallSpeed('snow', true), PRECIP_HALF, true, 'snow')
    expect(snow.length()).toBe(0)
  })
})
