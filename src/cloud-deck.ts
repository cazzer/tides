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

export interface DeckProfile {
  /**
   * The fog's base: what the ship's gaps measure from (its `ground`,
   * ship-bodies.ts). Nothing solid is drawn there.
   */
  base: number
  /**
   * The hard backstop under the cushion (planetCollisionRadius). The
   * cushion over it (flight.ts, ship-bodies.ts deckRestRadius) stops half
   * way up to the globe's shell at 1.0 R, so always under it.
   */
  floor: number
  /** The fog's scale height, H. */
  scaleHeight: number
  /** The fog shell's radius, 1 + DECK_TOP_HEIGHTS · H: e^−4 of the fog at R. */
  top: number
  /** How far one sees at R, 1/σ₀. */
  visibility: number
  /** The depth under R over which sunlight dims by e, Z_L. */
  sunDepth: number
  /**
   * How far the textured layer at `base` shows through the fog from inside
   * (deckLayerWeight), a fraction of R; 0 turns it off.
   */
  layerSeen: number
  /**
   * The albedo's tint inside the deck (linear RGB, the shader's uDeckTint),
   * blended in by deckInside so the deck-top views keep the map's colours.
   */
  insideTint: readonly [number, number, number]
}

/** [TUNE] The fog's base, floor and the shell's height in scale heights. */
export const DECK_BASE = 0.979
export const DECK_FLOOR = 0.985
export const DECK_TOP_HEIGHTS = 4
/** [TUNE] 1/σ₀ at R and Z_L, fractions of R. */
export const DECK_VISIBILITY = 0.004
export const DECK_SUN_DEPTH = 0.006
/**
 * [TUNE] The share of the cloud top's daylight the fog keeps at the floor
 * (deckDayLight), the eye's sunlight falling geometrically between.
 */
export const DECK_FLOOR_LIGHT = 0.45
/**
 * [TUNE] How far the layer at the fog's base shows through it from inside
 * (DeckProfile layerSeen), a fraction of R: about half the nadir at the
 * floor, a third at rest, gone well before the horizon.
 */
export const DECK_LAYER_SEEN = 0.011
/** Scale heights under R over which the layer eases in (deckLayerShow). */
export const DECK_LAYER_EASE_HEIGHTS = 1
/** No tint. */
export const DECK_NO_TINT: readonly [number, number, number] = [1, 1, 1]
/**
 * [TUNE] Jupiter's in-deck tint: half way from white to its haze sky's
 * colour (#f2d9b0, linear 0.888, 0.694, 0.434), at its Rec. 709 luminance
 * of 1, so the fog keeps its brightness and warms.
 */
export const JUPITER_INSIDE_TINT: readonly [number, number, number] = [1.1, 0.99, 0.82]

function deckProfile(scaleHeight: number, insideTint = DECK_NO_TINT): DeckProfile {
  return {
    base: DECK_BASE,
    floor: DECK_FLOOR,
    scaleHeight,
    top: 1 + DECK_TOP_HEIGHTS * scaleHeight,
    visibility: DECK_VISIBILITY,
    sunDepth: DECK_SUN_DEPTH,
    layerSeen: DECK_LAYER_SEEN,
    insideTint,
  }
}

