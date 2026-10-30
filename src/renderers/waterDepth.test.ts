// The sea's depth under the water's body (tides-d9f.6): the encoding, the
// tint's ramp and the map colours it leaves alone, and the shipped maps (scripts/build-earth-bathy.mjs) on the right grid.
import { readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeGreyPng } from './grey-png-fixture'
import {
  decodeWaterDepth,
  encodeWaterDepth,
  WATER_DEPTH_GLSL,
  WATER_DEPTH_MAX,
  WATER_DEPTH_NEUTRAL,
  WATER_DEPTH_SAMPLE,
  WATER_DEPTH_SHELF,
  WATER_DEPTH_SHOAL,
  WATER_DEPTH_SLOPE,
  WATER_KEEP,
  WATER_TINT_DEEP,
  WATER_TINT_SHALLOW,
  WATER_TINT_SHELF,
  WATER_TINT_TRENCH,
  waterTint,
  waterTinted,
} from './waterDepth'

const luma = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

describe('the depth\'s encoding', () => {
  it('runs 0 to 255 over 0 to WATER_DEPTH_MAX, monotonically, and round trips', () => {
    expect(encodeWaterDepth(0)).toBe(0)
    expect(encodeWaterDepth(-50)).toBe(0)
    expect(encodeWaterDepth(WATER_DEPTH_MAX)).toBe(255)
    expect(encodeWaterDepth(2 * WATER_DEPTH_MAX)).toBe(255)
    let last = 0
    for (let m = 0; m <= WATER_DEPTH_MAX; m += 10) {
      const level = encodeWaterDepth(m)
      expect(level).toBeGreaterThanOrEqual(last)
      last = level
    }
    for (let level = 0; level <= 255; level++) expect(encodeWaterDepth(decodeWaterDepth(level))).toBe(level)
  })

  it('gives the shallows the finer steps', () => {
    expect(decodeWaterDepth(1)).toBeLessThan(0.2)
    expect(decodeWaterDepth(20) - decodeWaterDepth(19)).toBeLessThan(7)
  })
})

describe('the tint', () => {
  it('runs from the shallows\' gain through the shelf\'s and deep water\'s to the trenches\'', () => {
    waterTint(0).forEach((x, i) => expect(x).toBeCloseTo(WATER_TINT_SHALLOW[i], 12))
    for (const d of [WATER_DEPTH_SHOAL, WATER_DEPTH_SHELF]) waterTint(d).forEach((x, i) => expect(x).toBeCloseTo(WATER_TINT_SHELF[i], 12))
    waterTint(9000).forEach((x, i) => expect(x).toBeCloseTo(WATER_TINT_TRENCH[i], 12))
    waterTint(11000).forEach((x, i) => expect(x).toBeCloseTo(WATER_TINT_TRENCH[i], 12))
  })

  it('gives the open ocean and the neutral fill deep water\'s gain', () => {
    for (let d = WATER_DEPTH_SLOPE; d <= 5500; d += 250) expect(waterTint(d)).toEqual([...WATER_TINT_DEEP])
    expect(waterTint(decodeWaterDepth(encodeWaterDepth(WATER_DEPTH_NEUTRAL)))).toEqual([...WATER_TINT_DEEP])
  })

  it('never lightens with depth, and turns greener toward the shallows', () => {
    let last = Infinity
    for (let d = 0; d <= WATER_DEPTH_MAX; d += 25) {
      const l = luma(waterTint(d))
      expect(l).toBeLessThanOrEqual(last + 1e-15)
      last = l
    }
    const greenOverBlue = (g: readonly number[]) => g[1] / g[2]
    expect(greenOverBlue(WATER_TINT_SHALLOW)).toBeGreaterThan(greenOverBlue(WATER_TINT_SHELF))
    expect(greenOverBlue(WATER_TINT_SHELF)).toBeGreaterThan(greenOverBlue(WATER_TINT_DEEP))
  })

  it('tints the map\'s open-sea blue, and leaves map colour well lighter than it alone', () => {
    const sea = [0.012, 0.09, 0.16] as const
    waterTinted(sea, 3000).forEach((x, i) => expect(x).toBeCloseTo(sea[i] * WATER_TINT_DEEP[i], 12))
    expect(luma(waterTinted(sea, 20))).toBeGreaterThan(luma(sea))
    expect(luma(waterTinted(sea, 8000))).toBeLessThan(luma(waterTinted(sea, 3000)))
    const bank = [0.15, 0.2, 0.16] as const
    expect(luma(bank)).toBeGreaterThan(WATER_KEEP[1])
    for (const d of [0, 100, 3000, 10000]) waterTinted(bank, d).forEach((x, i) => expect(x).toBeCloseTo(bank[i], 12))
  })

  it('has its GLSL twin and each chain\'s sample', () => {
    expect(WATER_DEPTH_GLSL).toContain('uniform sampler2D uWaterDepth;')
    expect(WATER_DEPTH_GLSL).toContain('vec3 waterTint(float d)')
    expect(WATER_DEPTH_GLSL).toContain('vec3 waterTinted(vec3 c)')
    expect(WATER_DEPTH_SAMPLE.globe).toContain('#ifdef USE_SPECULARMAP')
    expect(WATER_DEPTH_SAMPLE.globe).toContain('texture2D(uWaterDepth, vSpecularMapUv).r')
    expect(WATER_DEPTH_SAMPLE.tiles).toContain('surfaceGlobeTex(uWaterDepth, surfaceGlobeUv).r')
  })
})


describe('the shipped depth maps', () => {
  const MAPS = [
    ['earth-bathy-4k.png', 4096, 2048, 2.5e6],
    ['earth-bathy-2k.png', 2048, 1024, 1e6],
  ] as const
  for (const [name, w, h, budget] of MAPS) {
    it(`${name}: ${w} x ${h} 8-bit grey, on the elevation map's grid`, () => {
      const url = new URL(`../assets/${name}`, import.meta.url)
      expect(statSync(url).size).toBeLessThan(budget)
      const png = decodeGreyPng(readFileSync(url))
      expect([png.width, png.height, png.depth, png.colour, png.interlace]).toEqual([w, h, 8, 0, 0])
      const at = (lat: number, lon: number) =>
        png.levels[Math.min(h - 1, Math.floor(((90 - lat) / 180) * h)) * w + Math.min(w - 1, Math.floor(((lon + 180) / 360) * w))]
      expect(at(11.35, 142.2), 'Challenger Deep').toBeGreaterThan(encodeWaterDepth(8000))
      expect(at(24.0, -77.8), 'Great Bahama Bank').toBeLessThan(encodeWaterDepth(30))
      expect(at(0, -150), 'mid-Pacific').toBeGreaterThanOrEqual(encodeWaterDepth(3500))
      expect(at(0, -150), 'mid-Pacific').toBeLessThanOrEqual(encodeWaterDepth(6000))
      expect(at(47.7, -87.5), 'Lake Superior').toBe(encodeWaterDepth(WATER_DEPTH_NEUTRAL))
      // The Caspian's depths below its own surface, not sea level's.
      expect(at(45.5, 50), 'north Caspian').toBeLessThanOrEqual(encodeWaterDepth(10))
      expect(at(38.5, 51.5), 'south Caspian').toBeGreaterThan(encodeWaterDepth(300))
    })
  }
})
