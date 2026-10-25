import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { Body, Illumination } from 'astronomy-engine'
import { earthPosition, moonOffset } from './ephemeris'
import { CLOUD_AMBIENT } from './lighting'
import {
  moonIlluminatedFraction,
  moonlightStrength,
  moonUp,
  MOON_UP_FROM,
  MOON_UP_TO,
  NIGHT_ADAPT_FAR,
  NIGHT_ADAPT_NEAR,
  nightAdaptation,
  nightCloudAmbient,
} from './night-flight'

const sinDeg = (deg: number) => Math.sin((deg * Math.PI) / 180)

describe('night adaptation', () => {
  it('is none by day or beyond half an Earth radius, and full at night below a tenth', () => {
    expect(nightAdaptation(sinDeg(30), 0.01)).toBe(0)
    expect(nightAdaptation(sinDeg(2), 0.01)).toBe(0)
    expect(nightAdaptation(sinDeg(-30), NIGHT_ADAPT_FAR)).toBe(0)
    expect(nightAdaptation(sinDeg(-30), 2)).toBe(0)
    expect(nightAdaptation(sinDeg(-8), NIGHT_ADAPT_NEAR)).toBe(1)
    expect(nightAdaptation(sinDeg(-60), 0.009)).toBe(1)
    // The ship's stops: 60 km and 400 km adapt fully, 3000 km all but not.
    expect(nightAdaptation(sinDeg(-30), 0.063)).toBe(1)
    expect(nightAdaptation(sinDeg(-30), 0.47)).toBeLessThan(0.02)
  })

  it('grows as the Sun sinks and the eye comes down', () => {
    let last = -1
    for (let deg = 4; deg >= -12; deg -= 0.5) {
      const a = nightAdaptation(sinDeg(deg), 0.01)
      expect(a).toBeGreaterThanOrEqual(last)
      last = a
    }
    last = -1
    for (let gap = 0.6; gap >= 0; gap -= 0.02) {
      const a = nightAdaptation(sinDeg(-20), gap)
      expect(a).toBeGreaterThanOrEqual(last)
      last = a
    }
  })
})

describe('moonlight', () => {
  // The scene's directions from Earth: the Sun is the origin.
  const fraction = (iso: string) => {
    const t = Date.parse(iso)
    const sun = new THREE.Vector3(...earthPosition(t)).negate().normalize()
    const moon = new THREE.Vector3(...moonOffset(t)).normalize()
    return moonIlluminatedFraction(sun, moon)
  }

  it("matches the Moon's illuminated fraction, full, quarter and new", () => {
    for (const iso of ['2026-10-26T04:12:00Z', '2026-11-01T20:29:00Z', '2026-11-09T07:03:00Z', '2026-11-04T00:00:00Z']) {
      expect(Math.abs(fraction(iso) - Illumination(Body.Moon, new Date(iso)).phase_fraction)).toBeLessThan(0.02)
    }
    expect(fraction('2026-10-26T04:12:00Z')).toBeGreaterThan(0.99)
    expect(fraction('2026-11-09T07:03:00Z')).toBeLessThan(0.01)
  })

  it('weights the light by the phase: a quarter Moon gives a quarter of the full', () => {
    expect(moonlightStrength(1)).toBe(1)
    expect(moonlightStrength(0.5)).toBe(0.25)
    expect(moonlightStrength(0)).toBe(0)
  })

  it('fades in across the horizon, with the edges the shader uses', () => {
    expect(moonUp(-0.1)).toBe(0)
    expect(moonUp(MOON_UP_FROM)).toBe(0)
    expect(moonUp(MOON_UP_TO)).toBe(1)
    expect(moonUp(0.02)).toBeCloseTo(0.5, 6)
    expect([MOON_UP_FROM, MOON_UP_TO]).toEqual([-0.02, 0.06])
  })
})

describe("the clouds' night ambient", () => {
  it('is exactly CLOUD_AMBIENT unadapted, whatever the Moon', () => {
    expect(nightCloudAmbient(0, 1, 1)).toBe(CLOUD_AMBIENT)
    expect(nightCloudAmbient(0, 0, -1)).toBe(CLOUD_AMBIENT)
  })

  it('reads brighter moonlit than moonless, and the Moon adds nothing below the horizon', () => {
    const moonless = nightCloudAmbient(1, 0, 0.8)
    expect(moonless).toBeGreaterThan(CLOUD_AMBIENT)
    expect(moonless).toBeCloseTo(0.115, 2)
    const full = nightCloudAmbient(1, 1, 1)
    expect(full).toBeGreaterThan(moonless)
    expect(full).toBeGreaterThan(0.28)
    expect(full).toBeLessThan(0.31)
    expect(nightCloudAmbient(1, 1, 0.5)).toBeLessThan(full)
    expect(nightCloudAmbient(1, 1, -0.2)).toBe(nightCloudAmbient(1, 0, -0.2))
  })
})
