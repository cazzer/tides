import { describe, expect, it } from 'vitest'
import {
  FOCUS_VALUES,
  PLANET_FOCUS_KEYS,
  isPlanetFocus,
  parseConstellations,
  parseFocus,
  useStore,
} from './store'

describe('focus keys', () => {
  it('lists the planets in solar order', () => {
    expect(PLANET_FOCUS_KEYS).toEqual([
      'mercury',
      'venus',
      'mars',
      'jupiter',
      'saturn',
      'uranus',
      'neptune',
    ])
  })

  it('keeps the existing focus values first, then the planets', () => {
    expect(FOCUS_VALUES).toEqual([
      'clock',
      'earth',
      'sun',
      'moon',
      'location',
      ...PLANET_FOCUS_KEYS,
    ])
  })

  it('tells planets from the other bodies', () => {
    expect(isPlanetFocus('jupiter')).toBe(true)
    expect(isPlanetFocus('earth')).toBe(false)
    expect(isPlanetFocus('pluto')).toBe(false)
  })
})

describe('parseFocus', () => {
  it('accepts the existing values whether planets are on or off', () => {
    for (const focus of ['clock', 'earth', 'sun', 'moon', 'location']) {
      expect(parseFocus(focus, false)).toBe(focus)
      expect(parseFocus(focus, true)).toBe(focus)
    }
  })

  it('accepts planets only when planets are shown', () => {
    expect(parseFocus('saturn', true)).toBe('saturn')
    expect(parseFocus('saturn', false)).toBeNull()
  })

  it('rejects missing and unknown values', () => {
    expect(parseFocus(null, true)).toBeNull()
    expect(parseFocus('', true)).toBeNull()
    expect(parseFocus('pluto', true)).toBeNull()
    expect(parseFocus('Earth', true)).toBeNull()
  })
})

describe('setShowPlanets', () => {
  it('moves a planet focus to the Sun when planets turn off', () => {
    const { setShowPlanets, setCameraFocus } = useStore.getState()
    setShowPlanets(true)
    setCameraFocus('mars')
    setShowPlanets(false)
    expect(useStore.getState().cameraFocus).toBe('sun')
  })

  it('leaves any other focus alone', () => {
    const { setShowPlanets, setCameraFocus } = useStore.getState()
    setShowPlanets(true)
    setCameraFocus('moon')
    setShowPlanets(false)
    expect(useStore.getState().cameraFocus).toBe('moon')
  })
})

describe('calendar ring toggles', () => {
  it('starts off without URL params and toggles each ring on its own', () => {
    const { setShowLunar, setShowZodiac } = useStore.getState()
    expect(useStore.getState().showLunar).toBe(false)
    expect(useStore.getState().showZodiac).toBe(false)
    setShowLunar(true)
    expect(useStore.getState().showLunar).toBe(true)
    expect(useStore.getState().showZodiac).toBe(false)
    setShowZodiac(true)
    setShowLunar(false)
    expect(useStore.getState().showLunar).toBe(false)
    expect(useStore.getState().showZodiac).toBe(true)
    setShowZodiac(false)
    expect(useStore.getState().showZodiac).toBe(false)
  })
})

describe('parseConstellations', () => {
  it('keeps ?constellations=1 as lines only and adds the art with =art', () => {
    expect(parseConstellations(null)).toEqual({ lines: false, art: false })
    expect(parseConstellations('1')).toEqual({ lines: true, art: false })
    expect(parseConstellations('art')).toEqual({ lines: true, art: true })
    expect(parseConstellations('0')).toEqual({ lines: false, art: false })
  })
})
