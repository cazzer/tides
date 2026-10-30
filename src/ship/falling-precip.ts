// Rain and snow falling around the ship under a precipitating cloud
// (tides-bl3.3): the pure maths behind FallingPrecip's shader and its frame
// gate. The shader repeats the fades with these constants (glsl()).
//
// Scale. Near the ground the ship flies at true scale: EARTH_UNITS_PER_METRE
// scene units a metre (~4.63e-7), its air speed read in true m/s (frame-
// carry.ts), the ground at its true height, and FINE_DECK's base 3 km over it
// (TRUE_CLOUD_UNITS_PER_KM is within 1% of 1000 EARTH_UNITS_PER_METRE). So
// the drops are sized and fall in true metres, in a box PRECIP_HALF_METRES
// around the eye, and stream past at the speed the HUD reads. SpaceDust's
// units (layer 0 half a unit, ~2160 km) are space's, gone in the air.
//
// The drops are fixed in the air and fall through it: each kind's lattice
// moves by (air velocity − down · fall) · dt relative to the eye
// (stepAnchor), wrapped per axis on the CPU in doubles, so the shader works
// near the eye in float32. A streak is that relative motion over a shutter
// (streakVector), so it lengthens with speed. Under prefers-reduced-motion
// the fall and the snow's sway stop: rain hangs as short still streaks, snow
// as still flakes, both moving past only as the ship moves.

import type * as THREE from 'three'
import { EARTH_UNITS_PER_METRE } from '../surface-handover'
import { CLOUD_FLAT_ALTITUDE, type CloudDeck } from '../cloud-layer'
import type { PrecipRate } from '../forecast-clouds'
import { clamp01, positiveMod, smoothstep } from './dust'

export type PrecipTier = 'high' | 'low'
export type PrecipKind = 'rain' | 'snow'

/** Drops allocated (and drawn at the full rate) per tier: one instanced draw. [TUNE] */
export const PRECIP_PARTICLES: Readonly<Record<PrecipTier, number>> = { high: 4000, low: 1500 }
/** The box around the eye, half its side, true metres. */
export const PRECIP_HALF_METRES = 25
export const PRECIP_HALF = PRECIP_HALF_METRES * EARTH_UNITS_PER_METRE

/** Terminal fall speeds, m/s: a raindrop's, a snowflake's. */
export const RAIN_FALL_MS = 8
export const SNOW_FALL_MS = 1
/** The streak shutter, seconds: a drop at rest draws ~0.36 m. */
export const SHUTTER_S = 0.045
/** Longest streak, as a share of the box's half-side. */
export const MAX_STREAK_SHARE = 0.5
/** A still raindrop's streak under reduced motion, m. */
export const REDUCED_RAIN_STREAK_M = 0.35
/** Snow's sway: amplitude, m, and rate, Hz. */
export const SNOW_SWAY_M = 0.3
export const SNOW_SWAY_HZ = 0.35

/**
 * The rate ramp, mm/h of water: nothing under RATE_MIN, full density at
 * RATE_FULL, square root between so light rain shows. The 10° grid's rates
 * are smooth (at one hour 80% of the cloudy texels were under 0.1 mm/h, 1.4%
 * over 1, the peak ~3), so 0.1 is light visible rain (~0.19 of full), 0.5
 * about half and 1-2 heavy. [TUNE]
 */
export const RATE_MIN_MM_H = 0.03
export const RATE_FULL_MM_H = 2
/** Snow's water counts this much more: a mm/h of it is a thick fall. */
export const SNOW_VISUAL_GAIN = 2.5

/** The fade over the cloud base, true km at the deck's own vertical scale
 * (deck.unitsPerKm): it rains in the cloud's lower part, not over it. */
export const ABOVE_BASE_FADE_KM = 1

/** How often the rate under the eye is read, ms, and its ease, s. */
export const SAMPLE_MS = 250
export const RATE_TAU_S = 1.5
/** Under this the field is not drawn at all. */
export const SHOWN_EPS = 0.005

/** Fades by distance from the eye as a share of the half-side (as dust.ts). */
export const NEAR_FADE: readonly [number, number] = [0.08, 0.2]
export const EDGE_FADE: readonly [number, number] = [0.7, 1]
/** Air speeds, m/s, over which the field fades out: past them it is noise. */
export const SPEED_FADE_MS: readonly [number, number] = [600, 1500]

/** Peak opacities, and the share under reduced motion. */
export const RAIN_OPACITY = 0.35
export const SNOW_OPACITY = 0.8
export const REDUCED_OPACITY = 0.6
/** Light at night, as a share of day's, and under the deck. */
export const NIGHT_LIGHT = 0.08
export const UNDER_CLOUD_LIGHT = 0.6

/** A number as a GLSL float literal. */
export function glsl(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : `${x}`
}

export interface PrecipIntensity {
  /** 0..1: the share of the tier's drops drawn. */
  amount: number
  /** 0..1: the share of them that are snow. */
  snowShare: number
}