/** [TUNE] The giants' decks, by scale height: Jupiter 0.004, Saturn 0.005, Uranus and Neptune 0.006. */
export const DECK_PROFILES: Readonly<Partial<Record<PlanetKey, DeckProfile>>> = {
  jupiter: deckProfile(0.004, JUPITER_INSIDE_TINT),
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

/**
 * How far into the fog under the cloud top an eye `distance` from the
 * centre is (the shader's uDeckInside): exactly 0 at and over R, so the
 * deck-top and approach views keep the globe's lighting, 1 from one scale
 * height under it down, smoothstepped as deckFade is.
 */
export function deckInside(distance: number, R: number, profile: DeckProfile): number {
  const x = clamp01((R - distance) / (R * profile.scaleHeight))
  return x * x * (3 - 2 * x)
}

/**
 * The fog's daylight for an eye `distance` from the centre with the Sun at
 * cos(zenith) `muSun` there (the shader's uDeckLight, what its direct
 * term blends to by deckInside): the Sun's elevation, dimmed with depth
 * under R to DECK_FLOOR_LIGHT of it at the floor, so a daytime dive stays
 * lit and the night side dark.
 */
export function deckDayLight(distance: number, muSun: number, R: number, profile: DeckProfile): number {
  const depth = Math.max(R - distance, 0) / R
  return Math.max(muSun, 0) * DECK_FLOOR_LIGHT ** (depth / Math.max(1 - profile.floor, 1e-6))
}

/**
 * How much of the textured layer at the fog's base (R·base, nothing solid)
 * an eye `distance` from the centre sees through the fog (the shader's
 * uLayerShow, tides-ufyr.4.1): exactly 0 at and over R, so the deck-top and
 * approach views are as before, 1 from DECK_LAYER_EASE_HEIGHTS scale
 * heights under it down, smoothstepped; 0 throughout with no layerSeen.
 * Without it the view inside is one fog colour every way (its colour point
 * a few km ahead); the layer gives the nadir texture and the horizon fog.
 */
export function deckLayerShow(distance: number, R: number, profile: DeckProfile): number {
  if (!(profile.layerSeen > 0)) return 0
  const x = clamp01((R - distance) / (R * DECK_LAYER_EASE_HEIGHTS * profile.scaleHeight))
  return x * x * (3 - 2 * x)
}

/**
 * How far along a ray from radius `r` at cos(zenith) `mu` it falls to
 * radius `level` (one unit): Infinity for a climbing or level ray, or one
 * that passes over it, 0 for an eye at or under it. In the form that keeps
 * its precision near the nadir, c/(−b + sqrt(b² − c)) with b = r·mu and
 * c = (r − level)(r + level).
 */
export function deckLayerHit(r: number, mu: number, level: number): number {
  if (r <= level) return 0
  if (mu >= 0) return Infinity
  const b = r * mu
  const c = (r - level) * (r + level)
  const h = b * b - c
  if (h < 0) return Infinity
  return c / (-b + Math.sqrt(h))
}

/**
 * The layer's share of a ray's colour at distance `s` along it (the
 * shader's, before uLayerShow): e^(−s/seen), 0 for a miss (Infinity) or
 * with `seen` 0.
 */
export function deckLayerWeight(s: number, seen: number): number {
  if (!(seen > 0) || !Number.isFinite(s)) return 0
  return Math.exp(-s / seen)
}

/** A vector by its components (a THREE.Vector3 is one). */
export interface DeckVector {
  x: number
  y: number
  z: number
}

/**
 * The Sun's cos(zenith) at an eye `eye` from a planet's centre, toward the
 * Sun along `toSun` (any length; the two in one frame): what deckSunlight
 * and deckDayLight take as muSun. 1, the Sun overhead, when either is zero.
 */
export function deckSunElevation(eye: DeckVector, toSun: DeckVector): number {
  const lengths = Math.hypot(eye.x, eye.y, eye.z) * Math.hypot(toSun.x, toSun.y, toSun.z)
  return lengths > 0 ? (eye.x * toSun.x + eye.y * toSun.y + eye.z * toSun.z) / lengths : 1
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

/**
 * The share of the Sun's glow (the glow pass's, renderers/glow, which the
 * fog shell doesn't draw into) that reaches an eye `distance` from the
 * centre of a planet of radius `R`, with the Sun at cos(zenith) `muSun`:
 * the fog's transmittance toward it, eased in as the fog is (deckFade), so
 * 1 over the shell's top and nearly 0 deep in the deck.
 */
export function deckSunlight(distance: number, muSun: number, R: number, profile: DeckProfile): number {
  const fade = deckFade(distance, R, profile)
  if (fade === 0) return 1
  const through = Math.exp(-deckColumn(distance, muSun, R, R * profile.scaleHeight) / (R * profile.visibility))
  return 1 - fade * (1 - through)
}

/**
 * The cloud deck the ship's eye is in this frame, if any (ShipController
 * fills it, tides-ufyr.8.3): the giant's key and deckSunlight there, which
 * the Sun's glow scales by for the camera near that giant (SunGlow.tsx).
 */
export const deckEye: { key: string | null; sunlight: number } = { key: null, sunlight: 1 }

/** Sets deckEye; null and 1 for none. */
export function setDeckEye(key: string | null, sunlight: number): void {
  deckEye.key = key
  deckEye.sunlight = key === null ? 1 : sunlight
}
