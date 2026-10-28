import { afterEach, describe, expect, it, vi } from 'vitest'
import { EARTH_GAP_RATE } from '../../ship/ship-bodies'
import {
  CACHE_BYTES_AT_REFERENCE,
  CACHE_LOWER_DELAY_MS,
  cacheMarkSetter,
  EYE_LEAD_SECONDS,
  EYE_REACH_METRES,
  eyeMarginMetres,
  groundSpeed,
  CACHE_BYTES_FLOOR,
  DETAIL_PIXELS_MAX,
  FALL_SECONDS,
  MAX_ERROR_TARGET,
  RATE_HIGH,
  RATE_LOW,
  RISE_SECONDS,
  smoothErrorTarget,
  surfaceDetail,
  surfaceErrorTarget,
  sweepRate,
} from './surface-lod'

describe('surface errorTarget by sweep rate (tides-zmw.9.2)', () => {
  it('holds the base at rest and below the ramp, 1 on desktop and 2 on touch', () => {
    for (const rate of [0, RATE_LOW / 10, RATE_LOW, NaN]) {
      expect(surfaceErrorTarget(rate, false)).toBe(1)
      expect(surfaceErrorTarget(rate, true)).toBe(2)
    }
  })

  it('ramps log-linearly to 4 by RATE_HIGH and stays there', () => {
    const mid = Math.sqrt(RATE_LOW * RATE_HIGH)
    expect(surfaceErrorTarget(mid, false)).toBeCloseTo(2.5, 10)
    expect(surfaceErrorTarget(mid, true)).toBeCloseTo(3, 10)
    for (const rate of [RATE_HIGH, 5, Infinity]) {
      expect(surfaceErrorTarget(rate, false)).toBe(MAX_ERROR_TARGET)
      expect(surfaceErrorTarget(rate, true)).toBe(MAX_ERROR_TARGET)
    }
    let last = 0
    for (let r = RATE_LOW; r <= RATE_HIGH; r *= 1.1) {
      const t = surfaceErrorTarget(r, false)
      expect(t).toBeGreaterThanOrEqual(last)
      last = t
    }
  })

  it("spans the throttle range near the ground, where the speed law sweeps at EARTH_GAP_RATE x throttle (tides-zmw.9.22)", () => {
    const byThrottle = (throttle: number) => surfaceErrorTarget(EARTH_GAP_RATE * throttle, false)
    expect(byThrottle(0.1)).toBe(1)
    expect(byThrottle(0.25)).toBe(1)
    expect(byThrottle(0.5)).toBeCloseTo(2, 10)
    expect(byThrottle(1)).toBeCloseTo(3, 10)
    expect(byThrottle(1)).toBeLessThan(MAX_ERROR_TARGET)
    expect(surfaceErrorTarget(2, true)).toBeCloseTo(2 + 2 * (2 / 3), 10)
  })

  it("keeps the eye's margin at the floor's window, or a second's flight past it", () => {
    expect(EYE_REACH_METRES).toBeGreaterThan(20)
    expect(EYE_REACH_METRES).toBeLessThan(40)
    expect(eyeMarginMetres(0)).toBe(EYE_REACH_METRES)
    expect(eyeMarginMetres(NaN)).toBe(EYE_REACH_METRES)
    expect(eyeMarginMetres(150)).toBe(150 * EYE_LEAD_SECONDS)
    expect(eyeMarginMetres(-150)).toBe(150 * EYE_LEAD_SECONDS)
  })

  it('rises fast and falls slowly', () => {
    expect(smoothErrorTarget(NaN, 3, 0.016)).toBe(3)
    // one time constant covers 1 - 1/e of the way
    expect(smoothErrorTarget(1, 4, RISE_SECONDS)).toBeCloseTo(4 - 3 / Math.E, 10)
    expect(smoothErrorTarget(4, 1, FALL_SECONDS)).toBeCloseTo(1 + 3 / Math.E, 10)
    // 1 s of 60 fps frames: up ~96% of the way, down ~39%
    let up = 1
    let down = 4
    for (let i = 0; i < 60; i++) {
      up = smoothErrorTarget(up, 4, 1 / 60)
      down = smoothErrorTarget(down, 1, 1 / 60)
    }
    expect(up).toBeGreaterThan(3.8)
    expect(down).toBeGreaterThan(2.7)
    expect(smoothErrorTarget(2, 2, 1)).toBe(2)
  })

  it('reads the sweep rate over Earth only', () => {
    expect(sweepRate(0.02, { key: 'earth', surfaceDistance: 0.1 })).toBeCloseTo(0.2, 12)
    expect(sweepRate(0.02, { key: 'moon', surfaceDistance: 0.1 })).toBe(0)
    expect(sweepRate(0, { key: 'earth', surfaceDistance: 0 })).toBe(0)
    expect(sweepRate(0.01, { key: 'earth', surfaceDistance: 0 })).toBeGreaterThan(RATE_HIGH)
    expect(sweepRate(0.01, { key: null, surfaceDistance: Infinity })).toBe(0)
  })
})

