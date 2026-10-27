import { describe, expect, test } from 'vitest'
import { FALL_SECONDS, RATE_HIGH, RISE_SECONDS } from '../renderers/surface/surface-lod'
import {
  BLUR_EPSILON,
  BLUR_FALL_TAU,
  BLUR_MAX_PX,
  BLUR_RISE_TAU,
  BLUR_SWEEP_HIGH,
  BLUR_SWEEP_LOW,
  blurFilter,
  blurSweepShare,
  blurTarget,
  easeBlur,
} from './speed-blur'

const FRAME = 1 / 60

describe('speed blur target', () => {
  test('none unboosted, with the spool at 0, or under reduced motion, however fast the ground sweeps', () => {
    for (const sweep of [0, BLUR_SWEEP_LOW, RATE_HIGH, 10 * RATE_HIGH]) {
      expect(blurTarget(sweep, 1, false)).toBe(0)
      expect(blurTarget(sweep, 0, true)).toBe(0)
      expect(blurTarget(sweep, 1, true, true)).toBe(0)
    }
    expect(blurTarget(RATE_HIGH, 1, true)).toBe(BLUR_MAX_PX)
  })

  test('none at or under BLUR_SWEEP_LOW, full from BLUR_SWEEP_HIGH, the tiles coarsest', () => {
    expect(BLUR_SWEEP_HIGH).toBe(RATE_HIGH)
    for (const sweep of [-1, 0, 0.5 * BLUR_SWEEP_LOW, BLUR_SWEEP_LOW]) expect(blurSweepShare(sweep)).toBe(0)
    for (const sweep of [BLUR_SWEEP_HIGH, 2 * BLUR_SWEEP_HIGH, Infinity]) expect(blurSweepShare(sweep)).toBe(1)
    // Halfway in log, half.
    expect(blurSweepShare(Math.sqrt(BLUR_SWEEP_LOW * BLUR_SWEEP_HIGH))).toBeCloseTo(0.5, 12)
  })

  test('rises with the spool and the sweep, never past BLUR_MAX_PX', () => {
    let previous = -1
    for (let sweep = 0; sweep <= 2 * BLUR_SWEEP_HIGH; sweep += 0.05) {
      const px = blurTarget(sweep, 1, true)
      expect(px).toBeGreaterThanOrEqual(previous)
      expect(px).toBeLessThanOrEqual(BLUR_MAX_PX)
      previous = px
    }
    previous = -1
    for (let spool = 0; spool <= 1 + 1e-9; spool += 0.05) {
      const px = blurTarget(BLUR_SWEEP_HIGH, spool, true)
      expect(px).toBeGreaterThanOrEqual(previous)
      previous = px
    }
    // Out-of-range spools clamp.
    expect(blurTarget(BLUR_SWEEP_HIGH, 2, true)).toBe(BLUR_MAX_PX)
    expect(blurTarget(BLUR_SWEEP_HIGH, -1, true)).toBe(0)
  })

  test('NaN-safe', () => {
    expect(blurSweepShare(NaN)).toBe(0)
    expect(blurTarget(NaN, 1, true)).toBe(0)
    expect(blurTarget(RATE_HIGH, NaN, true)).toBe(0)
    expect(easeBlur(NaN, 3, FRAME)).toBe(3)
    expect(easeBlur(Infinity, 0, FRAME)).toBe(0)
    expect(easeBlur(2, 4, NaN)).toBe(2)
    expect(blurFilter(NaN)).toBe('none')
    expect(blurFilter(Infinity)).toBe('none')
  })
})

describe('speed blur easing', () => {
  test("follows the tiles' own coarsening: their rise and fall time constants", () => {
    expect(BLUR_RISE_TAU).toBe(RISE_SECONDS)
    expect(BLUR_FALL_TAU).toBe(FALL_SECONDS)
    expect(easeBlur(0, BLUR_MAX_PX, BLUR_RISE_TAU)).toBeCloseTo(BLUR_MAX_PX * (1 - Math.exp(-1)), 12)
    expect(easeBlur(BLUR_MAX_PX, 1, BLUR_FALL_TAU)).toBeCloseTo(1 + (BLUR_MAX_PX - 1) * Math.exp(-1), 12)
    // A zero or negative step holds it.
    expect(easeBlur(2, 4, 0)).toBe(2)
    expect(easeBlur(2, 4, -1)).toBe(2)
  })

  test('snaps to 0 under BLUR_EPSILON easing out, and only toward 0', () => {
    let px = BLUR_MAX_PX
    let steps = 0
    while (px > 0 && steps < 60 * 60) {
      px = easeBlur(px, 0, FRAME)
      steps++
    }
    expect(px).toBe(0)
    // ~ln(6 / 0.05) fall time constants.
    expect(steps * FRAME).toBeCloseTo(BLUR_FALL_TAU * Math.log(BLUR_MAX_PX / BLUR_EPSILON), 0)
    expect(easeBlur(0.5 * BLUR_EPSILON, 0.01, FRAME)).toBeGreaterThan(0)
  })
})

describe('speed blur filter', () => {
  test("'none' when it rounds to 0, else blur() to a tenth of a px", () => {
    expect(blurFilter(0)).toBe('none')
    expect(blurFilter(0.04)).toBe('none')
    expect(blurFilter(-1)).toBe('none')
    expect(blurFilter(0.05)).toBe('blur(0.1px)')
    expect(blurFilter(2.345)).toBe('blur(2.3px)')
    expect(blurFilter(BLUR_MAX_PX)).toBe('blur(6.0px)')
    // Quantised: the style changes only when the drawn blur would.
    expect(blurFilter(2.31)).toBe(blurFilter(2.34))
  })
})
