import { describe, expect, it } from 'vitest'
import { GLARE_FADE_PX } from '../glare-geometry'
import { sunDiscPx, sunGlowWeight } from './sun-glow'

const view = (distance: number) => ({
  distance,
  radius: 1,
  projectionYY: 1 / Math.tan(Math.PI / 6), // 60 deg vertical FOV
  isPerspective: true,
  viewHeightPx: 900,
  fadePx: GLARE_FADE_PX,
})

// SunGlare's alpha before its distance strength: 1 - smoothstep(fade, disc).
function glareShare(distance: number): number {
  const disc = sunDiscPx(view(distance))
  const t = Math.min(Math.max((disc - GLARE_FADE_PX[0]) / (GLARE_FADE_PX[1] - GLARE_FADE_PX[0]), 0), 1)
  return 1 - t * t * (3 - 2 * t)
}

describe('sunGlowWeight', () => {
  it('is 0 while the disc is a few px (the glare has it) and 1 once it is large', () => {
    expect(sunGlowWeight(view(1e5))).toBe(0)
    expect(sunGlowWeight(view(5))).toBe(1)
  })
  it('hands over with SunGlare: the two shares sum to 1 at every distance', () => {
    for (const d of [10, 20, 30, 40, 60, 80, 120, 1000]) {
      expect(sunGlowWeight(view(d)) + glareShare(d)).toBeCloseTo(1, 10)
    }
  })
  it('is full from inside the Sun and in an orthographic view', () => {
    expect(sunGlowWeight(view(0.5))).toBe(1)
    expect(sunGlowWeight({ ...view(1e5), isPerspective: false })).toBe(1)
  })
})
