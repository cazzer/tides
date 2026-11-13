// What the focus title (FocusTitle.tsx, tides-ufyr.18) says about a planet
// or moon: its name, its diameter and a size anyone can picture. Pure, so
// the copy is tested on its own.

import { EARTH_DIAMETER, MOON_DIAMETER } from './flight-scale'
import { PLANETS, type PlanetKey } from './planets'
import { MOONS } from './moons/moons'
import { isMoonKey, type MoonKey } from './moons/moon-keys'
import { bodyName } from './ship/ship-distances'
import { isSystemFocus, type CameraFocus } from './store'

// The scene's own mean diameters (flight-scale.ts), for the comparisons below.
export const EARTH_DIAMETER_KM = EARTH_DIAMETER / 1000
export const MOON_DIAMETER_KM = MOON_DIAMETER / 1000

/** The body's mean diameter, km. */
export function diameterKm(key: PlanetKey | MoonKey): number {
  return isMoonKey(key) ? 2 * MOONS[key].radiusKm : PLANETS[key].diameter / 1000
}

/**
 * Each body's size against something familiar: the planets against Earth,
 * the moons against ours, and the ones too small for that against a city or
 * a drive (at ~100 km/h). Written from diameterKm over
 * the diameters above; body-facts.test.ts checks the ratios still hold.
 */
export const SIZE_COMPARISON: Readonly<Record<PlanetKey | MoonKey, string>> = {
  mercury: 'over a third of Earth’s width',
  venus: 'nearly as wide as Earth',
  mars: 'about half Earth’s width',
  jupiter: '11 Earths across',
  saturn: 'over 9 Earths across',
  uranus: 'about 4 Earths across',
  neptune: 'nearly 4 Earths across',
  phobos: 'about as long as Manhattan',
  deimos: 'under 10 minutes’ drive across',
  io: 'about as wide as our Moon',
  europa: 'nearly as wide as our Moon',
  ganymede: '1.5 times our Moon’s width',
  callisto: '1.4 times our Moon’s width',
  mimas: 'about a 4-hour drive across',
  enceladus: 'about a 5-hour drive across',
  tethys: 'about a third of our Moon’s width',
  dione: 'about a third of our Moon’s width',
  rhea: 'nearly half our Moon’s width',
  titan: '1.5 times our Moon’s width',
  iapetus: 'over two-fifths of our Moon’s width',
  miranda: 'about a 5-hour drive across',
  ariel: 'about a third of our Moon’s width',
  umbriel: 'about a third of our Moon’s width',
  titania: 'nearly half our Moon’s width',
  oberon: 'nearly half our Moon’s width',
  triton: 'about three-quarters of our Moon’s width',
}

export interface FocusTitle {
  name: string
  /** "116,000 km wide". */
  size: string
  comparison: string
}

// English, as the copy is: "116,000", not the reader's "116.000".
const threeFigures = new Intl.NumberFormat('en', { maximumSignificantDigits: 3 })

/** Whether the focus gets a title: a planet or one of their moons. */
export function hasFocusTitle(focus: CameraFocus): boolean {
  return isSystemFocus(focus)
}

/** The title for the focus; null for Earth, the Moon, the Sun, the clock and a location. */
export function focusTitleFor(focus: CameraFocus): FocusTitle | null {
  if (!isSystemFocus(focus)) return null
  return {
    name: bodyName(focus),
    size: `${threeFigures.format(diameterKm(focus))} km wide`,
    comparison: SIZE_COMPARISON[focus],
  }
}