describe('surface detail resolution and cache by view size (tides-zmw.9.24)', () => {
  const GB = 2 ** 30
  it('keeps the view up to 2560x1440 and scales the marks by the root of its pixels', () => {
    const hd = surfaceDetail(1920, 1080)
    expect(hd.width).toBe(1920)
    expect(hd.height).toBe(1080)
    expect(hd.cache).toEqual(CACHE_BYTES_AT_REFERENCE)
    const qhd = surfaceDetail(2560, 1440)
    expect(qhd.width).toBe(2560)
    expect(qhd.cache.max / GB).toBeCloseTo((CACHE_BYTES_AT_REFERENCE.max / GB) * (4 / 3), 10)
    const small = surfaceDetail(960, 600)
    expect(small.cache.max / GB).toBeCloseTo((CACHE_BYTES_AT_REFERENCE.max / GB) * Math.sqrt((960 * 600) / (1920 * 1080)), 10)
    // over the gorge stop's working set (248 MB at 960x600, 464 MB at 1080p): the low mark too
    expect(small.cache.min).toBeGreaterThan(248e6 * 1.1)
    expect(hd.cache.min).toBeGreaterThan(464e6 * 1.1)
    expect(hd.cache.max).toBeGreaterThan(hd.cache.min * 1.2)
  })

  it('scales a larger view down to DETAIL_PIXELS_MAX at its aspect, the marks capped with it', () => {
    const uhd = surfaceDetail(3840, 2160)
    expect(uhd.width * uhd.height).toBeCloseTo(DETAIL_PIXELS_MAX, 3)
    expect(uhd.width / uhd.height).toBeCloseTo(16 / 9, 10)
    expect(uhd.cache).toEqual(surfaceDetail(2560, 1440).cache)
    const wide = surfaceDetail(6000, 1000)
    expect(wide.width / wide.height).toBeCloseTo(6, 10)
    expect(wide.width * wide.height).toBeCloseTo(DETAIL_PIXELS_MAX, 3)
  })

  it('never goes under the fixed marks, and takes an empty view', () => {
    for (const [w, h] of [[320, 240], [0, 0], [-5, 100], [NaN, 600]]) {
      const d = surfaceDetail(w, h)
      expect(d.cache).toEqual(CACHE_BYTES_FLOOR)
      expect(d.width).toBeGreaterThanOrEqual(0)
      expect(d.height).toBeGreaterThanOrEqual(0)
    }
    expect(surfaceDetail(NaN, 600)).toMatchObject({ width: 0, height: 600 })
    expect(surfaceDetail(-5, 100)).toMatchObject({ width: 0, height: 100 })
  })
})

describe('the cache marks as the view changes (tides-zmw.9.24)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('raises them at once and lowers them only once the size has held', () => {
    vi.useFakeTimers()
    const applied: { min: number; max: number }[] = []
    const marks = cacheMarkSetter((m) => applied.push(m))
    marks.set({ min: 2, max: 3 })
    marks.set({ min: 4, max: 6 })
    expect(applied).toEqual([{ min: 2, max: 3 }, { min: 4, max: 6 }])
    // a drag down: nothing falls while it moves
    marks.set({ min: 3, max: 5 })
    vi.advanceTimersByTime(CACHE_LOWER_DELAY_MS / 2)
    marks.set({ min: 1, max: 2 })
    vi.advanceTimersByTime(CACHE_LOWER_DELAY_MS - 1)
    expect(applied).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(applied[2]).toEqual({ min: 1, max: 2 })
    // one mark up, one down: the rise now, the fall later
    marks.set({ min: 0.5, max: 4 })
    expect(applied[3]).toEqual({ min: 1, max: 4 })
    vi.advanceTimersByTime(CACHE_LOWER_DELAY_MS)
    expect(applied[4]).toEqual({ min: 0.5, max: 4 })
    // a size back where it was cancels the fall
    marks.set({ min: 0.1, max: 1 })
    marks.set({ min: 0.5, max: 4 })
    vi.advanceTimersByTime(2 * CACHE_LOWER_DELAY_MS)
    expect(applied).toHaveLength(5)
  })

  it('drops a pending fall on dispose', () => {
    vi.useFakeTimers()
    const apply = vi.fn()
    const marks = cacheMarkSetter(apply)
    marks.set({ min: 4, max: 6 })
    marks.set({ min: 1, max: 2 })
    marks.dispose()
    vi.advanceTimersByTime(2 * CACHE_LOWER_DELAY_MS)
    expect(apply).toHaveBeenCalledTimes(1)
  })
})

describe('groundSpeed', () => {
  it('is the distance between frames over the frame time', () => {
    expect(groundSpeed({ x: 1, y: 2, z: 3 }, { x: 4, y: 6, z: 3 }, 0.5)).toBeCloseTo(10, 12)
    expect(groundSpeed({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 }, 0.016)).toBe(0)
  })

  it('is 0 without a previous position or a positive frame time', () => {
    expect(groundSpeed(null, { x: 4, y: 6, z: 3 }, 0.016)).toBe(0)
    expect(groundSpeed({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 0)).toBe(0)
    expect(groundSpeed({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, -1)).toBe(0)
  })
})
