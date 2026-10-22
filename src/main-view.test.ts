import { describe, expect, it } from 'vitest'
import { OrthographicCamera } from 'three'
import {
  MAIN_ZOOM,
  focusedRef,
  mainViewRange,
  planetFramingZoom,
  planetsNear,
} from './main-view'
import { PLANETS } from './planets'

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
      minZoom: 0,
      starRadius: undefined,
    })
  })
})

describe('planetsNear', () => {
  // The eye sits OrbitControls' maxDistance (and CLOCK_VIEW.distance) behind
  // the target.
  const EYE = 80
  const EARTH = 2.95
  // Bodies sit within ~360 units of the Sun (Neptune's aphelion surface ~327).
  const SYSTEM_RADIUS = 360

  it('draws nothing behind the eye at the default zoom or any planet framing', () => {
    expect(planetsNear(MAIN_ZOOM, EYE)).toBe(0)
    for (const { key, radius } of Object.values(PLANETS)) {
      const zoom = planetFramingZoom(radius, EARTH)
      expect(planetsNear(zoom, EYE), key).toBe(0)
    }
  })

  it('reaches every body, wherever the target is, zoomed all the way out', () => {
    const { minZoom } = mainViewRange(true)
    expect(EYE - planetsNear(minZoom, EYE)).toBeGreaterThanOrEqual(
      2 * SYSTEM_RADIUS
    )
  })

  it('never reaches deeper than at the zoom floor', () => {
    const { minZoom } = mainViewRange(true)
    expect(planetsNear(minZoom / 4, EYE)).toBe(planetsNear(minZoom, EYE))
  })

  it('opens up steadily as the view zooms out', () => {
    let previous = 0
    for (let zoom = 40; zoom >= 1; zoom -= 0.25) {
      const near = planetsNear(zoom, EYE)
      expect(near).toBeLessThanOrEqual(previous)
      previous = near
    }
  })

  it('keeps the stars behind every drawn body and their back half clipped', () => {
    const { minZoom, starRadius } = mainViewRange(true)
    const R = starRadius!
    const near = planetsNear(minZoom, EYE)
    const far = new OrthographicCamera().far
    // Stars sit R from the eye. Within 45° of the view axis (an offset of
    // R·sin45 ≈ 1060 units, past the edge of a 2000 px wide view at minZoom)
    // the front ones lie behind the deepest body and the back ones before
    // the near plane.
    const cos45 = Math.SQRT1_2
    expect(R * cos45).toBeGreaterThan(EYE + 2 * SYSTEM_RADIUS)
    expect(-R * cos45).toBeLessThan(near)
    expect(R * cos45).toBeGreaterThan(2000 / 2 / minZoom)
    expect(far).toBeGreaterThanOrEqual(R)
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

  it('falls back to the Sun for a planet or moon that has not registered', () => {
    expect(focusedRef({ sun, moon }, 'neptune')).toBe(sun)
    expect(focusedRef({ sun, moon, saturn: { current: null } }, 'saturn')).toBe(sun)
    expect(focusedRef({ sun, moon }, 'titan')).toBe(sun)
  })

  it('does not swap an unregistered non-planet for the Sun', () => {
    expect(focusedRef({ sun }, 'earth')).toBeUndefined()
  })
})
