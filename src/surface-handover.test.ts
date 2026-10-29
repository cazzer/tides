import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_DECK_BAND_KM, EARTH_RADIUS_KM, TRUE_CLOUD_UNITS_PER_KM } from './cloud-layer'
import {
  EARTH_KM_PER_UNIT,
  SURFACE_FADE_START,
  SURFACE_MAX_METRES,
  SURFACE_MIN_TOP_KM,
  SURFACE_TOP,
  SURFACE_TOP_KM,
  setSurfaceEye,
  surfaceOpacity,
  surfaceOpacityUniform,
  surfaceTopKm,
} from './surface-handover'
import { MAX_RELIEF, RELIEF } from './relief'
import { EARTH_COLLISION_RADIUS, EARTH_GROUND_CLEARANCE, EARTH_RADIUS, EARTH_UNITS_PER_METRE, SURFACE_GROUND_MARGIN_METRES } from './ship/ship-bodies'

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
  it('tops out at 100 km true at 1x, dissolving from 60 km, and higher with the relief', () => {
    expect(SURFACE_MIN_TOP_KM).toBe(100)
    expect(surfaceTopKm(1)).toBe(100)
    expect(SURFACE_TOP_KM).toBe(surfaceTopKm(RELIEF))
    expect(SURFACE_TOP * EARTH_KM_PER_UNIT).toBeCloseTo(SURFACE_TOP_KM, 9)
    expect(SURFACE_FADE_START).toBe(0.6)
    expect(surfaceTopKm(12)).toBeGreaterThan(180)
    expect(surfaceTopKm(12)).toBeLessThan(200)
  })

  it.each([1, 12, MAX_RELIEF])('at relief %d, gives the tiles all the ground at the stop over their highest drawn peak', (relief) => {
    // The standard depth buffer's stop (the higher one) over SURFACE_MAX, drawn at the relief.
    const stop = (SURFACE_MAX_METRES + SURFACE_GROUND_MARGIN_METRES) * relief * EARTH_UNITS_PER_METRE + EARTH_GROUND_CLEARANCE
    expect(surfaceOpacity(stop, relief)).toBe(1)
    expect(surfaceOpacity(surfaceTopKm(relief) / EARTH_KM_PER_UNIT, relief)).toBe(0)
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

  it("keeps the low tier's stop above it at any relief: that tier never draws the tiles", () => {
    expect(EARTH_COLLISION_RADIUS - EARTH_RADIUS).toBeGreaterThan(SURFACE_TOP)
    expect(EARTH_COLLISION_RADIUS - EARTH_RADIUS).toBeGreaterThan(surfaceTopKm(MAX_RELIEF) / EARTH_KM_PER_UNIT)
  })
})

describe("the cloud deck's band (tides-d9f.10)", () => {
  it('is true scale near the ground at the default relief, and exaggerated from the handover up', () => {
    // The ground's km, which is the scene's to within the relief's rounding
    // (REFERENCE_TERRAIN_DISPLACEMENT is 25x true scale to 1%).
    if (RELIEF === 1) expect(TRUE_CLOUD_UNITS_PER_KM * EARTH_KM_PER_UNIT).toBeCloseTo(1, 1)
    // cloud-layer.ts can't import this module (it imports that one).
    expect(CLOUD_DECK_BAND_KM[1]).toBe(SURFACE_MIN_TOP_KM)
  })
})
