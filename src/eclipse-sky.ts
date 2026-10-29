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

// The solar eclipse demo's View from Earth (tides-zec.1). The sky Sun is ~43×
// its true size (sky.ts); at its usual size and true direction the Moon would
// overlap it whenever they are within ~17°, and at the Sun's scale but its
// true direction a 57% partial would look 98% covered. So, demo only, the
// Moon is drawn at the Sun's scale k and its offset from the Sun is scaled by
// k too, up to first contact: coveredFraction depends only on the radii and
// the separation over the Sun's radius, so every phase looks as it truly
// does. Past contact the offset grows at its true rate, so the Moon never
// jumps.

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
 * The Sun and Moon from lat/lon at t, as skyPositionAt places them (apparent,
 * topocentric, equator of date). One shared object, recomputed only when t
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

/** How many times its true angular size the sky Sun is drawn. */
export function eclipseSkyScale(e: EclipseSky, sunSceneRadius: number, sunDistance: number): number {
  return Math.asin(sunSceneRadius / sunDistance) / e.sunRadius
}

/**
 * The drawn Moon's angle from the drawn Sun for a true separation: k times
 * it until the discs part (contact, the sum of the true radii), then the
 * true rate on from there. Continuous and increasing; never past π.
 */
export function skyOffset(separation: number, contact: number, k: number): number {
  const offset = separation <= contact ? k * separation : k * contact + (separation - contact)
  return Math.min(offset, Math.PI)
}

const axis = new THREE.Vector3()

/** The drawn Moon's unit direction: the Sun's, turned toward the true Moon by skyOffset. */
export function eclipseMoonDirection(e: EclipseSky, k: number, out = new THREE.Vector3()): THREE.Vector3 {
  if (e.separation < 1e-9) return out.copy(e.moon)
  axis.crossVectors(e.sun, e.moon).normalize()
  const offset = skyOffset(e.separation, e.sunRadius + e.moonRadius, k)
  return out.copy(e.sun).applyAxisAngle(axis, offset)
}

/** How far from the eye a Moon of moonSceneRadius looks k times its true size. */
export function matchedMoonDistance(moonSceneRadius: number, k: number, moonRadius: number): number {
  return moonSceneRadius / Math.sin(k * moonRadius)
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
