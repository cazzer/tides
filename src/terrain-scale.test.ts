import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  EARTH_RADIUS_KM,
  TERRAIN_DISPLACEMENT,
  TERRAIN_MAX_GREY,
  TRUE_TERRAIN_DISPLACEMENT,
  cloudColumn,
} from './cloud-layer'
import { MAX_RELIEF, MIN_RELIEF, REFERENCE_RELIEF, RELIEF } from './relief'
import {
  EARTH_KM_PER_UNIT,
  FLOOR_MARGIN_GREY,
  SURFACE_FADE_START,
  SURFACE_MAX,
  SURFACE_MAX_METRES,
  TERRAIN_BLEND_PEAK,
  TERRAIN_BLEND,
  TERRAIN_BLEND_MAX_GAIN,
  TERRAIN_BLEND_RAMP,
  TERRAIN_BLEND_MIN_TOP_KM,
  TRUE_FLOOR_MAX,
  applyTerrainScale,
  liveTerrainDisplacement,
  parseTerrainBlend,
  setTerrainEye,
  surfaceOpacity,
  surfaceOpacityUniform,
  terrainBlendOn,
  terrainBlendPeak,
  terrainBlendTop,
  terrainDisplacement,
  terrainScale,
  terrainScaleUniform,
} from './terrain-scale'
import { EARTH_COLLISION_RADIUS, EARTH_GROUND_CLEARANCE, EARTH_GROUND_SPEED, EARTH_RADIUS } from './ship/ship-bodies'
import { OVERSPEED_MAX } from './ship/flight'
import { TERRAIN_GREY_MARGIN } from './ship/terrain-floor'

const RELIEFS = [MIN_RELIEF, 2, 4, 8, RELIEF, 16, 20, MAX_RELIEF]
const c = EARTH_GROUND_CLEARANCE

afterEach(() => setTerrainEye(Infinity))

describe('?blend=1 (tides-zmw.9.5)', () => {
  it('turns the live scale on only for ?blend=1', () => {
    expect(parseTerrainBlend('?blend=1')).toBe(true)
    expect(parseTerrainBlend('?ship=1&blend=1&relief=12')).toBe(true)
    for (const search of ['', '?ship=1', '?blend=', '?blend=0', '?blend=true', '?blend=2']) {
      expect(parseTerrainBlend(search), search).toBe(false)
    }
  })

  it('is on with ?blend=1 or the surface tiles (tides-zmw.9.7)', () => {
    expect(terrainBlendOn(false, false)).toBe(false)
    expect(terrainBlendOn(true, false)).toBe(true)
    expect(terrainBlendOn(false, true)).toBe(true)
  })

  it('is off outside a browser, where every reader gets TERRAIN_DISPLACEMENT to the bit', () => {
    expect(TERRAIN_BLEND).toBe(false)
    for (const altitude of [-1, 0, 0.004, 0.03, 1, Infinity]) {
      setTerrainEye(altitude)
      expect(terrainScale(altitude)).toBe(RELIEF)
      expect(terrainScaleUniform.value).toBe(RELIEF)
      expect(liveTerrainDisplacement()).toBe(TERRAIN_DISPLACEMENT)
    }
    expect(terrainDisplacement(RELIEF)).toBe(TERRAIN_DISPLACEMENT)
  })
})

