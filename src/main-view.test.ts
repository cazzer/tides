import { describe, expect, it } from 'vitest'
import {
  MAIN_DISTANCE,
  MAIN_FOV,
  MAIN_ZOOM,
  PLANETS_STAR_RADIUS,
  REFERENCE_VIEW_HEIGHT,
  SYSTEM_EXTENT,
  SYSTEM_FIT_RADIUS,
  focusedRef,
  framingDistance,
  mainNearFar,
  mainViewRange,
  minDistance,
  planetFramingZoom,
  systemFitDistance,
  targetUnitsPerPixel,
  zoomDistance,
} from './main-view'
import { CLOCK_VIEW } from './clock-view'
import { CLOUD_UNITS_PER_KM } from './cloud-layer'
import { EARTH_ORBIT_RADIUS } from './ephemeris'
import { CLOCK_HALF_WIDTH } from './orbit-label'
import { PLANETS, sceneDistance } from './planets'
import { FOCUS_VALUES, isSystemFocus, type CameraFocus } from './store'
import { bodyRadius } from './system-aids/label-visibility'

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
const TAN_HALF_FOV = Math.tan(((MAIN_FOV / 2) * Math.PI) / 180)
const EARTH = bodyRadius('earth')

// A sphere's radius on screen, CSS px, at `distance` in a view `height` tall.
const radiusPx = (radius: number, distance: number, height: number) =>
  ((radius / distance) * (height / 2)) / TAN_HALF_FOV

describe('zoomDistance and framingDistance', () => {
  it('frames Earth as large as the ortho view did at the default zoom', () => {
    expect(framingDistance(EARTH, EARTH)).toBeCloseTo(MAIN_DISTANCE, 9)
    expect(radiusPx(EARTH, MAIN_DISTANCE, REFERENCE_VIEW_HEIGHT)).toBeCloseTo(
      EARTH * MAIN_ZOOM,
      9
    )
    expect(radiusPx(EARTH, MAIN_DISTANCE, REFERENCE_VIEW_HEIGHT)).toBeCloseTo(29.5, 1)
  })

  it('frames each planet as large as Earth, within the zoom clamps', () => {
    for (const { key, radius } of Object.values(PLANETS)) {
      expect(radius / framingDistance(radius, EARTH), key).toBeCloseTo(
        EARTH / MAIN_DISTANCE,
        9
      )
    }
  })

  it('spans the old zoom’s units per pixel at the target', () => {
    for (const zoom of [1, MAIN_ZOOM, 40]) {
      expect(
        targetUnitsPerPixel(zoomDistance(zoom), REFERENCE_VIEW_HEIGHT)
      ).toBeCloseTo(1 / zoom, 12)
    }
  })
})

const SYSTEM_FOCI = FOCUS_VALUES.filter(
  (focus): focus is Exclude<CameraFocus, 'clock' | 'location'> =>
    focus !== 'clock' && focus !== 'location'
)

describe('minDistance', () => {
  it('lets every focus reach its framing, and the framing stay in range', () => {
    const { maxDistance } = mainViewRange(true, DESKTOP)
    for (const focus of SYSTEM_FOCI) {
      const framing = isSystemFocus(focus)
        ? framingDistance(bodyRadius(focus), EARTH)
        : MAIN_DISTANCE
      expect(framing, focus).toBeGreaterThan(minDistance(focus))
      expect(framing, focus).toBeLessThan(maxDistance)
    }
    expect(CLOCK_VIEW.distance).toBeGreaterThan(minDistance('clock'))
  })

  it('keeps the eye outside the focused body', () => {
    for (const focus of SYSTEM_FOCI) {
      expect(minDistance(focus), focus).toBeGreaterThan(1.3 * bodyRadius(focus))
    }
    // From a target on Earth's surface, straight above it.
    expect(minDistance('location') - EARTH).toBeCloseTo(minDistance('earth'), 12)
    expect(minDistance('clock')).toBe(2 * CLOCK_HALF_WIDTH)
  })
})

describe('mainViewRange', () => {
  it('leaves the planets-off view exactly as it was', () => {
    for (const view of [DESKTOP, PHONE]) {
      expect(mainViewRange(false, view)).toEqual({
        maxDistance: Infinity,
        starRadius: undefined,
      })
    }
  })

  it('frames the whole system across the shorter side at the distance limit', () => {
    for (const view of [DESKTOP, PHONE, { width: 2000, height: 1200 }]) {
      const { maxDistance } = mainViewRange(true, view)
      const halfAngle = Math.atan(
        (TAN_HALF_FOV * Math.min(view.width, view.height)) / view.height
      )
      expect(Math.asin(SYSTEM_FIT_RADIUS / maxDistance)).toBeCloseTo(halfAngle, 12)
    }
    expect(systemFitDistance(PHONE)).toBeGreaterThan(systemFitDistance(DESKTOP))
    // Neptune's aphelion (~30.3 AU over 1900–2100) and its sphere, on the
    // far side of the Sun from an Earth target.
    expect(SYSTEM_FIT_RADIUS).toBeGreaterThan(
      EARTH_ORBIT_RADIUS + sceneDistance(30.4) + PLANETS.neptune.radius
    )
  })
})

describe('mainNearFar', () => {
  // 24-bit depth resolution, scene units, `depth` in front of the eye.
  const depthStep = (near: number, far: number, depth: number) =>
    (depth * depth * (far - near)) / (far * near * 2 ** 24)

  it('never puts the near plane past the nearest surface', () => {
    for (let surface = 0.02; surface < 1e4; surface *= 1.1) {
      const { near } = mainNearFar(surface, 0)
      expect(near).toBeLessThan(surface)
      expect(near).toBeGreaterThan(0)
    }
  })

  it('reaches past the whole system and the stars from any eye', () => {
    for (const view of [DESKTOP, PHONE]) {
      const { maxDistance, starRadius } = mainViewRange(true, view)
      const eyeFromSun = maxDistance + SYSTEM_FIT_RADIUS
      const { far } = mainNearFar(1000, eyeFromSun)
      expect(far).toBeGreaterThanOrEqual(eyeFromSun + SYSTEM_EXTENT)
      expect(far).toBeGreaterThan(starRadius!)
    }
    expect(mainNearFar(1, 0).far).toBeGreaterThan(PLANETS_STAR_RADIUS)
    // Neptune's aphelion surface; the Kuiper belt's edge is belt-particles.test.ts'.
    expect(SYSTEM_EXTENT).toBeGreaterThan(sceneDistance(30.4) + PLANETS.neptune.radius)
  })

  it('resolves 10 m of cloud height at an Earth close-up', () => {
    const tenMetres = CLOUD_UNITS_PER_KM / 100
    const atmosphere = 1.1 * EARTH
    // Straight down at the closest distance...
    const eye = minDistance('earth')
    const down = mainNearFar(eye - atmosphere, EARTH_ORBIT_RADIUS)
    expect(depthStep(down.near, down.far, eye - EARTH)).toBeLessThan(tenMetres)
    // ...and tilted all the way, to ~1.115 radii, looking at the horizon.
    const tilted = 1.115 * EARTH
    const horizon = Math.sqrt(tilted ** 2 - EARTH ** 2)
    const flat = mainNearFar(tilted - atmosphere, EARTH_ORBIT_RADIUS)
    expect(depthStep(flat.near, flat.far, horizon)).toBeLessThan(tenMetres)
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