/** How much falls, and how much of it is snow, at a rate (null: no data, dry). */
export function precipIntensity(rate: PrecipRate | null): PrecipIntensity {
  if (!rate) return { amount: 0, snowShare: 0 }
  const liquid = Math.max(0, rate.rain) + Math.max(0, rate.showers)
  const snow = Math.max(0, rate.snow)
  const effective = liquid + SNOW_VISUAL_GAIN * snow
  const amount =
    effective <= RATE_MIN_MM_H ? 0 : clamp01(Math.sqrt((effective - RATE_MIN_MM_H) / (RATE_FULL_MM_H - RATE_MIN_MM_H)))
  const total = liquid + snow
  return { amount, snowShare: total > 0 ? snow / total : 0 }
}

/**
 * The cloud base over the ground, scene units: the flat shell's altitude
 * less the ground on the low-quality path (`flat`), else the deck's clearance.
 */
export function baseOverGround(flat: boolean, deck: CloudDeck, groundOverSea: number): number {
  return flat ? CLOUD_FLAT_ALTITUDE - groundOverSea : deck.clearance
}

/** 1 under the base, fading to 0 over `band` above it. */
export function altitudeFade(eyeOverGround: number, base: number, band: number): number {
  return 1 - smoothstep(base, base + band, eyeOverGround)
}

/** Drops drawn at `amount` on `tier`. */
export function particleCount(tier: PrecipTier, amount: number): number {
  return Math.round(PRECIP_PARTICLES[tier] * clamp01(amount))
}

/** Fall speed, scene units/s; none under reduced motion. */
export function fallSpeed(kind: PrecipKind, reduced: boolean): number {
  if (reduced) return 0
  return (kind === 'rain' ? RAIN_FALL_MS : SNOW_FALL_MS) * EARTH_UNITS_PER_METRE
}

/** Snow's sway amplitude, scene units; none under reduced motion. */
export function swayAmplitude(reduced: boolean): number {
  return reduced ? 0 : SNOW_SWAY_M * EARTH_UNITS_PER_METRE
}

/**
 * Steps a kind's wrap anchor (where the eye is in its lattice) over `dt`:
 * the eye moves through the air at `airVelocity`, the drops fall at `fall`
 * along `down`, so relative to them the eye moves by (air − down · fall) dt.
 * Each axis wrapped to [0, 2 half). Mirrors dust.ts wrapCoord's offset.
 */
export function stepAnchor(
  anchor: THREE.Vector3,
  airVelocity: THREE.Vector3,
  down: THREE.Vector3,
  fall: number,
  dt: number,
  half: number
): THREE.Vector3 {
  const side = 2 * half
  anchor.x = positiveMod(anchor.x + (airVelocity.x - down.x * fall) * dt, side)
  anchor.y = positiveMod(anchor.y + (airVelocity.y - down.y * fall) * dt, side)
  anchor.z = positiveMod(anchor.z + (airVelocity.z - down.z * fall) * dt, side)
  return anchor
}

/**
 * Into `out`: a drop's streak, head (where it is) to tail (where it was a
 * shutter ago), world frame, scene units, capped at MAX_STREAK_SHARE of
 * `half`. Rain: its motion relative to the eye, (air − down · fall) times
 * the shutter; under reduced motion a fixed REDUCED_RAIN_STREAK_M upward in
 * place of the fall. Snow: the air's part only (a flake falls too slowly to
 * streak).
 */
export function streakVector(
  out: THREE.Vector3,
  air: THREE.Vector3,
  down: THREE.Vector3,
  fall: number,
  half: number,
  reduced: boolean,
  kind: PrecipKind
): THREE.Vector3 {
  out.copy(air).multiplyScalar(SHUTTER_S)
  if (kind === 'rain') {
    const drop = reduced ? REDUCED_RAIN_STREAK_M * EARTH_UNITS_PER_METRE : fall * SHUTTER_S
    out.addScaledVector(down, -drop)
  }
  const cap = MAX_STREAK_SHARE * half
  const length = out.length()
  if (length > cap) out.multiplyScalar(cap / length)
  return out
}

/** 1 at walking speed, 0 past SPEED_FADE_MS[1] m/s through the air. */
export function speedFade(airMs: number): number {
  return 1 - smoothstep(SPEED_FADE_MS[0], SPEED_FADE_MS[1], airMs)
}

/** The light on the drops for the Sun's height over the eye's horizon
 * (`sunUp`, the cosine of its zenith angle): day's, dimming through dusk to
 * NIGHT_LIGHT. */
export function daylight(sunUp: number): number {
  return NIGHT_LIGHT + (1 - NIGHT_LIGHT) * smoothstep(-0.1, 0.2, sunUp)
}

/** Whether anything is drawn: below SHOWN_EPS the mesh is hidden (no draw). */
export function precipShown(amount: number, fade: number, speed: number): boolean {
  return amount * fade * speed > SHOWN_EPS
}

/** Whether to read the rate again at `nowMs`, last read at `lastMs`. */
export function shouldSample(nowMs: number, lastMs: number): boolean {
  return !(nowMs - lastMs < SAMPLE_MS)
}
