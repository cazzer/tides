import * as THREE from 'three'
import {
  Body,
  Equator,
  KM_PER_AU,
  MakeTime,
  Observer,
  ObserverVector,
  RotateVector,
  Rotation_EQD_ECT,
  type Vector,
} from 'astronomy-engine'
import { eclipticToScene } from './ephemeris'
import { MOON_RADIUS_KM, SUN_RADIUS_KM, sunVisibleFraction } from './eclipse'

// View from Earth draws the Sun and Moon both at k times their true angular
// size: SKY_SCALE everywhere, the solar eclipse demo its own k ≈ 43 (its sky
// Sun keeps its scene radius at the system Sun's distance, sky.ts). At k× size
// but true directions the discs would overlap whenever they are within k× the
// sum of their radii, and a 57% partial would look far deeper. So the Moon's
// offset from the Sun is scaled by k too, up to first contact: coveredFraction
// depends only on the radii and the separation over the Sun's radius, so every
// phase looks as it truly does. Past contact the extra offset tapers back to
// none at opposition, so the Moon never jumps or stalls, and it is never more
// than (k − 1)× the sum of the radii from its true direction.

/**
 * How many times their true angular size View from Earth draws the Sun and
 * Moon outside the demos: big enough to see, small enough that the Sun's
 * upper limb leads sunrise by only (k − 1) × 0.27°. [TUNE]
 */
export const SKY_SCALE = 8

/** The Sun and Moon from a place on Earth at one moment. */
export interface EclipseSky {
  /** Unit topocentric directions, scene axes. */
  sun: THREE.Vector3
  moon: THREE.Vector3
  /** True angular radii and centre separation, radians. */
  sunRadius: number
  moonRadius: number
  separation: number
  /** Fraction of the Sun's disc not covered by the Moon. */
  visible: number
  /** Sine of the Sun's (geocentric-zenith) altitude. */
  sunSinAltitude: number
}

const sky: EclipseSky = {
  sun: new THREE.Vector3(),
  moon: new THREE.Vector3(),
  sunRadius: 0,
  moonRadius: 0,
  separation: 0,
  visible: 1,
  sunSinAltitude: 0,
}
// The cache's key: the moment and place `sky` was last computed for.
let cachedT = NaN
let cachedLat = NaN
let cachedLon = NaN

const origin = new THREE.Vector3()
const sunKm = new THREE.Vector3()
const moonKm = new THREE.Vector3()

function length(v: Vector): number {
  return Math.hypot(v.x, v.y, v.z)
}

/**
 * The Sun and Moon from lat/lon at t (apparent, topocentric, equator of
 * date), as skyDiscPositionsAt places them. One shared object, recomputed only when t
 * or the place changes: read it, don't keep it.
 */
export function eclipseSkyAt(t: number, lat: number, lon: number): EclipseSky {
  if (t === cachedT && lat === cachedLat && lon === cachedLon) return sky
  const site = new Observer(lat, lon, 0)
  const time = MakeTime(new Date(t))
  const sunEqd = Equator(Body.Sun, time, site, true, true).vec
  const moonEqd = Equator(Body.Moon, time, site, true, true).vec
  const toEcliptic = Rotation_EQD_ECT(time)
  eclipticToScene(RotateVector(toEcliptic, sunEqd), sky.sun)
  eclipticToScene(RotateVector(toEcliptic, moonEqd), sky.moon)
  sunKm.copy(sky.sun).multiplyScalar(KM_PER_AU)
  moonKm.copy(sky.moon).multiplyScalar(KM_PER_AU)
  sky.visible = sunVisibleFraction(origin, sunKm, moonKm, MOON_RADIUS_KM)

  const sunAu = length(sunEqd)
  const moonAu = length(moonEqd)
  sky.sunRadius = Math.asin(SUN_RADIUS_KM / (sunAu * KM_PER_AU))
  sky.moonRadius = Math.asin(MOON_RADIUS_KM / (moonAu * KM_PER_AU))
  sky.sun.normalize()
  sky.moon.normalize()
  // From the chord, as sunVisibleFraction: acos(dot) loses small angles.
  sky.separation = 2 * Math.asin(Math.min(1, sky.sun.distanceTo(sky.moon) / 2))
  const up = ObserverVector(time, site, true)
  sky.sunSinAltitude =
    (sunEqd.x * up.x + sunEqd.y * up.y + sunEqd.z * up.z) / (sunAu * length(up))
  cachedT = t
  cachedLat = lat
  cachedLon = lon
  return sky
}

