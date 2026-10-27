// True-scale body sizes in ship mode (tides-o39), chosen at load:
// ?truescale=<a> in the URL, a in [0, MAX_TRUESCALE], 0 (today's sizes) if
// absent or unreadable, BARE_TRUESCALE for a bare ?truescale.
//
// The user's call: keep every distance as it is (the flight scale's 1000
// units per AU, the Moon's packed 10 units, the moon systems' log maps) and
// the system view exactly as it is, but in flight slide each body's radius
// from its scene size toward its true size at Earth's drawn scale
// (EARTH_KM_PER_UNIT, ~2159 km a unit), so trips take no longer but the big
// bodies feel big. The slide is in log space, scene^(1 − a) · true^a: the
// scene radii are a log scale already (planets.ts sceneRadius), so a step in
// a is the same share of the way for the Sun as for Jupiter. Earth doesn't
// move at any a: its scene radius is its true one at that scale. Bodies
// smaller than their scene size (Mercury, Mars, the Moon, most moons) shrink
// toward true, which the user accepted; the moons stop at MOON_RADIUS_FLOOR
// (moons/moons.ts), and each planet's moon system grows or shrinks with its
// planet (moons.ts moonOrbitRadiiAt).
//
// MAX_TRUESCALE: the Sun is the body that runs out of room. Its radius is
// 10 · 32.2^a (scene 10, true ~322 units), and Mercury's perihelion surface
// sits ~306 units from its centre at the flight scale. At 0.9 the Sun is
// ~228 units (~232 with the ship's collision margin), ~74 clear; 0.95 leaves
// ~30, and 1 puts Mercury inside it. flight-scale.test.ts samples 1900–2100
// to hold the line.
//
// Read once at load, like ?relief= (./relief.ts): a change is a reload, so
// nothing has to rebuild live. A worker has no location and takes 0.

export const DEFAULT_TRUESCALE = 0
/** A bare ?truescale (no value): halfway, in log space. */
export const BARE_TRUESCALE = 0.5
export const MAX_TRUESCALE = 0.9

export function parseTrueScale(search: string): number {
  const raw = new URLSearchParams(search).get('truescale')
  if (raw === null) return DEFAULT_TRUESCALE
  if (raw.trim() === '') return BARE_TRUESCALE
  const value = Number(raw)
  if (!Number.isFinite(value)) return DEFAULT_TRUESCALE
  return Math.min(MAX_TRUESCALE, Math.max(0, value))
}

/** This page's factor; 0 outside a browser. */
export const TRUESCALE =
  typeof location === 'undefined' ? DEFAULT_TRUESCALE : parseTrueScale(location.search)

/**
 * A radius `a` of the way from `scene` to `truth` in log space. At a = 0 it
 * is `scene` itself, not a round trip through pow, so the default changes
 * nothing.
 */
export function towardTrue(scene: number, truth: number, a: number = TRUESCALE): number {
  return a === 0 ? scene : scene ** (1 - a) * truth ** a
}
