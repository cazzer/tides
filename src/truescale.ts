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
// MAX_TRUESCALE: the Sun is the body that grows most, to 10 · 32.2^a (scene
// 10, true ~322 units), ~114 units at 0.7. Room alone would allow more:
// Mercury's perihelion surface sits ~306 units from the Sun's centre at the
// flight scale, so 0.9 (Sun ~228) leaves ~74 clear, ~0.95 still ~30, and 1
// puts Mercury inside it (flight-scale.test.ts samples 1900–2100). The cap is
// the HUD's instead: past ~0.7 the Sun's range anchor reads on its pair scale
// with the squeezed-in Mercury however far out the ship is, and a run in to
// Venus or Mars that passes the Sun can read its range backwards
// (../ship/ship-distances.ts, tides-3ln). Fixing that would unlock 0.8–0.9.
//
// Read once at load, like ?relief= (./relief.ts): a change is a reload, so
// nothing has to rebuild live. A worker's location is its script's, with no
// query, so it takes 0.

export const DEFAULT_TRUESCALE = 0
/** A bare ?truescale (no value): halfway, in log space. */
export const BARE_TRUESCALE = 0.5
export const MAX_TRUESCALE = 0.7

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
