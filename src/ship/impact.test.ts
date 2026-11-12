import { describe, expect, test } from 'vitest'
import { V_NORMAL } from './flight'
import { IMPACT_BACKSTOP_SPEED, IMPACT_FOV_PUNCH, IMPACT_FOV_TAU, impactFovPunch, isImpact } from './impact'

describe('impact', () => {
  test('a new hit reaching the backstop fast; not one just reaching it, nor a held contact', () => {
    expect(isImpact(true, false, V_NORMAL)).toBe(true)
    expect(isImpact(true, false, IMPACT_BACKSTOP_SPEED)).toBe(false)
    expect(isImpact(true, false, 0.1 * V_NORMAL)).toBe(false)
    expect(isImpact(true, true, V_NORMAL)).toBe(false)
    expect(isImpact(false, false, V_NORMAL)).toBe(false)
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
