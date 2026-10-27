// Space dust and the speed FOV kick (tides-3bl.6): the pure maths behind
// SpaceDust's shader and useSpeedFov. The shader repeats wrapCoord and the
// fade curves in GLSL with these constants; the tests here pin the
// behaviour both share.
//
// Scale. Ship speeds run from V_NORMAL (0.25 units/s, skimming the Moon) to
// hundreds of units/s in cruise. One dust box can't serve that range: sized
// for the Moon, cruise crosses it several times a frame and the field turns
// to noise; sized for cruise, the Moon-skimming ship never sees a mote move.
// So the dust comes in layers: layer k is a box DUST_SIZE_BASE^k times the
// first, tuned for DUST_SPEED_BASE^k times V_NORMAL, and the field crossfades
// between the two layers either side of the current speed. Each layer is
// world-fixed, so motes move with true parallax and swing with rotation, and
// a layer swaps scale only while its weight is zero, so nothing pops. Boxes
// grow more slowly than the speeds they serve (3× per 4×), so a faster ship
// crosses its box faster: more speed reads as more motion at every scale.
// The streak shutter also opens with the layer level, so motes are dots at
// skimming speed and streaks in cruise, capped at a share of the box and
// dimmed as they lengthen so cruise never whites out.

import { V_NORMAL, V_TOP } from './flight'
import { SHIP_FOV } from './ship-session'

/** Speed ratio between adjacent dust layers. */
export const DUST_SPEED_BASE = 4
/** Box-size ratio between adjacent dust layers (< DUST_SPEED_BASE, see above). */
export const DUST_SIZE_BASE = 3
/** Layer 0's half-size, scene units: crossed in ~4 s at V_NORMAL. */
export const DUST_HALF_SIZE = 1

/** Streak shutter at layer level 0, seconds; it opens by this much per level. */
export const STREAK_TIME = 0.015
/** Longest streak, as a share of its layer's half-size. */
export const MAX_STREAK_SHARE = 0.1

// Fades by distance from the camera as a share of the layer's half-size.
// Near, by straight-line distance: the near plane reaches 0.1 units
// (shipNear), a tenth of layer 0's half-size, so motes are gone before it
// can clip them; nearer motes would also streak across the whole screen.
// Edge, by distance to the box's nearest face (the largest coordinate), so
// the whole box is used and a mote wrapping across a face is invisible as it
// jumps.
export const NEAR_FADE: readonly [number, number] = [0.12, 0.3]
export const EDGE_FADE: readonly [number, number] = [0.7, 1]

/**
 * Dust opacity at rest, as a share of moving: barely there, so parked motes
 * don't read as specks on a planet's disc or as extra stars.
 */
export const STOPPED_OPACITY = 0.22
/**
 * How much the dust dims by high cruise, and the speed depths it dims over
 * (speedDepth: ~4.4 units/s to V_TOP). [TUNE] The heading stays dark: motes
 * there come head-on and barely streak.
 */
export const CRUISE_DIM = 0.65
export const CRUISE_DIM_DEPTH: readonly [number, number] = [0.45, 1]
/** Dust opacity under prefers-reduced-motion, as a share of normal. */
export const REDUCED_MOTION_OPACITY = 0.5
/** A streak's brightness never falls below this share of a dot's. */
export const STREAK_ENERGY_FLOOR = 0.45

/** Extra vertical FOV at the cruise cap, degrees. */
export const FOV_KICK = 10
/**
 * Speed depths over which the kick comes in (speedDepth: ~2.4 to ~79
 * units/s). [TUNE] The cap scales with distance, so full throttle past the
 * Moon is still a crawl and gets no kick, nor does an Earth → Moon cruise
 * (~2.7 units/s); it is for interplanetary speed.
 */
export const FOV_KICK_DEPTH: readonly [number, number] = [0.35, 0.9]
/** Time constant of the FOV's ease toward its speed target, seconds. */
export const FOV_TAU = 0.5

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/** `a` mod `n` in [0, n), for negative `a` too (GLSL's mod). */
export function positiveMod(a: number, n: number): number {
  return a - n * Math.floor(a / n)
}

/**
 * The per-axis offset the shader wraps motes with, for a camera coordinate
 * and a layer half-size. Computed on the CPU in doubles so the shader works
 * near the camera in float32 however far out the ship is.
 */
export function wrapOffset(cameraCoord: number, halfSize: number): number {
  return positiveMod(cameraCoord - halfSize, 2 * halfSize)
}

type Xyz = { x: number; y: number; z: number }

/**
 * Where the dust wraps around: the camera less everything the frame carry
 * has moved the ship by (frame-carry.ts `carried`, tides-zmw.9.18), so the
 * motes ride with Earth as the ship does rather than streaming past a hover
 * at Earth's speed. Zero carried (?surface=0 or the low tier) leaves the camera's.
 */
export function dustAnchor<T extends Xyz>(camera: Xyz, carried: Xyz, out: T): T {
  out.x = camera.x - carried.x
  out.y = camera.y - carried.y
  out.z = camera.z - carried.z
  return out
}