describe('terrainScale (tides-zmw.9.5)', () => {
  it('measures in true units: 1x at TRUE_TERRAIN_DISPLACEMENT, ~2159 km a scene unit', () => {
    expect(TRUE_TERRAIN_DISPLACEMENT).toBeCloseTo(TERRAIN_DISPLACEMENT / RELIEF, 15)
    expect(TRUE_TERRAIN_DISPLACEMENT * REFERENCE_RELIEF).toBeCloseTo(0.075, 15)
    expect(EARTH_KM_PER_UNIT).toBeCloseTo(EARTH_RADIUS_KM / EARTH_RADIUS, 9)
    expect(EARTH_KM_PER_UNIT).toBeGreaterThan(2150)
    expect(EARTH_KM_PER_UNIT).toBeLessThan(2170)
    expect(terrainDisplacement(1)).toBeCloseTo(TRUE_TERRAIN_DISPLACEMENT, 17)
    // The floor's margin, mirrored to keep this module off the floor's map.
    expect(FLOOR_MARGIN_GREY).toBe(TERRAIN_GREY_MARGIN)
    expect(TRUE_FLOOR_MAX).toBeCloseTo(TRUE_TERRAIN_DISPLACEMENT * (TERRAIN_MAX_GREY + TERRAIN_GREY_MARGIN / 255), 15)
  })

  it('tops out at the ~100 km true handover, higher where the stop needs it: ~110 km at 12x over the globe', () => {
    expect(TERRAIN_BLEND_PEAK).toBe(TRUE_FLOOR_MAX)
    expect(terrainBlendTop(1) * EARTH_KM_PER_UNIT).toBeCloseTo(TERRAIN_BLEND_MIN_TOP_KM, 9)
    for (const relief of RELIEFS) expect(terrainBlendTop(relief) * EARTH_KM_PER_UNIT).toBeGreaterThanOrEqual(100 - 1e-9)
    expect(terrainBlendTop(12)).toBeCloseTo(0.0511, 3)
    expect(terrainBlendTop(12) * EARTH_KM_PER_UNIT).toBeGreaterThan(105)
    expect(terrainBlendTop(12) * EARTH_KM_PER_UNIT).toBeLessThan(115)
    expect(terrainBlendTop(25)).toBeCloseTo(0.1115, 3)
  })

  it('tops out higher with the tiles, for their true peaks: ~183 km at 12x (tides-zmw.9.7)', () => {
    const tiles = terrainBlendPeak(true)
    expect(tiles).toBe(SURFACE_MAX)
    expect(terrainBlendPeak(false)).toBe(TRUE_FLOOR_MAX)
    expect(terrainBlendTop(12, 'smooth', tiles)).toBeCloseTo(0.085, 3)
    expect(terrainBlendTop(12, 'smooth', tiles) * EARTH_KM_PER_UNIT).toBeGreaterThan(178)
    expect(terrainBlendTop(12, 'smooth', tiles) * EARTH_KM_PER_UNIT).toBeLessThan(188)
    expect(terrainBlendTop(25, 'smooth', tiles)).toBeCloseTo(0.1855, 3)
    // Sized for the tiles' true peaks, which stand above the globe's
    // smoothed highest (tides-zmw.9.7).
    expect(SURFACE_MAX_METRES).toBeGreaterThan(8849)
    expect(SURFACE_MAX).toBeCloseTo(SURFACE_MAX_METRES / 1000 / EARTH_KM_PER_UNIT, 15)
    expect(SURFACE_MAX).toBeGreaterThan(TRUE_FLOOR_MAX)
    // The linear ramp (Q1's choice B): two thirds as high, ~122 km.
    expect(terrainBlendTop(12, 'linear', tiles) / terrainBlendTop(12, 'smooth', tiles)).toBeCloseTo(2 / 3, 12)
    expect(terrainBlendTop(12, 'linear', tiles) * EARTH_KM_PER_UNIT).toBeGreaterThan(118)
    expect(terrainBlendTop(12, 'linear', tiles) * EARTH_KM_PER_UNIT).toBeLessThan(126)
    expect(TERRAIN_BLEND_RAMP).toBe('smooth')
  })

  it.each(RELIEFS)('at relief %d, eases linearly on the linear ramp, monotonic and continuous', (relief) => {
    const top = terrainBlendTop(relief, 'linear', SURFACE_MAX)
    const s = (a: number) => terrainScale(a, relief, true, 'linear', SURFACE_MAX)
    expect(s(0)).toBe(1)
    expect(s(top)).toBe(relief)
    expect(s(top / 2)).toBeCloseTo((1 + relief) / 2, 12)
    let gain = 0
    for (let k = 0; k < 2000; k++) {
      const a = (top * k) / 2000
      const b = (top * (k + 1)) / 2000
      expect(s(b)).toBeGreaterThanOrEqual(s(a))
      gain = Math.max(gain, ((s(b) - s(a)) / (b - a)) * SURFACE_MAX)
    }
    expect(gain).toBeLessThanOrEqual(TERRAIN_BLEND_MAX_GAIN + 1e-9)
  })

  it.each(RELIEFS)('at relief %d, eases from 1x at the sea to the relief at the top, monotonic and smooth', (relief) => {
    const top = terrainBlendTop(relief)
    const s = (a: number) => terrainScale(a, relief, true)
    expect(s(0)).toBe(1)
    expect(s(-0.01)).toBe(1)
    expect(s(top)).toBe(relief)
    expect(s(2 * top)).toBe(relief)
    expect(s(Infinity)).toBe(relief)
    const n = 4000
    let prev = s(0)
    let prevSlope = 0
    for (let k = 1; k <= n + 200; k++) {
      const a = (top * k) / n
      const next = s(a)
      expect(next).toBeGreaterThanOrEqual(prev)
      // C1: the slope changes by no more than smoothstep's second
      // derivative (6/top² × (relief - 1)) allows over a step, and is
      // nil at both ends.
      const slope = (next - prev) / (top / n)
      expect(Math.abs(slope - prevSlope)).toBeLessThanOrEqual((6 * (relief - 1) * (top / n)) / (top * top) + 1e-6)
      prev = next
      prevSlope = slope
    }
    const h = top * 1e-6
    expect((s(h) - s(0)) / h).toBeLessThan(1e-3 * (relief - 1) + 1e-12)
    expect((s(top) - s(top - h)) / h).toBeLessThan(1e-3 * (relief - 1) + 1e-12)
  })

  it.each(RELIEFS)("at relief %d, moves the stop's fixed point under TERRAIN_BLEND_MAX_GAIN of the eye's move, over the globe and over the tiles' true peaks", (relief) => {
    for (const peak of [TRUE_FLOOR_MAX, SURFACE_MAX]) {
      const top = terrainBlendTop(relief, 'smooth', peak)
      let gain = 0
      for (let k = 0; k < 10000; k++) {
        const a = (top * k) / 10000
        const b = (top * (k + 1)) / 10000
        gain = Math.max(gain, ((terrainScale(b, relief, true, 'smooth', peak) - terrainScale(a, relief, true, 'smooth', peak)) / (b - a)) * peak)
      }
      expect(gain).toBeLessThanOrEqual(TERRAIN_BLEND_MAX_GAIN + 1e-9)
    }
    expect(TERRAIN_BLEND_MAX_GAIN).toBeLessThan(1)
  })

  it.each(RELIEFS)('at relief %d, raises the eye over true ground up to SURFACE_MAX faster than the drawn ground rises', (relief) => {
    // g(a) = a - s(a) h, the eye's height over the drawn ground h (true):
    // rising at least 1 - TERRAIN_BLEND_MAX_GAIN per unit of a, so the stop
    // (g = clearance) is one altitude, and every eye above it clears the
    // drawn peak; and over the top the eye clears it by a margin.
    const top = terrainBlendTop(relief, 'smooth', SURFACE_MAX)
    for (let i = 1; i <= 100; i++) {
      const h = (SURFACE_MAX * i) / 100
      const g = (a: number) => a - terrainScale(a, relief, true, 'smooth', SURFACE_MAX) * h
      for (let k = 0; k < 400; k++) {
        const a = h + ((top * 1.2 - h) * k) / 400
        const b = h + ((top * 1.2 - h) * (k + 1)) / 400
        expect((g(b) - g(a)) / (b - a)).toBeGreaterThanOrEqual(1 - TERRAIN_BLEND_MAX_GAIN - 1e-9)
      }
      expect(g(top)).toBeGreaterThan(0.3 * top)
    }
  })

  it("keeps the low tier's stop above the blend: that tier always draws the full relief", () => {
    expect(EARTH_COLLISION_RADIUS - EARTH_RADIUS).toBeGreaterThan(terrainBlendTop(RELIEF))
    expect(EARTH_COLLISION_RADIUS - EARTH_RADIUS).toBeGreaterThan(terrainBlendTop(RELIEF, 'smooth', SURFACE_MAX))
  })
})

