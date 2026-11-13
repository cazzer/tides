import { describe, expect, it } from 'vitest'
import {
  EARTH_DIAMETER_KM,
  MOON_DIAMETER_KM,
  SIZE_COMPARISON,
  diameterKm,
  focusTitleFor,
  hasFocusTitle,
} from './body-facts'
import { PLANET_KEYS, type PlanetKey } from './planets'
import { MOON_KEYS, type MoonKey } from './moons/moon-keys'

describe('SIZE_COMPARISON', () => {
  it('has short copy for every planet and moon', () => {
    for (const key of [...PLANET_KEYS, ...MOON_KEYS]) {
      expect(SIZE_COMPARISON[key].length, key).toBeGreaterThan(0)
      expect(SIZE_COMPARISON[key].length, key).toBeLessThanOrEqual(40)
    }
  })

  it('reads the planets against Earth', () => {
    expect(PLANET_KEYS.map((key) => SIZE_COMPARISON[key])).toEqual([
      'over a third of Earth’s width',
      'nearly as wide as Earth',
      'about half Earth’s width',
      '11 Earths across',
      'over 9 Earths across',
      'about 4 Earths across',
      'nearly 4 Earths across',
    ])
  })

  it('reads the moons against a city or our Moon', () => {
    expect(SIZE_COMPARISON.phobos).toBe('about as long as Manhattan')
    expect(SIZE_COMPARISON.titan).toBe('1.5 times our Moon’s width')
    expect(SIZE_COMPARISON.ganymede).toBe('1.5 times our Moon’s width')
    expect(SIZE_COMPARISON.triton).toBe('about three-quarters of our Moon’s width')
    expect(SIZE_COMPARISON.deimos).toBe('under 10 minutes’ drive across')
    expect(SIZE_COMPARISON.io).toBe('about as wide as our Moon')
    expect(SIZE_COMPARISON.iapetus).toBe('over two-fifths of our Moon’s width')
    for (const key of ['rhea', 'oberon', 'titania'] as const) {
      expect(SIZE_COMPARISON[key]).toBe('nearly half our Moon’s width')
    }
  })

  // The copy is written from these ratios; a change to the data should show.
  it('matches the bodies’ sizes', () => {
    const vsEarth = (key: PlanetKey) => diameterKm(key) / EARTH_DIAMETER_KM
    expect(vsEarth('jupiter')).toBeCloseTo(11, 0)
    expect(vsEarth('saturn')).toBeGreaterThan(9)
    expect(vsEarth('mars')).toBeCloseTo(0.5, 1)
    const vsMoon = (key: MoonKey) => diameterKm(key) / MOON_DIAMETER_KM
    expect(vsMoon('ganymede')).toBeCloseTo(1.5, 1)
    expect(vsMoon('callisto')).toBeCloseTo(1.4, 1)
    for (const key of ['rhea', 'oberon', 'titania'] as const) {
      expect(vsMoon(key)).toBeGreaterThan(0.42)
      expect(vsMoon(key)).toBeLessThan(0.5)
    }
    expect(vsMoon('iapetus')).toBeGreaterThan(0.4)
    expect(vsMoon('io')).toBeCloseTo(1, 1)
    // Deimos at ~100 km/h.
    expect((diameterKm('deimos') / 100) * 60).toBeLessThan(10)
    expect(vsMoon('triton')).toBeCloseTo(0.75, 1)
    expect(vsMoon('tethys')).toBeCloseTo(1 / 3, 1)
  })
})

describe('diameterKm', () => {
  it('reads planets in metres and moons by radius', () => {
    expect(diameterKm('jupiter')).toBe(139_822)
    expect(diameterKm('phobos')).toBeCloseTo(22.16, 2)
  })
})

describe('focusTitleFor', () => {
  it('names a planet or moon with its size', () => {
    expect(focusTitleFor('saturn')).toEqual({
      name: 'Saturn',
      size: '116,000 km wide',
      comparison: 'over 9 Earths across',
    })
    expect(focusTitleFor('phobos')?.size).toBe('22.2 km wide')
    expect(focusTitleFor('jupiter')?.size).toBe('140,000 km wide')
    expect(hasFocusTitle('titan')).toBe(true)
  })

  it('has no title for the clock, Earth, a location, the Sun or the Moon', () => {
    for (const focus of ['clock', 'earth', 'location', 'sun', 'moon'] as const) {
      expect(focusTitleFor(focus), focus).toBeNull()
      expect(hasFocusTitle(focus), focus).toBe(false)
    }
  })
})
