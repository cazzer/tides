import { describe, expect, test } from 'vitest'
import { V_NORMAL } from './flight'
import { IMPACT_FOV_PUNCH, IMPACT_FOV_TAU, impactFovPunch, isImpact } from './impact'

describe('impact', () => {
  test('a new hit coming in fast; not a landing at the floor, nor a held contact', () => {
    expect(isImpact(true, false, 10)).toBe(true)
    expect(isImpact(true, false, V_NORMAL)).toBe(false)
    expect(isImpact(true, true, 10)).toBe(false)
    expect(isImpact(false, false, 10)).toBe(false)
  })

  test('the FOV punch starts at full and decays away', () => {
    expect(impactFovPunch(0)).toBe(IMPACT_FOV_PUNCH)
    expect(impactFovPunch(IMPACT_FOV_TAU)).toBeCloseTo(IMPACT_FOV_PUNCH / Math.E)
    expect(Math.abs(impactFovPunch(1))).toBeLessThan(0.01)
    expect(Math.abs(impactFovPunch(Infinity))).toBe(0)
    expect(impactFovPunch(-1)).toBe(0)
    expect(impactFovPunch(NaN)).toBe(0)
  })
})