describe('the live scale (tides-zmw.9.5)', () => {
  it('goes from setTerrainEye through one uniform to the ground material and the CPU floor', () => {
    const top = terrainBlendTop(RELIEF)
    const material = new THREE.MeshPhongMaterial({ displacementScale: TERRAIN_DISPLACEMENT })
    for (const altitude of [0, 0.004, 0.01, top / 2, top, 1]) {
      setTerrainEye(altitude, true)
      const s = terrainScale(altitude, RELIEF, true)
      expect(terrainScaleUniform.value).toBe(s)
      expect(liveTerrainDisplacement()).toBeCloseTo(TRUE_TERRAIN_DISPLACEMENT * s, 15)
      applyTerrainScale(material)
      expect(material.displacementScale).toBe(liveTerrainDisplacement())
    }
    setTerrainEye(0, true)
    expect(terrainScaleUniform.value).toBe(1)
    // Leaving Earth (or the ship view) puts the full relief back.
    setTerrainEye(Infinity, true)
    expect(terrainScaleUniform.value).toBe(RELIEF)
    applyTerrainScale(material)
    expect(material.displacementScale).toBe(TERRAIN_DISPLACEMENT)
  })

  // The blend at the relief it was built for, passed explicitly: at the 1x
  // default (tides-zmw.21) it is 1x throughout.
  const BLEND_RELIEF = 12

  // The stop's fixed point over ground of `floorGrey` levels (the floor's,
  // margin included): from `from`, the step that writes the scale before it
  // clamps, repeated.
  function settle(floorGrey: number, from: number): number {
    let a = from
    for (let k = 0; k < 400; k++) {
      setTerrainEye(a, true, BLEND_RELIEF)
      a = (liveTerrainDisplacement() * floorGrey) / 255 + c
    }
    return a
  }

  const MAX_FLOOR_GREY = TERRAIN_MAX_GREY * 255 + TERRAIN_GREY_MARGIN

  it('converges to one stop from above or below, continuous across the ground', () => {
    let prev: number | null = null
    const dGrey = 0.25
    // The stop moves at most the relief × the ground's move, over (1 - gain).
    const bound = (TRUE_TERRAIN_DISPLACEMENT * BLEND_RELIEF * dGrey) / 255 / (1 - TERRAIN_BLEND_MAX_GAIN)
    for (let grey = 0; grey <= MAX_FLOOR_GREY; grey += dGrey) {
      const fromAbove = settle(grey, 1)
      const fromBelow = settle(grey, c)
      expect(Math.abs(fromAbove - fromBelow)).toBeLessThan(1e-12)
      const s = terrainScale(fromAbove, BLEND_RELIEF, true)
      expect(Math.abs(fromAbove - ((terrainDisplacement(s) * grey) / 255 + c))).toBeLessThan(1e-12)
      if (prev !== null) expect(Math.abs(fromAbove - prev)).toBeLessThanOrEqual(bound)
      prev = fromAbove
    }
    // Over the sea near 1.15x; over the highest ground, a little over 2x.
    expect(terrainScale(settle(0, 1), BLEND_RELIEF, true)).toBeCloseTo(1.15, 1)
    const highest = terrainScale(settle(MAX_FLOOR_GREY, 1), BLEND_RELIEF, true)
    expect(highest).toBeGreaterThan(1.8)
    expect(highest).toBeLessThan(2.6)
  })

  it('holds the ship its clearance over the drawn ground and under the cloud base every frame, down from orbit and across the ground', () => {
    // The drawn ground's grey (vertex grey: the floor less its margin) along
    // a pass: sea, up the highest ground, a cliff, a valley, back to sea.
    const ground = (x: number) => {
      const peak = TERRAIN_MAX_GREY * 255
      if (x < 0.2) return 0
      if (x < 0.5) return (peak * (x - 0.2)) / 0.3
      if (x < 0.6) return peak
      if (x < 0.62) return peak * 0.3
      if (x < 0.8) return peak * (0.3 + 0.4 * Math.sin((x - 0.62) * 20) ** 2)
      return 0
    }
    const frames = 6000
    const dt = 1 / 60
    let a = 0.15
    let minGap = Infinity
    let maxStep = 0
    let prevScale = terrainScale(a, BLEND_RELIEF, true)
    let stopped = 0
    for (let k = 0; k < frames; k++) {
      // Descend first, then fly the pass at the stop.
      const x = k < 2000 ? 0.55 : (k - 2000) / (frames - 2000)
      const grey = ground(x)
      // ShipController's order: write the scale from where the ship is, then
      // step against the floor at it.
      setTerrainEye(a, true, BLEND_RELIEF)
      const floor = (liveTerrainDisplacement() * (grey + TERRAIN_GREY_MARGIN)) / 255 + c
      a = Math.max(a - OVERSPEED_MAX * EARTH_GROUND_SPEED * dt, floor)
      // The frame then draws at the scale just written.
      const drawn = (liveTerrainDisplacement() * grey) / 255
      minGap = Math.min(minGap, a - drawn)
      expect(a - drawn).toBeGreaterThanOrEqual(c - 1e-12)
      // At the stop, under the cloud base, which stands on the drawn ground
      // at the live scale (tides-zmw.9.6), so drops with it.
      if (a === floor) {
        stopped++
        expect(a).toBeLessThan(cloudColumn(1, 1.5, grey / 255, liveTerrainDisplacement()).base)
      }
      maxStep = Math.max(maxStep, Math.abs(terrainScaleUniform.value - prevScale))
      prevScale = terrainScaleUniform.value
    }
    expect(minGap).toBeGreaterThanOrEqual(c - 1e-12)
    expect(stopped).toBeGreaterThan(frames / 2)
    // No frame moves the scale by more than 5% of the relief, diving at the
    // fastest the cap allows down there (its overspeed, at 60 fps).
    expect(maxStep).toBeLessThanOrEqual(0.05 * BLEND_RELIEF)
  })
})

