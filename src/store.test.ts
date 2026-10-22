import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SYSTEM_AIDS,
  FOCUS_VALUES,
  PLANET_FOCUS_KEYS,
  SYSTEM_AID_KEYS,
  isPlanetFocus,
  isSystemFocus,
  parseConstellations,
  parseFocus,
  parseSystemAids,
  serializeSystemAids,
  useStore,
  type SystemAids,
} from './store'
import { MOON_KEYS } from './moons/moon-keys'
import { shipInput } from './ship/ship-input'
import { getShipTarget, setShipTarget, shipTelemetry } from './ship/ship-telemetry'

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

  it('keeps the existing focus values first, then the planets, then their moons', () => {
    expect(FOCUS_VALUES).toEqual([
      'clock',
      'earth',
      'sun',
      'moon',
      'location',
      ...PLANET_FOCUS_KEYS,
      ...MOON_KEYS,
    ])
  })

  it('tells planets from the other bodies', () => {
    expect(isPlanetFocus('jupiter')).toBe(true)
    expect(isPlanetFocus('earth')).toBe(false)
    expect(isPlanetFocus('pluto')).toBe(false)
    expect(isPlanetFocus('titan')).toBe(false)
  })

  it('counts the planets and their moons as system foci, not Earth’s Moon', () => {
    expect(isSystemFocus('jupiter')).toBe(true)
    expect(isSystemFocus('titan')).toBe(true)
    expect(isSystemFocus('triton')).toBe(true)
    expect(isSystemFocus('moon')).toBe(false)
    expect(isSystemFocus('charon')).toBe(false)
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
    expect(parseFocus('titan', true)).toBe('titan')
    expect(parseFocus('titan', false)).toBeNull()
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

describe('system aids', () => {
  const allOff = Object.fromEntries(
    SYSTEM_AID_KEYS.map((key) => [key, false])
  ) as SystemAids

  it('defaults every aid on except trails', () => {
    expect(DEFAULT_SYSTEM_AIDS).toEqual({
      orbits: true,
      grid: true,
      labels: true,
      belts: true,
      scale: true,
      trails: false,
    })
    expect(useStore.getState().systemAids).toEqual(DEFAULT_SYSTEM_AIDS)
  })

  it('reads a missing ?aids= as the defaults', () => {
    expect(parseSystemAids(null)).toEqual(DEFAULT_SYSTEM_AIDS)
  })

  it('reads the listed aids as on and the rest as off', () => {
    expect(parseSystemAids('orbits,trails')).toEqual({
      ...allOff,
      orbits: true,
      trails: true,
    })
  })

  it('reads an empty ?aids= as all off and ignores unknown names', () => {
    expect(parseSystemAids('')).toEqual(allOff)
    expect(parseSystemAids('grid,comets,,')).toEqual({ ...allOff, grid: true })
  })

  it('writes no param for the defaults', () => {
    expect(serializeSystemAids(DEFAULT_SYSTEM_AIDS)).toBeNull()
  })

  it('writes the on aids in a fixed order, and an empty value for none', () => {
    expect(
      serializeSystemAids({ ...allOff, trails: true, orbits: true })
    ).toBe('orbits,trails')
    expect(serializeSystemAids(allOff)).toBe('')
  })

  it('round-trips every combination through the URL', () => {
    for (let mask = 0; mask < 1 << SYSTEM_AID_KEYS.length; mask++) {
      const aids = Object.fromEntries(
        SYSTEM_AID_KEYS.map((key, i) => [key, (mask & (1 << i)) !== 0])
      ) as SystemAids
      const params = new URLSearchParams()
      const value = serializeSystemAids(aids)
      if (value != null) params.set('aids', value)
      const read = new URLSearchParams(params.toString()).get('aids')
      expect(parseSystemAids(read)).toEqual(aids)
    }
  })

  it('toggles one aid at a time', () => {
    const { setSystemAid } = useStore.getState()
    setSystemAid('grid', false)
    expect(useStore.getState().systemAids).toEqual({
      ...DEFAULT_SYSTEM_AIDS,
      grid: false,
    })
    setSystemAid('trails', true)
    expect(useStore.getState().systemAids.trails).toBe(true)
    setSystemAid('grid', true)
    setSystemAid('trails', false)
    expect(useStore.getState().systemAids).toEqual(DEFAULT_SYSTEM_AIDS)
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

describe('ship mode', () => {
  it('forces planets on at 1× and restores the view on exit', () => {
    useStore.setState({
      layout: 'single',
      mainPanel: 'bottom',
      cameraFocus: 'moon',
      timeScale: 86400,
      showPlanets: false,
      jumpDate: new Date(Date.UTC(2030, 0, 1)),
    })
    useStore.getState().enterShip()
    expect(useStore.getState()).toMatchObject({
      shipMode: true,
      showPlanets: true,
      timeScale: 1,
      jumpDate: null,
    })
    useStore.getState().exitShip()
    expect(useStore.getState()).toMatchObject({
      shipMode: false,
      shipSaved: null,
      layout: 'single',
      mainPanel: 'bottom',
      cameraFocus: 'moon',
      timeScale: 86400,
      showPlanets: false,
    })
  })

  it('keeps a planet focus that was valid on entry', () => {
    useStore.setState({ showPlanets: true, cameraFocus: 'jupiter' })
    useStore.getState().enterShip()
    useStore.getState().exitShip()
    expect(useStore.getState()).toMatchObject({ showPlanets: true, cameraFocus: 'jupiter' })
  })

  it('resets the pilot input and target on exit', () => {
    useStore.getState().enterShip()
    shipInput.throttle = 1
    shipInput.flightAssist = false
    setShipTarget('mars')
    shipTelemetry.speed = 42
    useStore.getState().exitShip()
    expect(shipInput.throttle).toBe(0)
    expect(shipInput.flightAssist).toBe(true)
    expect(getShipTarget()).toBeNull()
    expect(shipTelemetry.speed).toBe(0)
  })

  it('enters ship mode from ?ship=1 before the first render, saving the URL view', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { location: { search: '?ship=1&speed=3600&layout=single' } })
    try {
      const { useStore: fresh } = await import('./store')
      expect(fresh.getState()).toMatchObject({
        shipMode: true,
        timeScale: 1,
        showPlanets: true,
        shipSaved: { timeScale: 3600, layout: 'single', showPlanets: false },
      })
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })

  it('ignores a repeated entry and a stray exit', () => {
    useStore.setState({ timeScale: 3600 })
    useStore.getState().enterShip()
    useStore.getState().enterShip()
    useStore.getState().exitShip()
    useStore.getState().exitShip()
    expect(useStore.getState()).toMatchObject({ shipMode: false, timeScale: 3600 })
  })
})
