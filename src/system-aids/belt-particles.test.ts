import { describe, expect, it } from 'vitest'
import { sceneDistance } from '../planets'
import { PLANETS_MIN_ZOOM, mainViewRange, planetsDrawDepth } from '../main-view'
import { SHELL_NEAR_RADIUS } from '../renderers/starDepth'
import {
  ASTEROID_A_AU,
  ASTEROID_COUNT,
  KUIPER_A_AU,
  KUIPER_COUNT,
  ORBIT_STRIDE,
  SHAPE_STRIDE,
  asteroidBelt,
  beltPosition,
  kuiperBelt,
  meanMotion,
  yearsSinceJ2000,
  type BeltOrbits,
} from './belt-particles'

// Band edges from planets.ts' header (scene units, incl. ring extents).
const MARS_MAX = 89.7
const JUPITER_MIN = 217.1
const NEPTUNE_MAX = 456.2
// OrbitControls' maxDistance: the eye sits this far behind the target.
const EYE = 80

const asteroids = asteroidBelt()
const kuiper = kuiperBelt()

function semiMajorAxes(belt: BeltOrbits): number[] {
  return Array.from({ length: belt.count }, (_, k) =>
    meanMotion(1) / belt.orbit[k * ORBIT_STRIDE + 1]
  ).map((x) => x ** (2 / 3))
}

function radii(belt: BeltOrbits, years: number): number[] {
  return Array.from({ length: belt.count }, (_, k) =>
    Math.hypot(...beltPosition(belt, k, years))
  )
}

describe('meanMotion', () => {
  it("follows Kepler's third law", () => {
    expect(meanMotion(1)).toBe(1)
    expect(meanMotion(4)).toBeCloseTo(1 / 8, 12)
    expect(meanMotion(2.7)).toBeCloseTo(1 / 4.4366, 4)
  })
})

describe('yearsSinceJ2000', () => {
  it('is zero at J2000 and counts Julian years', () => {
    const j2000 = Date.parse('2000-01-01T12:00:00Z')
    expect(yearsSinceJ2000(j2000)).toBe(0)
    expect(yearsSinceJ2000(j2000 + 365.25 * 86_400_000)).toBeCloseTo(1, 12)
  })
})