describe('the surface handover (tides-zmw.9.7)', () => {
  it.each(RELIEFS)('at relief %d, gives the tiles all the ground up to 0.6 of the top and none from the top, monotonic', (relief) => {
    const top = terrainBlendTop(relief)
    expect(SURFACE_FADE_START).toBe(0.6)
    for (const a of [-1, 0, 0.004, 0.3 * top, 0.6 * top]) expect(surfaceOpacity(a, relief)).toBe(1)
    for (const a of [top, 1.5 * top, 1, Infinity]) expect(surfaceOpacity(a, relief)).toBe(0)
    let prev = 1
    for (let k = 0; k <= 1000; k++) {
      const o = surfaceOpacity(0.6 * top + (0.4 * top * k) / 1000, relief)
      expect(o).toBeLessThanOrEqual(prev)
      prev = o
    }
    expect(surfaceOpacity(0.8 * top, relief)).toBeCloseTo(0.5, 12)
    // The linear ramp's own, lower top.
    expect(surfaceOpacity(terrainBlendTop(relief, 'linear'), relief, 'linear')).toBe(0)
  })

  it('is written with the scale by setTerrainEye, 0 away from Earth', () => {
    const top = terrainBlendTop(RELIEF)
    for (const altitude of [0, 0.004, 0.7 * top, top, Infinity]) {
      setTerrainEye(altitude, true)
      expect(surfaceOpacityUniform.value).toBe(surfaceOpacity(altitude))
      expect(terrainScaleUniform.value).toBe(terrainScale(altitude, RELIEF, true))
    }
    setTerrainEye(Infinity)
    expect(surfaceOpacityUniform.value).toBe(0)
  })
})
