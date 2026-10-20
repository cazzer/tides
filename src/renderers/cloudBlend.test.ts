import { describe, expect, test } from 'vitest'
import { FADE_MS, planBlendPass, type BlendPassState } from './cloudBlend'

/** State after a first output whose fade had finished by wall 0. */
function settled(a: string, b: string, mix: number): BlendPassState {
  const first = planBlendPass(null, { a, b, mix }, -FADE_MS).state
  return planBlendPass(first, { a, b, mix }, 0).state
}

describe('planBlendPass', () => {
  test('the first output swaps and fades in over FADE_MS', () => {
    const first = planBlendPass(null, { a: '1', b: '2', mix: 0.2 }, 0)
    expect(first.pass).toEqual({ swap: true, fade: 0 })
    let state = first.state
    let fade = 0
    for (let wall = 16; wall <= FADE_MS; wall += 16) {
      const r = planBlendPass(state, { a: '1', b: '2', mix: 0.2 }, wall)
      state = r.state
      if (r.pass) {
        expect(r.pass.swap).toBe(false)
        expect(r.pass.fade).toBeGreaterThanOrEqual(fade)
        fade = r.pass.fade
      }
    }
    expect(Math.round(fade * 255)).toBe(255)
    const end = planBlendPass(first.state, { a: '1', b: '2', mix: 0.2 }, FADE_MS)
    expect(end.pass).toEqual({ swap: false, fade: 1 })
  })

  test('a small step in mix draws without a swap', () => {
    const r = planBlendPass(settled('1', '2', 0.2), { a: '1', b: '2', mix: 0.25 }, 1000)
    expect(r.pass).toEqual({ swap: false, fade: 1 })
  })

  test('no pass while nothing changes in 8 bits', () => {
    const r = planBlendPass(settled('1', '2', 0.2), { a: '1', b: '2', mix: 0.2001 }, 1000)
    expect(r.pass).toBeNull()
  })

  test('a second call in the same frame draws nothing', () => {
    const first = planBlendPass(settled('1', '2', 0.2), { a: '1', b: '2', mix: 0.3 }, 1000)
    expect(first.pass).not.toBeNull()
    expect(planBlendPass(first.state, { a: '1', b: '2', mix: 0.3 }, 1000).pass).toBeNull()
  })

  test('moving on to the next pair is no discontinuity', () => {
    const r = planBlendPass(settled('1', '2', 0.97), { a: '2', b: '3', mix: 0.02 }, 1000)
    expect(r.pass).toEqual({ swap: false, fade: 1 })
  })

  test('a late frame, a jump or a big step swaps and fades', () => {
    const late = planBlendPass(settled('1', '1', 0), { a: '1', b: '2', mix: 0.5 }, 1000)
    expect(late.pass).toEqual({ swap: true, fade: 0 })
    const jump = planBlendPass(settled('1', '2', 0.5), { a: '7', b: '8', mix: 0.5 }, 1000)
    expect(jump.pass).toEqual({ swap: true, fade: 0 })
    const step = planBlendPass(settled('1', '2', 0.2), { a: '1', b: '2', mix: 0.6 }, 1000)
    expect(step.pass).toEqual({ swap: true, fade: 0 })
    const halfway = planBlendPass(step.state, { a: '1', b: '2', mix: 0.6 }, 1000 + FADE_MS / 2)
    expect(halfway.pass).toEqual({ swap: false, fade: 0.5 })
  })
})
