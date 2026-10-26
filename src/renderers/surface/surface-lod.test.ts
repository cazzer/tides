import { describe, expect, it } from 'vitest'
import {
  FALL_SECONDS,
  MAX_ERROR_TARGET,
  RATE_HIGH,
  RATE_LOW,
  RISE_SECONDS,
  smoothErrorTarget,
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

  it('ramps log-linearly to 4 by 0.5/s and stays there', () => {
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
