// The gas giants' cloud deck (tides-ufyr.8.3): the fog the ship dives into
// below their visible cloud tops, down to a hard floor. The globe stays the
// cloud top at 1.0 R, opaque from outside; a fog shell from R·top in
// (renderers/PlanetRenderer.tsx PlanetDeck) draws one analytic exponential
// fog over everything, its extinction σ₀·e^{−(r−R)/H} at radius r, which
// grows without bound below R, so the same formula runs either side of the
// cloud top and the view straight down is opaque well above the floor.
// shaders/planet/deck-column.glsl mirrors deckColumn and deckAhead; keep
// them in step. This is their tested spec, as cloud-layer.ts is the cloud
// shaders'.
//
// Radii and lengths are fractions of the planet's radius R unless a
// function takes R.

import type { PlanetKey } from './planets'
import { CUSHION_DEPTH_SHARE, CUSHION_SHELL_SHARE } from './ship/flight'

export interface DeckProfile {
  /**
   * The fog's base: what the ship's gaps measure from (its `ground`,
   * ship-bodies.ts). Nothing solid is drawn there.
   */
  base: number
  /** The hard backstop under the cushion (planetCollisionRadius). */
  floor: number
  /**
   * The cushion's top over the floor (flight.ts cushionBandOver):
   * CUSHION_DEPTH_SHARE × the floor's height over the base, capped at
   * CUSHION_SHELL_SHARE of the way up to the cloud top, whose globe is a
   * shell over the stop; so always under 1.0 R.
   */
  rest: number
  /** The fog's scale height, H. */
  scaleHeight: number
  /** The fog shell's radius, 1 + DECK_TOP_HEIGHTS · H: e^−4 of the fog at R. */
  top: number
  /** How far one sees at R, 1/σ₀. */
  visibility: number
  /** The depth under R over which sunlight dims by e, Z_L. */
  sunDepth: number
}

/** [TUNE] The fog's base, floor and the shell's height in scale heights. */
export const DECK_BASE = 0.979
export const DECK_FLOOR = 0.985
export const DECK_TOP_HEIGHTS = 4
/** [TUNE] 1/σ₀ at R and Z_L, fractions of R. */
export const DECK_VISIBILITY = 0.004
export const DECK_SUN_DEPTH = 0.006

/**
 * The cushion's top over a floor `floor` above a base `base` (fractions of
 * R) with the globe's shell at 1.0 R over it: flight.ts cushionBandOver's
 * width from the data alone (its CUSHION_MAX_SECONDS cap at the speed floor
 * is wider than either for every giant; ship-bodies.test checks it).
 */
export function deckRest(base: number, floor: number): number {
  return floor + Math.min(CUSHION_DEPTH_SHARE * (floor - base), CUSHION_SHELL_SHARE * (1 - floor))
}

function deckProfile(scaleHeight: number): DeckProfile {
  return {
    base: DECK_BASE,
    floor: DECK_FLOOR,
    rest: deckRest(DECK_BASE, DECK_FLOOR),
    scaleHeight,
    top: 1 + DECK_TOP_HEIGHTS * scaleHeight,
    visibility: DECK_VISIBILITY,
    sunDepth: DECK_SUN_DEPTH,
  }
}

/** [TUNE] The giants' decks, by scale height: Jupiter 0.004, Saturn 0.005, Uranus and Neptune 0.006. */
export const DECK_PROFILES: Readonly<Partial<Record<PlanetKey, DeckProfile>>> = {
  jupiter: deckProfile(0.004),
  saturn: deckProfile(0.005),
  uranus: deckProfile(0.006),
  neptune: deckProfile(0.006),
}

const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1)

/**
 * How deep in the deck an eye `distance` from the centre of a planet of
 * radius `R` is: 0 at (and over) its top, 1 at (and under) its floor,
 * linear between. What the buffeting reads (telemetry.deck, shake.ts).
 */
export function deckShare(distance: number, R: number, profile: DeckProfile): number {
  return clamp01((R * profile.top - distance) / (R * (profile.top - profile.floor)))
}

/**
 * The fog's opacity scale for an eye `distance` from the centre (the
 * shader's uDeckFade): 0 at the shell's top, 1 from the cloud top down,
 * smoothstepped, so entering the shell shows no edge and under 1.0 R, where
 * the globe culls itself, the fog alone covers the view.
 */
export function deckFade(distance: number, R: number, profile: DeckProfile): number {
  const x = clamp01((R * profile.top - distance) / (R * (profile.top - 1)))
  return x * x * (3 - 2 * x)
}

/** The exponent's cap: e^60 overflows no float32 and is opaque at any visibility. */
export const DECK_MAX_EXPONENT = 60

// The fog's density at radius r over its value at R.
function deckDensity(r: number, R: number, H: number): number {
  return Math.exp(Math.min((R - r) / H, DECK_MAX_EXPONENT))
}

// The column from radius r out along a ray climbing at cos(zenith) mu ≥ 0:
// Chapman's grazing-incidence column, as the hazes' (atmosphere/haze.glsl
// hazeAbove), n(r)·H·sqrt(2x)/(z + sqrt(z² + 4/π)) with x = r/H and
// z = mu·sqrt(x/2). H overhead, half the full line at the horizon.
function deckAbove(r: number, mu: number, R: number, H: number): number {
  const x = r / H
  const z = mu * Math.sqrt(0.5 * x)
  return (deckDensity(r, R, H) * H * Math.sqrt(2 * x)) / (z + Math.sqrt(z * z + 4 / Math.PI))
}

/**
 * The fog's column (∫ density over its value at R, a length) from radius
 * `r` along a ray at cos(zenith) `mu`, to space, for a planet of radius `R`
 * and fog scale height `H` (same units). A falling ray (mu < 0) crosses the
 * full line through its closest approach p (n(p)·sqrt(2πpH)) less the part
 * behind the eye, so the two halves meet at the horizon; p is floored at H,
 * where the line is already opaque, so a ray straight down stays so. No
 * floor stops it: the fog runs on below R, and the formula is the same
 * either side of it. Optical depth is this over the visibility at R.
 */
export function deckColumn(r: number, mu: number, R: number, H: number): number {
  if (mu >= 0) return deckAbove(r, mu, R, H)
  const p = Math.max(r * Math.sqrt(Math.max(0, 1 - mu * mu)), H)
  return Math.max(deckDensity(p, R, H) * Math.sqrt(2 * Math.PI * p * H) - deckAbove(r, -mu, R, H), 0)
}

/**
 * How far along a ray from radius `r` at cos(zenith) `mu` the fog's optical
 * depth reaches 1, plane-parallel, where the shader takes its colour
 * (`visibility` the fog's 1/σ₀ at R): the local visibility L at the
 * horizon, nearer falling into thicker fog, H/mu · ln(1 + |mu| L/H). A
 * climbing ray that never reaches it gets Infinity (the shader clamps it to
 * the shell's exit).
 */
export function deckAhead(r: number, mu: number, R: number, H: number, visibility: number): number {
  const local = visibility / deckDensity(r, R, H)
  const k = (mu * local) / H
  if (Math.abs(k) < 1e-6) return local
  if (k >= 1) return Infinity
  return (-H / mu) * Math.log(1 - k)
}