/** How many times its true angular size a Sun of sunSceneRadius at sunDistance looks. */
export function eclipseSkyScale(e: EclipseSky, sunSceneRadius: number, sunDistance: number): number {
  return Math.asin(sunSceneRadius / sunDistance) / e.sunRadius
}

/**
 * The drawn Moon's angle from the drawn Sun for a true separation: k times
 * it until the discs part (contact, the sum of the true radii), then on to π
 * at a true π, the extra (k − 1) × contact tapering off linearly, so the Moon
 * reaches the antisolar point only at true opposition rather than parking
 * there around every full moon. Continuous and increasing.
 */
export function skyOffset(separation: number, contact: number, k: number): number {
  if (separation <= contact) return Math.min(k * separation, Math.PI)
  const atContact = k * contact
  // A scale so large the discs would touch past opposition: just clamp.
  if (atContact >= Math.PI) return Math.PI
  return atContact + ((separation - contact) * (Math.PI - atContact)) / (Math.PI - contact)
}

const axis = new THREE.Vector3()

/** The drawn Moon's unit direction: the Sun's, turned toward the true Moon by skyOffset. */
export function eclipseMoonDirection(e: EclipseSky, k: number, out = new THREE.Vector3()): THREE.Vector3 {
  axis.crossVectors(e.sun, e.moon)
  // In line (new or opposition) there is no plane to turn in, and none needed:
  // the offset is then 0 or π, the true Moon's own direction.
  if (axis.lengthSq() < 1e-18) return out.copy(e.moon)
  axis.normalize()
  const offset = skyOffset(e.separation, e.sunRadius + e.moonRadius, k)
  return out.copy(e.sun).applyAxisAngle(axis, offset)
}

/** How far from the eye a body of sceneRadius looks k times its true angular radius. */
export function matchedSkyDistance(sceneRadius: number, k: number, trueRadius: number): number {
  return sceneRadius / Math.sin(k * trueRadius)
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** 1 with the Sun up, easing to 0 as it sets. */
function sunUp(sunSinAltitude: number): number {
  return smoothstep(-0.05, 0.1, sunSinAltitude)
}

/**
 * The sky's share of full daylight while the Sun is up: never below this,
 * so totality reads as a deep night-blue, not black. [TUNE]
 */
export const TOTALITY_SKY = 0.04

/**
 * 0..1 sky brightness. The eye adapts, so the sky dims far slower than the
 * light falls (the power) until the last sliver of Sun; gone as it sets.
 */
export function eclipseSkyBrightness(visible: number, sunSinAltitude: number): number {
  return Math.max(visible ** 0.4, TOTALITY_SKY) * sunUp(sunSinAltitude)
}

/** 0..1 how much the daylit sky hides the stars: all of them until the last ~1% of the Sun. */
export function eclipseStarVeil(visible: number, sunSinAltitude: number): number {
  return smoothstep(0, 0.01, visible) * sunUp(sunSinAltitude)
}

/**
 * Below this fraction of the Sun showing, the corona is at full strength.
 * The real one shows only in the last seconds before totality. [TUNE]
 */
export const CORONA_SHOW_VISIBLE = 0.003

/** The corona's strength: full once the Sun is hidden, none while much of it shows. */
export function coronaFade(visible: number): number {
  return 1 - smoothstep(0, CORONA_SHOW_VISIBLE, visible)
}

/** The full-daylight sky colour (linear), dimmed by eclipseSkyBrightness. [TUNE] */
export const DAY_SKY = new THREE.Color().setRGB(0.08, 0.22, 0.58)

/** Whether the eclipse sky is drawn, and its eclipseStarVeil, read by the stars (as eyeSky). */
export const eclipseSkyVeil = { active: false, daylight: 0 }
