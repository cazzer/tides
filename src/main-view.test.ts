import { describe, expect, it } from 'vitest'
import {
  MAIN_ZOOM,
  focusedRef,
  mainViewRange,
  planetFramingZoom,
} from './main-view'

describe('planetFramingZoom', () => {
  const EARTH = 2.95

  it('frames a planet the size of Earth at the default zoom', () => {
    expect(planetFramingZoom(EARTH, EARTH)).toBeCloseTo(MAIN_ZOOM, 12)
  })

  it('keeps zoom times radius equal to Earth at the default zoom', () => {
    expect(planetFramingZoom(6.5, EARTH) * 6.5).toBeCloseTo(MAIN_ZOOM * EARTH, 9)
    expect(planetFramingZoom(1.5, EARTH) * 1.5).toBeCloseTo(MAIN_ZOOM * EARTH, 9)
  })

  it('clamps very small and very large radii', () => {
    expect(planetFramingZoom(0.01, EARTH)).toBe(40)
    expect(planetFramingZoom(1000, EARTH)).toBe(1)
  })
})

describe('mainViewRange', () => {
  it('leaves the planets-off view exactly as it was', () => {
    expect(mainViewRange(false)).toEqual({
      near: 0,
      far: 2000,
      starRadius: undefined,
    })
  })

  it('keeps everything within Neptune range between the clip planes and in front of the stars', () => {
    const { near, far, starRadius } = mainViewRange(true)
    // Bodies sit within ~360 units of the Sun, the target too; the eye is at
    // most OrbitControls' maxDistance (80) behind the target.
    const extent = 2 * 360
    const eye = 80
    expect(near).toBeLessThan(5 - extent)
    expect(far).toBeGreaterThan(eye + extent)
    expect(far).toBeGreaterThanOrEqual(starRadius!)
    // Stars more than ~45° off the view axis are well off screen even zoomed
    // out to the whole system; inside that cone the front ones lie behind every
    // body and the back ones beyond the near plane.
    const cos45 = Math.SQRT1_2
    expect(starRadius! * cos45).toBeGreaterThan(eye + extent)
    expect(-starRadius! * cos45).toBeLessThan(near)
    expect(starRadius! * Math.sin(Math.PI / 4)).toBeGreaterThan(500)
  })
})

describe('focusedRef', () => {
  const sun = { current: 'sun' }
  const moon = { current: 'moon' }
  const jupiter = { current: 'jupiter' }

  it('returns the focused body ref', () => {
    expect(focusedRef({ sun, moon }, 'moon')).toBe(moon)
    expect(focusedRef({ sun, jupiter }, 'jupiter')).toBe(jupiter)
  })

  it('falls back to the Sun for a planet that has not registered', () => {
    expect(focusedRef({ sun, moon }, 'neptune')).toBe(sun)
    expect(focusedRef({ sun, moon, saturn: { current: null } }, 'saturn')).toBe(sun)
  })

  it('does not swap an unregistered non-planet for the Sun', () => {
    expect(focusedRef({ sun }, 'earth')).toBeUndefined()
  })
})
