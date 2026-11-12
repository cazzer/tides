import { describe, expect, it } from 'vitest'
import {
  capCacheMarks,
  CPU_COPY_FACTOR,
  DESKTOP_SURFACE_BUDGET,
  pauseTileUpdates,
  surfaceMemoryBudget,
  TOUCH_SURFACE_BUDGET,
} from './surface-budget'
import { surfaceDetail } from './surface-lod'
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

  it("holds a 390x844 phone's marks to 0.14/0.18 GiB counted (0.28/0.36 real)", () => {
    const view = surfaceDetail(390, 844).cache
    // the view alone would ask more than the cap
    expect(view.min).toBeGreaterThan(0.14 * GIGABYTE)
    expect(view.max).toBeGreaterThan(0.18 * GIGABYTE)
    const marks = capCacheMarks(view, TOUCH_SURFACE_BUDGET)
    expect(marks.min / GIGABYTE).toBeCloseTo(0.14, 9)
    expect(marks.max / GIGABYTE).toBeCloseTo(0.18, 9)
    expect(CPU_COPY_FACTOR).toBe(2)
  })

  it('leaves marks under the cap as they are, and never puts min above max', () => {
    expect(capCacheMarks({ min: 0.1 * GIGABYTE, max: 0.12 * GIGABYTE }, TOUCH_SURFACE_BUDGET)).toEqual({
      min: 0.1 * GIGABYTE,
      max: 0.12 * GIGABYTE,
    })
    const tight = { ...TOUCH_SURFACE_BUDGET, cacheRealBytes: { min: 0.4 * GIGABYTE, max: 0.3 * GIGABYTE } }
    const marks = capCacheMarks({ min: 0.5 * GIGABYTE, max: 0.6 * GIGABYTE }, tight)
    expect(marks.min).toBeLessThanOrEqual(marks.max)
    expect(marks.max).toBe(0.15 * GIGABYTE)
  })

  it('is a no-op on desktops, at every view size', () => {
    for (const [w, h] of [[0, 0], [390, 844], [1920, 1080], [3840, 2160]]) {
      const view = surfaceDetail(w, h).cache
      expect(capCacheMarks(view, DESKTOP_SURFACE_BUDGET)).toBe(view)
    }
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
})
