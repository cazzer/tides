// The major moons' keys on their own (tides-2hv.8), so the store can list
// them as camera foci without pulling in the ephemeris behind moons.ts.

/** Grouped by parent, outward from the Sun; each parent's moons outward. */
export const MOON_KEYS = [
  'phobos',
  'deimos',
  'io',
  'europa',
  'ganymede',
  'callisto',
  'mimas',
  'enceladus',
  'tethys',
  'dione',
  'rhea',
  'titan',
  'iapetus',
  'miranda',
  'ariel',
  'umbriel',
  'titania',
  'oberon',
  'triton',
] as const

export type MoonKey = (typeof MOON_KEYS)[number]

export function isMoonKey(key: string): key is MoonKey {
  return (MOON_KEYS as readonly string[]).includes(key)
}
