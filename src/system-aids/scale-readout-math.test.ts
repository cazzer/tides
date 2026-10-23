import { describe, expect, it } from 'vitest'
import { KM_PER_AU } from 'astronomy-engine'
import { sceneDistance } from '../planets'
import { MOONS, moonOrbitRadius } from '../moons/moons'
import { formatDistance } from '../ship/ship-distances'
import {
  SCALE_BAR_MAX_PX,
  distanceFromEarthKm,
  distanceLine,
  distanceTarget,
  kmPerUnit,
  niceScaleBarKm,
  scaleCaption,
  scaleCaptionShort,
  scaleReference,
} from './scale-readout-math'

const T = Date.UTC(2026, 9, 22)

describe('kmPerUnit', () => {
  it('is ~1/50 AU along Earth’s orbit', () => {
    expect(kmPerUnit('earth', T) / (KM_PER_AU / 50)).toBeCloseTo(1, 1)
  })

  it('is 38 440 km along the Moon’s', () => {
    expect(kmPerUnit('moon', T)).toBeCloseTo(38_440, -1)
  })

  it('is the log map’s ratio for a major moon', () => {
    expect(kmPerUnit('titan', T)).toBeCloseTo(MOONS.titan.aKm / moonOrbitRadius('titan'), 0)
    // The Galileans' true distances wander a little from the mean.
    expect(kmPerUnit('io', T) / (MOONS.io.aKm / moonOrbitRadius('io'))).toBeCloseTo(1, 2)
  })

  it('differs from the radial scale between orbits, hence the caption', () => {
    // Along Jupiter's orbit a unit is r / f(r); out from the Sun it is 1 / f′(r).
    const along = kmPerUnit('jupiter', T)
    // Jupiter is 4.95–5.46 AU out.
    for (const r of [4.95, 5.46]) {
      expect(along / ((KM_PER_AU * r) / sceneDistance(r))).toBeGreaterThan(0.95)
      expect(along / ((KM_PER_AU * r) / sceneDistance(r))).toBeLessThan(1.05)
    }
    const r = 5.2
    const radial = (KM_PER_AU * 0.01) / (sceneDistance(r + 0.005) - sceneDistance(r - 0.005))
    expect(radial / along).toBeGreaterThan(1.5)
  })
})

describe('niceScaleBarKm', () => {
  const steps = (km: number, unit: number) => {
    const m = km / unit / 10 ** Math.floor(Math.log10(km / unit) + 1e-9)
    return [1, 2, 5].some((s) => Math.abs(m - s) < 1e-6)
  }

  it('steps 1, 2, 5 and fits between 40% and all of the maximum width', () => {
    for (let kmPerPx = 1; kmPerPx < 1e8; kmPerPx *= 1.37) {
      const km = niceScaleBarKm(kmPerPx)
      const px = km / kmPerPx
      expect(px, `${kmPerPx} km/px`).toBeLessThanOrEqual(SCALE_BAR_MAX_PX + 1e-6)
      expect(px, `${kmPerPx} km/px`).toBeGreaterThan(0.4 * SCALE_BAR_MAX_PX - 1e-6)
      expect(steps(km, km >= 0.1 * KM_PER_AU ? KM_PER_AU : 1), `${km} km`).toBe(true)
    }
  })

  it('counts in AU from a tenth of one', () => {
    const km = niceScaleBarKm((0.3 * KM_PER_AU) / SCALE_BAR_MAX_PX)
    expect(km).toBeCloseTo(0.2 * KM_PER_AU, 0)
    expect(formatDistance(km)).toBe('0.2 AU')
    expect(formatDistance(niceScaleBarKm(2.5 * KM_PER_AU / SCALE_BAR_MAX_PX))).toBe('2 AU')
    // Just under a tenth: round km.
    expect(niceScaleBarKm((0.09 * KM_PER_AU) / SCALE_BAR_MAX_PX)).toBe(10_000_000)
    expect(formatDistance(500_000)).toBe('500,000 km')
  })
})

describe('the readout’s words', () => {
  it('measures along the focused body’s orbit, Earth’s for the Sun, clock or a location', () => {
    expect(scaleReference('jupiter')).toBe('jupiter')
    expect(scaleReference('titan')).toBe('titan')
    expect(scaleReference('sun')).toBe('earth')
    expect(scaleReference('clock')).toBe('earth')
    expect(scaleReference('location')).toBe('earth')
    expect(scaleCaption('jupiter')).toBe("at Jupiter's orbit · gaps between orbits are squeezed")
    expect(scaleCaption('moon')).toBe("at the Moon's orbit · gaps between orbits are squeezed")
    expect(scaleCaptionShort('titan')).toBe("at Titan's orbit")
  })

  it('gives the distance from Earth only for a body other than Earth', () => {
    expect(distanceTarget('earth')).toBeNull()
    expect(distanceTarget('clock')).toBeNull()
    expect(distanceTarget('location')).toBeNull()
    expect(distanceTarget('sun')).toBe('sun')
    expect(distanceTarget('io')).toBe('io')
  })

  it('reads true centre-to-centre distances', () => {
    expect(distanceFromEarthKm('sun', T) / KM_PER_AU).toBeCloseTo(1, 1)
    const moon = distanceFromEarthKm('moon', T)
    expect(moon).toBeGreaterThan(356_000)
    expect(moon).toBeLessThan(407_000)
    expect(distanceLine('jupiter', 5.21 * KM_PER_AU)).toBe('Jupiter · 5.21 AU from Earth')
  })
})
