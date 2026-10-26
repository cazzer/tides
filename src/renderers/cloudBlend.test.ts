import * as THREE from 'three'
import { describe, expect, test } from 'vitest'
import { FADE_MS, neutralTypeTexture, outputFlags, planBlendPass, typesOf, type BlendPassState } from './cloudBlend'

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

  test('the fade always ends with a pass at exactly 1', () => {
    const first = planBlendPass(null, { a: '1', b: '2', mix: 0.2 }, 0)
    const nearly = planBlendPass(first.state, { a: '1', b: '2', mix: 0.2 }, FADE_MS - 4)
    expect(Math.round((nearly.pass?.fade ?? 0) * 255)).toBe(255)
    const end = planBlendPass(nearly.state, { a: '1', b: '2', mix: 0.2 }, FADE_MS)
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

// The cloud-type grids (tides-tvr.4.1) blended alongside the frames.
describe('type grids', () => {
  const frame = (geo: boolean, typed: boolean) => ({ geo, typed })
  const none = { measured: false, typed: false }

  test('typed where either frame carries types', () => {
    expect(outputFlags(frame(true, true), frame(true, false), none, 1)).toEqual({ measured: true, typed: true })
    expect(outputFlags(frame(false, false), frame(false, true), none, 1)).toEqual({ measured: false, typed: true })
    // The static clouds and untyped frames: neither.
    expect(outputFlags(frame(false, false), frame(false, false), none, 1)).toEqual(none)
  })

  test('the frozen output counts until its fade ends', () => {
    const prev = { measured: true, typed: true }
    expect(outputFlags(frame(false, false), frame(false, false), prev, 0.5)).toEqual(prev)
    expect(outputFlags(frame(false, false), frame(false, false), prev, 1)).toEqual(none)
  })

  test("a frame's types are in userData.types; the static clouds have none", () => {
    const types = new THREE.DataTexture(new Uint8Array(4), 1, 1)
    const typed = new THREE.Texture()
    typed.userData.types = types
    expect(typesOf(typed)).toBe(types)
    expect(typesOf(new THREE.Texture())).toBeNull()
    const untyped = new THREE.Texture()
    untyped.userData.types = null
    expect(typesOf(untyped)).toBeNull()
  })

  test('the neutral grid is one texel of confidence 0, shared', () => {
    const neutral = neutralTypeTexture()
    expect([neutral.image.width, neutral.image.height]).toEqual([1, 1])
    expect([...(neutral.image.data as Uint8Array)]).toEqual([0, 0, 0, 0])
    expect(neutral.colorSpace).toBe(THREE.NoColorSpace)
    expect(neutralTypeTexture()).toBe(neutral)
  })
})
