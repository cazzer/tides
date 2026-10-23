import { describe, expect, it } from 'vitest'
import { OrthographicCamera } from 'three'
import {
  MAIN_ZOOM,
  PLANETS_MIN_ZOOM,
  SYSTEM_FIT_RADIUS,
  clearNear,
  focusedRef,
  mainViewRange,
  planetFramingZoom,
  planetsNear,
} from './main-view'
import { EARTH_ORBIT_RADIUS } from './ephemeris'
import { PLANETS, sceneDistance } from './planets'

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

const DESKTOP = { width: 1167, height: 830 }
const PHONE = { width: 390, height: 844 }

describe('mainViewRange', () => {
  it('leaves the planets-off view exactly as it was', () => {
    for (const view of [DESKTOP, PHONE]) {
      expect(mainViewRange(false, view)).toEqual({
        minZoom: 0,
        starRadius: undefined,
      })
    }
  })

  it('frames the whole system across the shorter side at the zoom floor', () => {
    for (const view of [DESKTOP, PHONE]) {
      const { minZoom } = mainViewRange(true, view)
      const shorter = Math.min(view.width, view.height) / minZoom
      expect(shorter).toBeGreaterThanOrEqual(2 * SYSTEM_FIT_RADIUS)
    }
    // Neptune's aphelion (~30.3 AU over 1900–2100) and its sphere, on the
    // far side of the Sun from an Earth target.
    expect(SYSTEM_FIT_RADIUS).toBeGreaterThan(
      EARTH_ORBIT_RADIUS + sceneDistance(30.4) + PLANETS.neptune.radius
    )
  })

  it('zooms a large view out no further than PLANETS_MIN_ZOOM', () => {
    expect(mainViewRange(true, { width: 2000, height: 1200 }).minZoom).toBe(
      PLANETS_MIN_ZOOM
    )
    expect(mainViewRange(true, PHONE).minZoom).toBeLessThan(PLANETS_MIN_ZOOM)
  })
})

describe('planetsNear', () => {
  // The eye sits OrbitControls' maxDistance (and CLOCK_VIEW.distance) behind
  // the target.
  const EYE = 80
  const EARTH = 2.95
  // Bodies sit within ~470 units of the Sun (Neptune's aphelion surface ~456).
  const SYSTEM_RADIUS = 470

  it('draws nothing behind the eye at the default zoom or any planet framing', () => {
    expect(planetsNear(MAIN_ZOOM, EYE)).toBe(0)
    for (const { key, radius } of Object.values(PLANETS)) {
      const zoom = planetFramingZoom(radius, EARTH)
      expect(planetsNear(zoom, EYE), key).toBe(0)
    }
  })

  it('reaches every body, wherever the target is, zoomed all the way out', () => {
    for (const view of [DESKTOP, PHONE]) {
      const { minZoom } = mainViewRange(true, view)
      expect(EYE - planetsNear(minZoom, EYE)).toBeGreaterThanOrEqual(
        2 * SYSTEM_RADIUS
      )
    }
  })

  it('never reaches deeper than at the zoom floor', () => {
    expect(planetsNear(PLANETS_MIN_ZOOM / 4, EYE)).toBe(
      planetsNear(PLANETS_MIN_ZOOM, EYE)
    )
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
    const far = new OrthographicCamera().far
    // Stars sit R from the eye. Within 45° of the view axis (an offset of
    // R·sin45 ≈ 1270 units, past the edges of a 2000 px wide view or a
    // phone at the zoom floor) the front ones lie behind the deepest body
    // and the back ones before the near plane.
    const cos45 = Math.SQRT1_2
    for (const view of [{ width: 2000, height: 1200 }, PHONE]) {
      const { minZoom, starRadius } = mainViewRange(true, view)
      const R = starRadius!
      const near = planetsNear(minZoom, EYE)
      const longer = Math.max(view.width, view.height)
      expect(R * cos45).toBeGreaterThan(EYE + 2 * SYSTEM_RADIUS)
      expect(-R * cos45).toBeLessThan(near)
      expect(R * cos45).toBeGreaterThan(longer / 2 / minZoom)
      expect(far).toBeGreaterThanOrEqual(R)
    }
  })
})

describe('clearNear', () => {
  const EYE = 80
  const cuts = (near: number, { depth, reach }: { depth: number; reach: number }) =>
    depth - reach < near && near < depth + reach

  it('leaves a near plane that cuts nothing where it is', () => {
    const bodies = [{ depth: -40, reach: 3 }, { depth: 20, reach: 6 }]
    expect(clearNear(-10, bodies, EYE)).toBe(-10)
    expect(clearNear(0, [], EYE)).toBe(0)
  })

  it('never slices a body as the view zooms out (tides-o63)', () => {
    // Focused on Venus, Oct 2026: Jupiter 84.5 units behind the eye was cut
    // open as planetsNear swept through it (now from zoom ~2.52 to ~2.42).
    const jupiter = { depth: -84.46, reach: PLANETS.jupiter.radius }
    expect(cuts(planetsNear(2.45, EYE), jupiter)).toBe(true)
    for (let zoom = 40; zoom >= 1; zoom -= 0.005) {
      const near = clearNear(planetsNear(zoom, EYE), [jupiter], EYE)
      expect(cuts(near, jupiter), `zoom ${zoom}`).toBe(false)
    }
  })

  it('hides a body it would cut by stepping to its far side', () => {
    expect(clearNear(-85, [{ depth: -84, reach: 6 }], EYE)).toBe(-78)
  })

  it('steps through bodies that overlap in depth', () => {
    const bodies = [{ depth: -70, reach: 5 }, { depth: -78, reach: 6 }]
    const near = clearNear(-80, bodies, EYE)
    expect(near).toBe(-65)
    for (const body of bodies) expect(cuts(near, body)).toBe(false)
  })

  it('never hides a body reaching the target', () => {
    // A Sun-sized body centred on the target, with the plane inside it.
    expect(clearNear(75, [{ depth: EYE, reach: 10 }], EYE)).toBe(75)
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
