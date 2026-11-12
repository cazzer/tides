import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EARTH_RADIUS } from '../../ship/ship-bodies'
import { EARTH_RADIUS_KM } from '../../cloud-layer'
import { EARTH_KM_PER_UNIT, SURFACE_TOP, SURFACE_TOP_KM } from '../../surface-handover'
import {
  capCacheMarks,
  CPU_COPY_FACTOR,
  DESKTOP_SURFACE_BUDGET,
  pauseTileUpdates,
  surfaceMemoryBudget,
  TOUCH_SURFACE_BUDGET,
  updateSurfaceTiles,
  workingSetBytes,
} from './surface-budget'
import { CACHE_BYTES_AT_REFERENCE, surfaceDetail } from './surface-lod'
import { SURFACE_JOBS_PER_ORIGIN, SURFACE_PARSE_JOBS } from './surface-queues'

const GIGABYTE = 2 ** 30

describe('the surface memory budget (tides-8h7.5)', () => {
  it("is today's on desktops: the tiles' own queues, every bake waits, the view's marks, no pause", () => {
    expect(surfaceMemoryBudget(false)).toBe(DESKTOP_SURFACE_BUDGET)
    expect(DESKTOP_SURFACE_BUDGET).toEqual({
      jobsPerOrigin: SURFACE_JOBS_PER_ORIGIN,
      parseJobs: SURFACE_PARSE_JOBS,
      maxWaitingBakes: Infinity,
      cacheRealBytes: null,
      pauseAboveRange: false,
    })
  })

  it('is narrower on touch, with requests per server never under the parses (tides-zmw.9.25)', () => {
    const touch = surfaceMemoryBudget(true)
    expect(touch).toBe(TOUCH_SURFACE_BUDGET)
    expect(touch.parseJobs).toBeLessThan(SURFACE_PARSE_JOBS)
    expect(touch.jobsPerOrigin).toBeLessThan(SURFACE_JOBS_PER_ORIGIN)
    expect(touch.jobsPerOrigin).toBeGreaterThanOrEqual(touch.parseJobs)
    expect(Number.isFinite(touch.maxWaitingBakes)).toBe(true)
    expect(touch.pauseAboveRange).toBe(true)
  })

  describe('capCacheMarks', () => {
    const capped = (w: number, h: number) => capCacheMarks(surfaceDetail(w, h), TOUCH_SURFACE_BUDGET)

    it("holds a 390x844 phone's marks to 0.14/0.18 GiB counted (0.28/0.36 real)", () => {
      const view = surfaceDetail(390, 844).cache
      // the view alone would ask more than the cap
      expect(view.min).toBeGreaterThan(0.14 * GIGABYTE)
      expect(view.max).toBeGreaterThan(0.18 * GIGABYTE)
      const marks = capped(390, 844)
      expect(marks.min / GIGABYTE).toBeCloseTo(0.14, 9)
      expect(marks.max / GIGABYTE).toBeCloseTo(0.18, 9)
      expect(CPU_COPY_FACTOR).toBe(2)
    })

    it("scales a tablet's up by the square root of its pixels, as surface-lod's, its high mark over its working set", () => {
      for (const [w, h] of [[744, 1133], [1024, 1366]]) {
        const k = Math.sqrt((w * h) / (390 * 844))
        const marks = capped(w, h)
        const view = surfaceDetail(w, h).cache
        expect(marks.min / GIGABYTE).toBeCloseTo(0.14 * k, 9)
        expect(marks.max / GIGABYTE).toBeCloseTo(0.18 * k, 9)
        // still under the view's own marks
        expect(marks.min).toBeLessThan(view.min)
        expect(marks.max).toBeLessThan(view.max)
        // a refused tile is a coarser settled frame: the working set fits
        expect(marks.max).toBeGreaterThanOrEqual(workingSetBytes(w, h))
      }
      // iPad mini (744x1133) ~0.22/0.29, iPad Pro 12.9 (1024x1366) ~0.29/0.37 GiB counted
      expect(capped(744, 1133).max / GIGABYTE).toBeCloseTo(0.288, 3)
      expect(capped(1024, 1366).max / GIGABYTE).toBeCloseTo(0.371, 3)
    })

    it("takes the working set from surface-lod's model: ~1.15x under its low mark", () => {
      expect(CACHE_BYTES_AT_REFERENCE.min / workingSetBytes(1920, 1080)).toBeCloseTo(1.157, 2)
      expect(workingSetBytes(1024, 1366) / 1e6).toBeCloseTo(381, 0)
      expect(workingSetBytes(744, 1133) / 1e6).toBeCloseTo(296, 0)
    })

    it('never scales a small or empty view below the phone cap, nor min above max', () => {
      expect(capped(0, 0).max / GIGABYTE).toBeCloseTo(0.18, 9)
      expect(capped(200, 300).max / GIGABYTE).toBeCloseTo(0.18, 9)
      const tight = { ...TOUCH_SURFACE_BUDGET, cacheRealBytes: { min: 0.4 * GIGABYTE, max: 0.3 * GIGABYTE } }
      const marks = capCacheMarks(surfaceDetail(390, 844), tight)
      expect(marks.min).toBeLessThanOrEqual(marks.max)
      // the working set (0.172 GiB) over the cap (0.15)
      expect(marks.max).toBe(workingSetBytes(390, 844))
    })

    it('is a no-op on desktops, at every view size', () => {
      for (const [w, h] of [[0, 0], [390, 844], [1920, 1080], [3840, 2160]]) {
        const detail = surfaceDetail(w, h)
        expect(capCacheMarks(detail, DESKTOP_SURFACE_BUDGET)).toBe(detail.cache)
      }
    })
  })

  describe('pauseTileUpdates', () => {
    const top = 100

    it('pauses the system view on touch above the leave mark only', () => {
      expect(pauseTileUpdates(TOUCH_SURFACE_BUDGET, 'system', 210, top)).toBe(false)
      expect(pauseTileUpdates(TOUCH_SURFACE_BUDGET, 'system', 230, top)).toBe(true)
    })

    it("never pauses the ship's eye, or a desktop", () => {
      expect(pauseTileUpdates(TOUCH_SURFACE_BUDGET, 'ship', 230, top)).toBe(false)
      expect(pauseTileUpdates(DESKTOP_SURFACE_BUDGET, 'system', 230, top)).toBe(false)
    })
  })

  describe("updateSurfaceTiles (SurfaceTiles' frame)", () => {
    const counter = () => {
      const tiles = { calls: 0, update: () => void tiles.calls++ }
      return tiles
    }
    // the system view's eye as SurfaceTiles has it: its distance from Earth's centre, less EARTH_RADIUS
    const eyeAt = (tops: number) => EARTH_RADIUS + tops * SURFACE_TOP

    it("takes the system eye's altitude in SURFACE_TOP's units, scene units over EARTH_RADIUS", () => {
      expect(EARTH_RADIUS * EARTH_KM_PER_UNIT).toBeCloseTo(EARTH_RADIUS_KM, 6)
      expect(SURFACE_TOP * EARTH_KM_PER_UNIT).toBeCloseTo(SURFACE_TOP_KM, 9)
      const tiles = counter()
      expect(updateSurfaceTiles(tiles, TOUCH_SURFACE_BUDGET, 'system', eyeAt(2.1) - EARTH_RADIUS)).toBe(true)
      expect(updateSurfaceTiles(tiles, TOUCH_SURFACE_BUDGET, 'system', eyeAt(2.3) - EARTH_RADIUS)).toBe(false)
      expect(tiles.calls).toBe(1)
      // the same heights in km would read as far above the range
      expect(updateSurfaceTiles(tiles, TOUCH_SURFACE_BUDGET, 'system', 2.1 * SURFACE_TOP_KM)).toBe(false)
    })

    it('always updates on desktops and for the ship, whose altitude SurfaceTiles leaves at Infinity', () => {
      const tiles = counter()
      expect(updateSurfaceTiles(tiles, DESKTOP_SURFACE_BUDGET, 'system', 3 * SURFACE_TOP)).toBe(true)
      expect(updateSurfaceTiles(tiles, TOUCH_SURFACE_BUDGET, 'ship', Infinity)).toBe(true)
      expect(tiles.calls).toBe(2)
    })

    it("is SurfaceTiles' only path to tiles.update()", () => {
      const source = readFileSync(path.resolve(process.cwd(), 'src/renderers/surface/SurfaceTiles.tsx'), 'utf8')
      expect(source).not.toMatch(/tiles\.update\(\)/)
      expect(source).toMatch(/updateSurfaceTiles\(tiles, memory, eye, altitude\)/)
      expect(source).toMatch(/altitude = eyeR - EARTH_RADIUS/)
    })
  })
})
