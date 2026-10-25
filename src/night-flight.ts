// The eye's night adaptation in flight (tides-tvr.2). The system view's
// night side is lit only by the faint ambient (./lighting.ts), right for a
// planet seen whole; from a ship low over it at night everything but the
// city lights read black. So near the ground at night two terms come in, by
// one adaptation `a`: a fill in the ambient's colour (the adapted eye's
// airglow and starlight) and the real Moon's light, weighted by its phase.
// Both are 0 by day, high up and in the system view. The maths here is pure;
// ./renderers/nightLights.ts puts it on the ground and the clouds' ambient.
import * as THREE from 'three'
import {
  AMBIENT_COLOR,
  CLOUD_AMBIENT,
  CLOUD_AMBIENT_SHARE,
  MOONLIGHT_COLOR,
  MOONLIGHT_INTENSITY,
  NIGHT_FILL_INTENSITY,
} from './lighting'

/** Height over the surface, in Earth radii, under which the eye is fully
 * adapted and over which it isn't at all: the ship's low stops (60 and
 * 400 km, ~0.01 and ~0.06 R) are within, a 3000 km climb (~0.47 R) all but
 * out. */
export const NIGHT_ADAPT_NEAR = 0.1
export const NIGHT_ADAPT_FAR = 0.5
/** sin(elevation) of the Sun at the sub-point: none from 2 deg up, full by
 * 8 deg down, past civil twilight. */
export const NIGHT_ADAPT_SUN_FROM = Math.sin((2 * Math.PI) / 180)
export const NIGHT_ADAPT_SUN_TO = Math.sin((-8 * Math.PI) / 180)
/** sin(elevation) of the Moon over which it lights the ground: it fades in
 * across the horizon rather than switch on. The shader uses the same. */
export const MOON_UP_FROM = -0.02
export const MOON_UP_TO = 0.06

/** GLSL's smoothstep, edges either way round. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** The adaptation, 0 to 1, for the Sun at `sunSin` (sin of its elevation
 * at the sub-point) and the eye `gap` Earth radii over the surface. */
export function nightAdaptation(sunSin: number, gap: number): number {
  const darkness = smoothstep(NIGHT_ADAPT_SUN_FROM, NIGHT_ADAPT_SUN_TO, sunSin)
  const nearness = 1 - smoothstep(NIGHT_ADAPT_NEAR, NIGHT_ADAPT_FAR, gap)
  return darkness * nearness
}

/** The Moon's illuminated fraction from Earth, for unit directions from
 * Earth's centre to the Sun and to the Moon. */
export function moonIlluminatedFraction(sunDir: THREE.Vector3, moonDir: THREE.Vector3): number {
  return (1 - sunDir.dot(moonDir)) / 2
}

/** Moonlight's strength for an illuminated fraction: stylised, so that a
 * quarter Moon gives a quarter of the full one's light (the real fall-off,
 * with the opposition surge, is steeper still: about a tenth). */
export function moonlightStrength(fraction: number): number {
  return fraction * fraction
}

/** How much of the Moon's light reaches ground where it stands at `moonSin`
 * (sin of its elevation). */
export function moonUp(moonSin: number): number {
  return smoothstep(MOON_UP_FROM, MOON_UP_TO, moonSin)
}

/** Linear colours times their intensities. Shared: don't change them. */
export const NIGHT_FILL_RGB = new THREE.Color(AMBIENT_COLOR).multiplyScalar(NIGHT_FILL_INTENSITY)
export const MOONLIGHT_RGB = new THREE.Color(MOONLIGHT_COLOR).multiplyScalar(MOONLIGHT_INTENSITY)

const luminance = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b

/**
 * The cloud shell's ambient (its one scalar, for the whole shell, from the
 * ship's sub-point): CLOUD_AMBIENT plus the fill and the moonlight on a level
 * deck, as the ground's ambient is turned into the cloud's (CLOUD_AMBIENT
 * _SHARE). Exactly CLOUD_AMBIENT when the eye isn't adapted.
 */
export function nightCloudAmbient(adaptation: number, strength: number, moonSin: number): number {
  if (adaptation === 0) return CLOUD_AMBIENT
  const moon = luminance(MOONLIGHT_RGB) * strength * moonUp(moonSin) * Math.max(moonSin, 0)
  return CLOUD_AMBIENT + ((adaptation * CLOUD_AMBIENT_SHARE) / Math.PI) * (luminance(NIGHT_FILL_RGB) + moon)
}
