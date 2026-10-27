// The gravity wells' rings in ship mode (tides-h6a): where each body's
// slowdown band starts (its outer ring, faint and dashed) and where its well
// begins (its inner ring, brighter), from flight.ts' bandEdgeGap and
// wellEdgeGap. Each ring is the outline of its sphere seen from the ship,
// so it reads as a circle round the body from any angle, where a ring in the
// orbital plane would be edge-on most of the time near the ecliptic.
//
// A moon has one ring, where its well takes over from its planet's (the gap
// at which its cap falls under its planet's cap at the moon): deep in its
// planet's well (the Moon, Io) that is close in, out in the planet's band
// (Callisto) further. A planet's outer ring likewise stops where the Sun's
// band would still be slower (Mercury's), so every ring marks where the
// speed starts to answer to that body.
//
// Clutter: inner and moon rings show for every body big enough on screen
// (RING_MIN_PX); outer rings only for the nearest body and the locked target
// (a moon's planet, for a moon), so a cruise across the system doesn't draw
// a 300-unit circle round every planet. A ring fades out as the ship nears
// it and is gone inside it: there is no outline to draw from within.

import * as THREE from 'three'
import { BAND_RATE, K_WELL, V_TOP, WELL_EDGE_SPEED, bandEdgeGap, wellEdgeGap, wellFactor, wellSpeedOf } from './flight'
import { isMoonBody, moonParent } from './ship-targeting'
import { smoothstep } from './dust'

/**
 * [TUNE] A ring's projected radius, CSS px, over which it fades in: hidden
 * under the first, full from the second. Under ~12 px a ring would only
 * thicken its body's dot.
 */
export const RING_FADE_PX: readonly [number, number] = [12, 24]

/**
 * [TUNE] The ship's distance from the body's centre over the ring's radius
 * across which a ring fades out as the ship nears it: full beyond the
 * second, gone at the first (and inside).
 */
export const RING_INSIDE_FADE: readonly [number, number] = [1, 1.15]

/**
 * [TUNE] Opacity at full strength: the well's ring reads over the band's,
 * and a moon's under its planet's, so a moon system's rings (Jupiter's
 * four) don't crowd the planet's own.
 */
export const INNER_RING_OPACITY = 0.5
export const OUTER_RING_OPACITY = 0.28
export const MOON_RING_OPACITY = 0.3

/** A moon's ring is drawn only if it reaches this many times its radius off its centre. */
export const MOON_RING_MIN_RADII = 2

/** The body a ring's speed answers to past it: a moon's planet (Earth for the Moon), a planet's Sun. */
export function ringParent(key: string): string | null {
  if (key === 'sun') return null
  return moonParent(key) ?? 'sun'
}

/**
 * The gap, scene units, at which a body whose gap e-folds every `wellTime`
 * s has the cap `speed` (wellSpeedOf's inverse): inside its well under
 * WELL_EDGE_SPEED, in its band above it. NaN for no speed.
 */
export function gapForSpeed(speed: number, wellTime: number): number {
  if (!(speed >= 0)) return NaN
  return speed <= WELL_EDGE_SPEED
    ? speed * wellTime
    : wellEdgeGap(wellTime) + (Math.min(speed, V_TOP) - WELL_EDGE_SPEED) / BAND_RATE
}

/** A body as the rings see it. */
export interface RingBody {
  key: string
  position: THREE.Vector3
  radius: number
  mass?: number
}

/**
 * Radii from the centre, scene units: `inner` the well's edge, `outer` where
 * the body's band starts to bind (NaN for none). A moon's single ring is its
 * `inner`, where it takes over from its planet.
 */
export interface Rings {
  inner: number
  outer: number
}

/** The ring radii for `body`, its `parent` (ringParent) placed as it is now, or null. */
export function wellRings(body: RingBody, parent: RingBody | null, out: Rings): Rings {
  const T = wellFactor(body.mass) / K_WELL
  // The cap the parent sets at this body's centre: past the gap where this
  // body's cap reaches it, the parent's is the slower.
  const parentCap = parent
    ? Math.min(V_TOP, wellSpeedOf(body.position.distanceTo(parent.position) - parent.radius, wellFactor(parent.mass) / K_WELL))
    : V_TOP
  const binding = Math.min(gapForSpeed(parentCap, T), bandEdgeGap(T))
  if (isMoonBody(body.key)) {
    // A moon: one ring, where it takes over.
    out.inner = binding >= (MOON_RING_MIN_RADII - 1) * body.radius ? body.radius + binding : NaN
    out.outer = NaN
    return out
  }
  const edge = wellEdgeGap(T)
  out.inner = body.radius + edge
  out.outer = binding > edge ? body.radius + binding : NaN
  return out
}

// A moon's planet, else the body itself.
function systemOf(key: string): string {
  return moonParent(key) ?? key
}

/** Whether `key`'s outer ring is drawn: it, or its moon, is the nearest body or the target. */
export function showsOuter(key: string, nearestKey: string | null, targetKey: string | null): boolean {
  return (nearestKey != null && systemOf(nearestKey) === key) || (targetKey != null && systemOf(targetKey) === key)
}

/**
 * A ring's projected radius, CSS px: the outline of a sphere of `radius`
 * seen from `distance` off its centre, through a camera of vertical field
 * `fovRad` on a view `heightPx` tall. Infinity from inside.
 */
export function ringRadiusPx(radius: number, distance: number, fovRad: number, heightPx: number): number {
  if (!(distance > radius)) return Infinity
  const sin = radius / distance
  return (sin / Math.sqrt(1 - sin * sin) / Math.tan(fovRad / 2)) * (heightPx / 2)
}

/** A ring's strength, 0..1: faded in by its size on screen and out as the ship nears it. */
export function ringStrength(radius: number, distance: number, fovRad: number, heightPx: number): number {
  if (!(radius > 0) || !(distance > 0)) return 0
  const inside = smoothstep(RING_INSIDE_FADE[0], RING_INSIDE_FADE[1], distance / radius)
  if (inside <= 0) return 0
  const px = ringRadiusPx(radius, distance, fovRad, heightPx)
  return inside * smoothstep(RING_FADE_PX[0], RING_FADE_PX[1], px)
}

/**
 * Place a unit circle in its XY plane (`object`) on the outline of the
 * sphere of `radius` round `centre` as seen from `eye`: the circle where
 * the sight lines graze it, ρ² / d toward the eye, of radius ρ · √(1 − ρ²/d²),
 * facing the eye. The eye must be outside (ringStrength is 0 inside).
 */
export function placeRing(object: THREE.Object3D, centre: THREE.Vector3, radius: number, eye: THREE.Vector3): void {
  toEye.subVectors(eye, centre)
  const d = toEye.length()
  toEye.divideScalar(d)
  const share = radius / d
  object.position.copy(centre).addScaledVector(toEye, radius * share)
  object.quaternion.setFromUnitVectors(Z, toEye)
  object.scale.setScalar(radius * Math.sqrt(Math.max(0, 1 - share * share)))
}

const toEye = new THREE.Vector3()
const Z = new THREE.Vector3(0, 0, 1)
