import { describe, expect, it } from 'vitest'
import {
  EARTH_DIAMETER_KM,
  MOON_DIAMETER_KM,
  TINY_MOON_KM,
  diameterKm,
  focusTitleFor,
  hasFocusTitle,
  sizeComparison,
} from './body-facts'
import { PLANET_KEYS } from './planets'
import { MOON_KEYS } from './moons/moon-keys'

const statsLine = (key: Parameters<typeof sizeComparison>[0]): string => {
  const title = focusTitleFor(key)
  if (!title) throw new Error(key)
  return title.comparison ? `${title.size} · ${title.comparison}` : title.size
}

describe('sizeComparison', () => {
  it('reads the planets against Earth, to two figures without trailing zeros', () => {
    expect(PLANET_KEYS.map(sizeComparison)).toEqual([
      '0.38× Earth',
      '0.95× Earth',
      '0.53× Earth',
      '11× Earth',
      '9.1× Earth',
      '4× Earth',
      '3.9× Earth',
    ])
  })

  it('reads the moons against ours', () => {
    expect(sizeComparison('io')).toBe('1× Moon')
    expect(sizeComparison('europa')).toBe('0.9× Moon')
    expect(sizeComparison('titan')).toBe('1.5× Moon')
    expect(sizeComparison('ganymede')).toBe('1.5× Moon')
    expect(sizeComparison('triton')).toBe('0.78× Moon')
    expect(sizeComparison('mimas')).toBe('0.11× Moon')
  })

  it('gives a tiny moon none', () => {
    expect(sizeComparison('phobos')).toBeNull()
    expect(sizeComparison('deimos')).toBeNull()
    for (const key of MOON_KEYS) {
      expect(sizeComparison(key) === null, key).toBe(diameterKm(key) < TINY_MOON_KM)
    }
  })

  // The copy is computed from these; a change to the data should show here.
  it('matches the bodies’ sizes', () => {
    expect(diameterKm('jupiter') / EARTH_DIAMETER_KM).toBeCloseTo(11, 0)
    expect(diameterKm('venus') / EARTH_DIAMETER_KM).toBeCloseTo(0.95, 2)
    expect(diameterKm('titan') / MOON_DIAMETER_KM).toBeCloseTo(1.5, 1)
    expect(diameterKm('io') / MOON_DIAMETER_KM).toBeCloseTo(1, 1)
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
      size: '116,000 km',
      comparison: '9.1× Earth',
    })
    expect(focusTitleFor('phobos')).toEqual({ name: 'Phobos', size: '22 km', comparison: null })
    expect(focusTitleFor('jupiter')?.size).toBe('140,000 km')
    expect(hasFocusTitle('titan')).toBe(true)
  })

  it('keeps the stats to one short line', () => {
    expect(statsLine('mercury')).toBe('4,880 km · 0.38× Earth')
    expect(statsLine('phobos')).toBe('22 km')
    // ~6.5 px a character at 11.5 px fits ~29 in the phone title's 192 px
    // (320 px less the dock button's room on both sides).
    for (const key of [...PLANET_KEYS, ...MOON_KEYS]) {
      expect(statsLine(key).length, key).toBeLessThanOrEqual(24)
    }
  })

  it('has no title for the clock, Earth, a location, the Sun or the Moon', () => {
    for (const focus of ['clock', 'earth', 'location', 'sun', 'moon'] as const) {
      expect(focusTitleFor(focus), focus).toBeNull()
      expect(hasFocusTitle(focus), focus).toBe(false)
    }
  })
})