describe('the belts', () => {
  it('have the [TUNE] counts and are the same every time', () => {
    expect(asteroids.count).toBe(ASTEROID_COUNT)
    expect(kuiper.count).toBe(KUIPER_COUNT)
    expect(asteroids.orbit).toHaveLength(ASTEROID_COUNT * ORBIT_STRIDE)
    expect(asteroids.shape).toHaveLength(ASTEROID_COUNT * SHAPE_STRIDE)
    expect(asteroidBelt().orbit).toEqual(asteroids.orbit)
    expect(kuiperBelt().shape).toEqual(kuiper.shape)
  })

  it('put the asteroids at 2.2–3.3 AU, clear of the Kirkwood gaps', () => {
    const as = semiMajorAxes(asteroids)
    for (const a of as) {
      expect(a).toBeGreaterThanOrEqual(ASTEROID_A_AU[0] - 1e-4)
      expect(a).toBeLessThanOrEqual(ASTEROID_A_AU[1] + 1e-4)
    }
    for (const gap of [2.5, 2.82, 2.95]) {
      expect(as.filter((a) => Math.abs(a - gap) < 0.02)).toHaveLength(0)
    }
    // Densest mid-belt.
    const mid = as.filter((a) => a > 2.5 && a < 3).length
    expect(mid / as.length).toBeGreaterThan(0.5)
  })

  it('put the Kuiper belt at 30–50 AU', () => {
    for (const a of semiMajorAxes(kuiper)) {
      expect(a).toBeGreaterThanOrEqual(KUIPER_A_AU[0] - 1e-3)
      expect(a).toBeLessThanOrEqual(KUIPER_A_AU[1] + 1e-3)
    }
  })

  it('place every particle at its sceneDistance, whenever', () => {
    for (const belt of [asteroids, kuiper]) {
      for (const years of [0, 26.8, -150, 1000]) {
        const rs = radii(belt, years)
        rs.forEach((r, k) => {
          expect(r).toBeCloseTo(belt.orbit[k * ORBIT_STRIDE], 3)
        })
      }
    }
  })

  it('keep the asteroids between Mars and Jupiter', () => {
    const rs = radii(asteroids, 0)
    expect(Math.min(...rs)).toBeGreaterThan(MARS_MAX)
    expect(Math.max(...rs)).toBeLessThan(JUPITER_MIN)
    expect(sceneDistance(ASTEROID_A_AU[0])).toBeGreaterThan(MARS_MAX)
  })

  it('keep the asteroid belt thin and the Kuiper belt thicker', () => {
    const meanTilt = (belt: BeltOrbits) => {
      let sum = 0
      for (let k = 0; k < belt.count; k++) sum += belt.shape[k * SHAPE_STRIDE]
      return ((sum / belt.count) * 180) / Math.PI
    }
    expect(meanTilt(asteroids)).toBeGreaterThan(3)
    expect(meanTilt(asteroids)).toBeLessThan(8)
    expect(meanTilt(kuiper)).toBeGreaterThan(meanTilt(asteroids) - 2)
    for (const belt of [asteroids, kuiper]) {
      for (let k = 0; k < belt.count; k++) {
        expect(belt.shape[k * SHAPE_STRIDE]).toBeLessThanOrEqual((40 * Math.PI) / 180 + 1e-6)
        expect(belt.shape[k * SHAPE_STRIDE + 1]).toBeGreaterThan(0)
        expect(belt.shape[k * SHAPE_STRIDE + 1]).toBeLessThanOrEqual(1)
      }
    }
  })

  it('orbit at Kepler rates: a full turn takes 1 / meanMotion years', () => {
    for (const belt of [asteroids, kuiper]) {
      for (const k of [0, 17, belt.count - 1]) {
        const n = belt.orbit[k * ORBIT_STRIDE + 1]
        const r = belt.orbit[k * ORBIT_STRIDE]
        const start = beltPosition(belt, k, 10)
        const turned = beltPosition(belt, k, 10 + 1 / n)
        for (let c = 0; c < 3; c++) expect(turned[c]).toBeCloseTo(start[c], 2)
        // A tenth of a turn sweeps 36° of its circle.
        const tenth = beltPosition(belt, k, 10 + 0.1 / n)
        const chord = Math.hypot(
          tenth[0] - start[0],
          tenth[1] - start[1],
          tenth[2] - start[2]
        )
        expect(chord).toBeCloseTo(2 * r * Math.sin(Math.PI / 10), 2)
      }
    }
  })

  it('move the outer belt more slowly than the inner one', () => {
    const slowestAsteroid = Math.min(
      ...Array.from({ length: asteroids.count }, (_, k) => asteroids.orbit[k * ORBIT_STRIDE + 1])
    )
    const fastestKuiper = Math.max(
      ...Array.from({ length: kuiper.count }, (_, k) => kuiper.orbit[k * ORBIT_STRIDE + 1])
    )
    expect(fastestKuiper).toBeLessThan(slowestAsteroid / 10)
  })
})

describe('the Kuiper belt in the main view', () => {
  const kuiperMax = Math.max(...radii(kuiper, 0))

  it('stays within the planets draw depth from any planet the view targets', () => {
    // A particle on the far side of the Sun from a target at Neptune is
    // still within reach of the near plane at the zoom floor (main-view.ts).
    expect(kuiperMax).toBeLessThanOrEqual(sceneDistance(KUIPER_A_AU[1]) + 1e-3)
    expect(NEPTUNE_MAX + kuiperMax).toBeLessThanOrEqual(planetsDrawDepth(PLANETS_MIN_ZOOM))
  })

  it('stays inside the starfield, even its nearest depth shell', () => {
    const starRadius = mainViewRange(true, { width: 390, height: 844 }).starRadius!
    expect(EYE + NEPTUNE_MAX + kuiperMax).toBeLessThan(starRadius * SHELL_NEAR_RADIUS)
    expect(EYE + NEPTUNE_MAX + kuiperMax).toBeLessThan(starRadius * Math.SQRT1_2)
  })
})
