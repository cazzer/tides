// The waves bent toward shallow water (tides-nh8.3): the dispersion's speed
// ratio, Snell's turn, the sea floor under the eye from the depth map, and
// the shipped map's shelves.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { latLonToLocal } from '../aurora'
import { decodeGreyPng } from './grey-png-fixture'
import { encodeWaterDepth } from './waterDepth'
import { refractHeading, seaFloor, shallowRatio, WATER_REFRACT_GRADE, type DepthGrid, type SeaFloor } from './waterRefraction'

const RAD = Math.PI / 180
type V = [number, number, number]
const local = (lat: number, lon: number) => latLonToLocal(lat, lon).toArray() as V
const gap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))

describe('shallowRatio', () => {
  it('is 1 in deep water and sqrt(k0 h) in shallow, falling with depth between', () => {
    expect(shallowRatio(120, 4000)).toBe(1)
    expect(shallowRatio(120, 60)).toBeGreaterThan(0.99)
    const k0 = (2 * Math.PI) / 120
    expect(shallowRatio(120, 1) / Math.sqrt(k0 * 1)).toBeCloseTo(1, 1)
    let last = 1
    for (let h = 100; h >= 1; h -= 1) {
      const r = shallowRatio(120, h)
      expect(r).toBeLessThanOrEqual(last + 1e-12)
      last = r
    }
    // A shorter wave feels the same bottom less.
    expect(shallowRatio(30, 10)).toBeGreaterThan(shallowRatio(120, 10))
  })
})

describe('refractHeading', () => {
  const floor = (depth: number, grade = 5): SeaFloor => ({ depth, upslope: 90 * RAD, grade })

  it('turns a wave coming in at an angle toward head-on up the slope, as Snell has it', () => {
    const heading = 30 * RAD // 60 deg off the up-slope (east)
    const turned = refractHeading(heading, 120, floor(10))
    const psi = Math.asin(Math.sin(-60 * RAD) * shallowRatio(120, 10))
    expect(turned).toBeCloseTo(90 * RAD + psi, 9)
    expect(gap(turned, 90 * RAD)).toBeLessThan(gap(heading, 90 * RAD))
    // The same from the other side.
    expect(gap(refractHeading(150 * RAD, 120, floor(10)), 90 * RAD)).toBeCloseTo(gap(turned, 90 * RAD), 9)
  })

  it('leaves deep water, flat bottoms, and waves running along or away from the slope as they are', () => {
    expect(refractHeading(30 * RAD, 120, floor(3000))).toBe(30 * RAD)
    expect(refractHeading(30 * RAD, 120, floor(10, WATER_REFRACT_GRADE[0] / 2))).toBe(30 * RAD)
    expect(refractHeading(0, 120, floor(10))).toBe(0)
    expect(refractHeading(250 * RAD, 120, floor(10))).toBe(250 * RAD)
  })

  it('turns smoothly with the angle, through the fade toward running along the slope', () => {
    let last = refractHeading(90 * RAD, 120, floor(5))
    for (let deg = 89; deg >= -10; deg -= 0.5) {
      const turned = refractHeading(deg * RAD, 120, floor(5))
      expect(Math.abs(turned - last)).toBeLessThan(3 * RAD)
      last = turned
    }
  })
})

describe('seaFloor', () => {
  // A slope shoaling toward the east round longitude 0, 10 m a texel.
  const width = 360
  const height = 180
  const levels = new Uint8Array(width * height)
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) levels[j * width + i] = encodeWaterDepth(Math.min(Math.max(10 * (185 - i), 0), 400))
  const ramp: DepthGrid = { width, height, levels }

  it('finds the depth and the way up the slope', () => {
    const f = seaFloor(ramp, local(10, 0), 6371)
    expect(f.depth).toBeGreaterThan(45)
    expect(f.depth).toBeLessThan(65)
    expect(gap(f.upslope, 90 * RAD)).toBeLessThan(5 * RAD)
    // 10 m a texel of a degree at 10 deg, give or take the 8-bit encoding.
    const expected = 10 / ((2 * Math.PI * 6371 * Math.cos(10 * RAD)) / 360)
    expect(f.grade / expected).toBeGreaterThan(0.6)
    expect(f.grade / expected).toBeLessThan(1.4)
  })
})

describe('the shipped depth map\'s shelves', () => {
  const png = decodeGreyPng(readFileSync(new URL('../assets/earth-bathy-4k.png', import.meta.url)))
  const grid: DepthGrid = { width: png.width, height: png.height, levels: png.levels }

  it('turns the swell toward the shore on the shallow Dutch coast and at the Bahamas\' bank edge', () => {
    for (const [lat, lon, swell] of [[52.6, 4.4, 116], [25.6, -79.1, 155]]) {
      const f = seaFloor(grid, local(lat, lon), 6371)
      expect(f.depth).toBeLessThan(30)
      const turned = refractHeading(swell * RAD, 120, f)
      expect(gap(turned, f.upslope)).toBeLessThan(gap(swell * RAD, f.upslope) - 2 * RAD)
    }
  })

  it('leaves the open ocean alone', () => {
    const f = seaFloor(grid, local(30, -40), 6371)
    expect(f.depth).toBeGreaterThan(2000)
    expect(refractHeading(147 * RAD, 120, f)).toBe(147 * RAD)
  })
})
