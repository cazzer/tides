// What the focus title (FocusTitle.tsx, tides-ufyr.18) says about a planet
// or moon: its name, its diameter and its size against Earth or our Moon,
// kept to one short line. Pure, so the copy is tested on its own.

import { EARTH_DIAMETER, MOON_DIAMETER } from './flight-scale'
import { PLANETS, type PlanetKey } from './planets'
import { MOONS } from './moons/moons'
import { isMoonKey, type MoonKey } from './moons/moon-keys'
import { bodyName } from './ship/ship-distances'
import { isSystemFocus, type CameraFocus } from './store'

// The scene's own mean diameters (flight-scale.ts), for the comparisons below.
export const EARTH_DIAMETER_KM = EARTH_DIAMETER / 1000
export const MOON_DIAMETER_KM = MOON_DIAMETER / 1000

/** Under this diameter, km, a moon gets no comparison: "0.0064× Moon" says nothing. */
export const TINY_MOON_KM = 100

/** The body's mean diameter, km. */
export function diameterKm(key: PlanetKey | MoonKey): number {
  return isMoonKey(key) ? 2 * MOONS[key].radiusKm : PLANETS[key].diameter / 1000
}

export interface FocusTitle {
  name: string
  /** "116,000 km". */
  size: string
  /** "9.1× Earth" or "1.5× Moon"; null for a moon under TINY_MOON_KM. */
  comparison: string | null
}

// English, as the copy is: "116,000", not the reader's "116.000".
const threeFigures = new Intl.NumberFormat('en', { maximumSignificantDigits: 3 })
// Always two figures: Io is "1.0× Moon" and Uranus "4.0× Earth", not a bare "1×".
const twoFigures = new Intl.NumberFormat('en', { minimumSignificantDigits: 2, maximumSignificantDigits: 2 })

/** The body's size against Earth (a planet) or our Moon (a moon); null for a tiny moon. */
export function sizeComparison(key: PlanetKey | MoonKey): string | null {
  const diameter = diameterKm(key)
  if (!isMoonKey(key)) return `${twoFigures.format(diameter / EARTH_DIAMETER_KM)}× Earth`
  if (diameter < TINY_MOON_KM) return null
  return `${twoFigures.format(diameter / MOON_DIAMETER_KM)}× Moon`
}

/** Whether the focus gets a title: a planet or one of their moons. */
export function hasFocusTitle(focus: CameraFocus): boolean {
  return isSystemFocus(focus)
}

/** The title for the focus; null for Earth, the Moon, the Sun, the clock and a location. */
export function focusTitleFor(focus: CameraFocus): FocusTitle | null {
  if (!isSystemFocus(focus)) return null
  return {
    name: bodyName(focus),
    // Whole km: Phobos is "22 km", not "22.2 km".
    size: `${threeFigures.format(Math.round(diameterKm(focus)))} km`,
    comparison: sizeComparison(focus),
  }
}