/**
 * A mote's coordinate relative to the camera, in [−halfSize, halfSize): the
 * nearest copy of `seed` (0..1, its place in the box) in the world-fixed
 * lattice of boxes 2·halfSize apart. Mirrors the shader.
 */
export function wrapCoord(seed: number, halfSize: number, offset: number): number {
  const side = 2 * halfSize
  return positiveMod(seed * side - offset, side) - halfSize
}

/**
 * Where `speed` sits among the dust layers, as a continuous layer index:
 * 0 at or below V_NORMAL, +1 per DUST_SPEED_BASE× faster.
 */
export function dustLevel(speed: number): number {
  if (!(speed > V_NORMAL)) return 0
  return Math.log(speed / V_NORMAL) / Math.log(DUST_SPEED_BASE)
}

/**
 * Where `speed` sits between V_NORMAL (0) and V_TOP (1), on a log scale as
 * flight.ts velocityTau reads the cap: each doubling weighs the same, so the
 * cues spread evenly over the whole range the flight model flies
 * (tides-2hv.12). Clamped; overspeed past V_TOP reads as 1.
 */
export function speedDepth(speed: number): number {
  if (!(speed > V_NORMAL)) return 0
  return clamp01(Math.log(speed / V_NORMAL) / Math.log(V_TOP / V_NORMAL))
}

export function layerHalfSize(layer: number): number {
  return DUST_HALF_SIZE * DUST_SIZE_BASE ** layer
}

export interface SlotLayer {
  layer: number
  weight: number
}

/**
 * Which layer dust slot 0 or 1 draws at `level`, and how strongly. The two
 * layers either side of the level crossfade linearly (weights sum to 1);
 * even layers go in slot 0 and odd in slot 1, so a slot changes layer only
 * as the level passes the layer between, where its weight is zero.
 */
export function slotLayer(level: number, slot: 0 | 1): SlotLayer {
  const lower = Math.floor(level)
  const frac = level - lower
  return lower % 2 === slot
    ? { layer: lower, weight: 1 - frac }
    : { layer: lower + 1, weight: frac }
}

/** Streak shutter at `level`, seconds: dots at skimming speed, streaks in cruise. */
export function streakTime(level: number): number {
  return STREAK_TIME * (1 + level)
}

/**
 * World length of the streaks at `speed`, for a layer of `halfSize`: the
 * distance covered while the shutter is open, capped at MAX_STREAK_SHARE of
 * the layer's half-size.
 */
export function streakLength(speed: number, level: number, halfSize: number): number {
  return Math.min(speed * streakTime(level), MAX_STREAK_SHARE * halfSize)
}

/**
 * Opacity for a mote at camera-relative `x, y, z`, as shares of the layer's
 * half-size (each in −1..1).
 */
export function distanceFade(x: number, y: number, z: number): number {
  const distance = Math.hypot(x, y, z)
  const box = Math.max(Math.abs(x), Math.abs(y), Math.abs(z))
  return (
    smoothstep(NEAR_FADE[0], NEAR_FADE[1], distance) *
    (1 - smoothstep(EDGE_FADE[0], EDGE_FADE[1], box))
  )
}

/**
 * A streak's brightness as a share of a dot's, so a mote's light spreads
 * along its streak instead of adding to it. Both in pixels.
 */
export function streakEnergy(lengthPx: number, radiusPx: number): number {
  const dot = 2 * radiusPx
  return Math.max(STREAK_ENERGY_FLOOR, dot / (dot + lengthPx))
}

/** The whole field's opacity: dimmer at rest and in high cruise. */
export function motionOpacity(speed: number): number {
  const moving = STOPPED_OPACITY + (1 - STOPPED_OPACITY) * smoothstep(0, V_NORMAL, speed)
  const cruise =
    1 - CRUISE_DIM * smoothstep(CRUISE_DIM_DEPTH[0], CRUISE_DIM_DEPTH[1], speedDepth(speed))
  return moving * cruise
}

/** Exponential ease of `current` toward `target` over `dt` with time constant `tau`. */
export function easeToward(current: number, target: number, dt: number, tau: number): number {
  return target + (current - target) * Math.exp(-Math.max(0, dt) / tau)
}

/** Speed as a share of the cruise cap, 0..1 (0 before the cap is known). */
export function speedFraction(speed: number, speedCap: number): number {
  return speedCap > 0 ? clamp01(speed / speedCap) : 0
}

/**
 * How much of the FOV kick `speed` earns, 0..1: its share of the cruise cap,
 * weighted by how fast it is in absolute terms (FOV_KICK_DEPTH). Overspeed
 * earns no more than the cap: widening the view while a planet looms in
 * would only make the overshoot harder to read.
 */
export function fovKickShare(speed: number, speedCap: number): number {
  return (
    speedFraction(speed, speedCap) *
    smoothstep(FOV_KICK_DEPTH[0], FOV_KICK_DEPTH[1], speedDepth(speed))
  )
}

/**
 * The ship camera's vertical FOV, degrees, for a (smoothed) kick share. No
 * kick under prefers-reduced-motion.
 */
export function speedFov(share: number, reducedMotion = false): number {
  if (reducedMotion) return SHIP_FOV
  return SHIP_FOV + FOV_KICK * smoothstep(0, 1, share)
}
