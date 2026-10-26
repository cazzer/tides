import { afterEach, describe, expect, it } from 'vitest'
import { EARTH_RADIUS_KM } from './cloud-layer'
import {
  EARTH_KM_PER_UNIT,
  SURFACE_FADE_START,
  SURFACE_MAX_METRES,
  SURFACE_TOP,
  SURFACE_TOP_KM,
  setSurfaceEye,
  surfaceOpacity,
  surfaceOpacityUniform,
} from './surface-handover'
import { EARTH_COLLISION_RADIUS, EARTH_RADIUS } from './ship/ship-bodies'

afterEach(() => setSurfaceEye(Infinity))

describe('true units (tides-zmw.9.5)', () => {
  it('measures ~2159 km a scene unit at Earth, and the tiles up to Everest with room', () => {
    expect(EARTH_KM_PER_UNIT).toBeCloseTo(EARTH_RADIUS_KM / EARTH_RADIUS, 9)
    expect(EARTH_KM_PER_UNIT).toBeGreaterThan(2150)
    expect(EARTH_KM_PER_UNIT).toBeLessThan(2170)
    expect(SURFACE_MAX_METRES).toBeGreaterThan(8849)
  })
})

describe('the surface handover (tides-zmw.9.7)', () => {
  it('tops out at ~100 km true, dissolving from 60 km', () => {
    expect(SURFACE_TOP_KM).toBe(100)
    expect(SURFACE_TOP * EARTH_KM_PER_UNIT).toBeCloseTo(100, 9)
    expect(SURFACE_FADE_START).toBe(0.6)
  })

  it('gives the tiles all the ground up to 0.6 of the top and none from the top, monotonic', () => {
    const top = SURFACE_TOP
    for (const a of [-1, 0, 0.004, 0.3 * top, 0.6 * top]) expect(surfaceOpacity(a)).toBe(1)
    for (const a of [top, 1.5 * top, 1, Infinity]) expect(surfaceOpacity(a)).toBe(0)
    let prev = 1
    for (let k = 0; k <= 1000; k++) {
      const o = surfaceOpacity(0.6 * top + (0.4 * top * k) / 1000)
      expect(o).toBeLessThanOrEqual(prev)
      prev = o
    }
    expect(surfaceOpacity(0.8 * top)).toBeCloseTo(0.5, 12)
  })

  it('is written by setSurfaceEye, 0 away from Earth', () => {
    for (const altitude of [0, 0.004, 0.7 * SURFACE_TOP, SURFACE_TOP, Infinity]) {
      setSurfaceEye(altitude)
      expect(surfaceOpacityUniform.value).toBe(surfaceOpacity(altitude))
    }
    setSurfaceEye(Infinity)
    expect(surfaceOpacityUniform.value).toBe(0)
  })

  it("keeps the low tier's stop above it: that tier never draws the tiles", () => {
    expect(EARTH_COLLISION_RADIUS - EARTH_RADIUS).toBeGreaterThan(SURFACE_TOP)
  })
})
