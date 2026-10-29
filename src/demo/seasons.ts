// The seasons demo's sunlight sums (tides-zec.3): how high the noon Sun gets,
// how long the day is and how much sunlight a latitude gets, for the Sun's
// declination and distance at an instant.
//
// Daily sunlight above the air is the textbook mean over 24 h (Hartmann,
// Global Physical Climatology, eq. 2.15; Berger 1978):
//   Q = S0 / (π r²) · (H0 sin φ sin δ + cos φ cos δ sin H0)
// with H0 the sunset hour angle, cos H0 = −tan φ tan δ, clamped to 0 (polar
// night) or π (midnight Sun). At the ground the noon beam is Meinel's clear-sky
// attenuation, 0.7^(AM^0.678), with Kasten & Young's air mass (cloud-layer.ts).
// The tilt's share compares Q with the same day at the equinox at 1 AU; the
// distance's, with the same declination at 1 AU.

import { Body, EquatorFromVector, GeoVector, KM_PER_AU, RotateVector, Rotation_EQJ_EQD } from 'astronomy-engine'
import { airMass } from '../cloud-layer'
import { subsolarPoint } from '../geo-clouds'
import type { Location } from '../store'
import { earthSpinLag } from './demo-travel'

/** W/m² at 1 AU above the air (TSI, Kopp & Lean 2011). */
export const SOLAR_CONSTANT = 1361

/** The readout's latitude with no pin set: a mid-latitude of either season.
 * Not DEFAULT_SURFACE_LOCATION (sky.ts), which is in the south. */
export const SEASONS_FALLBACK_LAT = 45

/** The almanac's sunrise: the Sun's top edge on the horizon, refraction in.
 * The day's length and whether the noon Sun is up both use it, so they
 * agree. */
export const SUNRISE_ALTITUDE = -0.833

// Below this the equinox's day is too dark to compare against.
const TILT_PERCENT_FLOOR_WM2 = 5

const DEG = Math.PI / 180

export function seasonsLatitude(location: Location | null): { lat: number; pinned: boolean } {
  return location ? { lat: location.lat, pinned: true } : { lat: SEASONS_FALLBACK_LAT, pinned: false }
}

/** The Sun's declination (deg, of date) and distance (AU) from Earth's
 * centre at `ms`. */
export function sunForSeasons(ms: number): { dec: number; distanceAu: number } {
  const date = new Date(ms)
  const sun = RotateVector(Rotation_EQJ_EQD(date), GeoVector(Body.Sun, date, true))
  return { dec: EquatorFromVector(sun).dec, distanceAu: sun.Length() }
}

/** The hour angle (radians) at which the Sun sets to `altitudeDeg`: 0 when
 * it never rises that high, π when it never sets below it. */
export function sunsetHourAngle(latDeg: number, decDeg: number, altitudeDeg = 0): number {
  const phi = latDeg * DEG
  const dec = decDeg * DEG
  const x = (Math.sin(altitudeDeg * DEG) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec))
  if (x >= 1) return 0
  if (x <= -1) return Math.PI
  return Math.acos(x)
}

/** The day's mean sunlight above the air (W/m²) at a latitude. */
export function dailyTop(latDeg: number, decDeg: number, distanceAu: number): number {
  const phi = latDeg * DEG
  const dec = decDeg * DEG
  const h0 = sunsetHourAngle(latDeg, decDeg)
  const q =
    (SOLAR_CONSTANT / (Math.PI * distanceAu * distanceAu)) *
    (h0 * Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.sin(h0))
  return Math.max(0, q)
}

export interface Insolation {
  /** Degrees, geometric (no refraction); below SUNRISE_ALTITUDE the Sun
   * stays down all day. */
  noonAltitude: number
  daylightHours: number
  /** W/m² on a flat surface at noon, above the air and at the ground. */
  noonTop: number
  noonGround: number
  /** The day's mean W/m² above the air. */
  dailyTop: number
  /** Against the same day at the equinox (both at 1 AU); percent is a
   * fraction, null when the equinox's day is too dark to compare. */
  tilt: { wm2: number; percent: number | null }
  /** Against the same declination at 1 AU. */
  distance: { wm2: number; percent: number }
}

export function insolation(latDeg: number, decDeg: number, distanceAu: number): Insolation {
  const atDistance = SOLAR_CONSTANT / (distanceAu * distanceAu)
  const noonAltitude = 90 - Math.abs(latDeg - decDeg)
  const mu = Math.sin(noonAltitude * DEG)
  const q = dailyTop(latDeg, decDeg, distanceAu)
  const q1 = dailyTop(latDeg, decDeg, 1)
  const equinox = dailyTop(latDeg, 0, 1)
  return {
    noonAltitude,
    daylightHours: (24 * sunsetHourAngle(latDeg, decDeg, SUNRISE_ALTITUDE)) / Math.PI,
    noonTop: atDistance * Math.max(0, mu),
    noonGround: mu > 0 ? atDistance * 0.7 ** (airMass(mu) ** 0.678) * mu : 0,
    dailyTop: q,
    tilt: {
      wm2: q1 - equinox,
      percent: equinox < TILT_PERCENT_FLOOR_WM2 ? null : q1 / equinox - 1,
    },
    distance: { wm2: q - q1, percent: 1 / (distanceAu * distanceAu) - 1 },
  }
}

/**
 * A latitude's circle on a globe of `radius`, in the frame
 * calculateLocationAndRotationForLatLng (utils.ts) places points in: y north,
 * so it sits under Earth's tilt and spin with the globe. The circle is
 * centred on the axis at height `y`, `radius` across.
 */
export function latitudeCircle(latDeg: number, radius: number): { y: number; radius: number } {
  return { y: radius * Math.sin(latDeg * DEG), radius: radius * Math.cos(latDeg * DEG) }
}

/**
 * Where the Sun is overhead on the globe as drawn at t, degrees: the true
 * subsolar point, east by the spin a demo travel holds the globe short of
 * the true one, so it stays under the Sun as the held globe turns.
 */
export function shownSubsolarPoint(t: number): { lat: number; lon: number } {
  const sun = subsolarPoint(t)
  return { lat: sun.lat, lon: sun.lon + earthSpinLag(t) / DEG }
}

// The orbit aid's sums (SeasonsOrbit.tsx): in the wide view between stops,
// Earth is ~21 CSS px across its radius on a desktop and ~10 on a phone, and
// its own axis (SeasonsGlobe) a hair. So the aid draws a bold axis through
// it, a stand-in globe the same size where Earth was at each stop reached,
// and the orbit's nearest and farthest points; all of it fades out as the
// eye closes on the globe.

/**
 * Earth's apsides on either side of the tour, from astronomy-engine's
 * SearchPlanetApsis(Body.Earth, …) with the app's ΔT (delta-t.ts;
 * seasons.test.ts checks them): aphelion 6 July 2026, perihelion 3 January
 * 2027, the tour's last stop.
 */
export const SEASONS_APSIDES = [
  { kind: 'farthest', t: Date.parse('2026-07-06T18:00:30Z'), distanceAu: 1.016646 },
  { kind: 'closest', t: Date.parse('2027-01-03T02:07:49Z'), distanceAu: 0.983331 },
] as const

/** "Closest · 147.1 million km". */
export function apsisLabel(kind: 'closest' | 'farthest', distanceAu: number): string {
  const millions = ((distanceAu * KM_PER_AU) / 1e6).toFixed(1)
  return `${kind === 'closest' ? 'Closest' : 'Farthest'} · ${millions} million km`
}

/** A view this wide or narrower sizes the stand-in at phone size, CSS px
 * (label-style.ts's PHONE_VIEW_PX). */
const PHONE_VIEW_PX = 600

/** The stand-in globe's least radius on screen, CSS px. [TUNE] */
export const MARKER_PX = { desktop: 14, phone: 10 }

/** Scene units a CSS px spans `depth` in front of a perspective eye. */
export function unitsPerPixel(depth: number, fovDeg: number, heightPx: number): number {
  return (2 * depth * Math.tan((fovDeg * DEG) / 2)) / heightPx
}

/**
 * The stand-in globe's radius, scene units, where a CSS px spans `upp`: the
 * marker size on screen, but never smaller than the true globe (`radius`),
 * so a stand-in left at a stop matches Earth as drawn beside it.
 */
export function markerRadius(upp: number, radius: number, viewWidthPx: number): number {
  const px = viewWidthPx <= PHONE_VIEW_PX ? MARKER_PX.phone : MARKER_PX.desktop
  return Math.max(px * upp, radius)
}

// Under this the true globe reads as a dot whose axis can't be seen; over
// the second the eye is on the globe itself. CSS px of its radius. [TUNE]
const WIDE_FULL_PX = 32
const WIDE_GONE_PX = 56

function smoothstep(edge0: number, edge1: number, x: number): number {
  const s = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return s * s * (3 - 2 * s)
}

/** How far into the wide view the eye is, 0..1, by the true globe's radius
 * on screen (CSS px): 1 between stops, 0 in a close-up. */
export function wideFade(globePx: number): number {
  return 1 - smoothstep(WIDE_FULL_PX, WIDE_GONE_PX, globePx)
}

/** The stand-in over the true globe shows only once it is clearly the
 * larger, by the ratio of their radii; under it the true globe shows. */
export function standInFade(markerOverGlobe: number): number {
  return smoothstep(1.3, 2, markerOverGlobe)
}

/**
 * The instants the tour has left a stand-in at: every stop before `step`,
 * and `step`'s own once its travel has landed.
 */
export function ghostDates(stepDates: readonly number[], step: number, landed: boolean): number[] {
  return stepDates.slice(0, Math.max(0, Math.min(stepDates.length, landed ? step + 1 : step)))
}

/** Earth's north pole as a scene direction for a tilt (degrees): the
 * globe's +Y under the tilt about scene X that body-transform.ts applies,
 * leaning toward +Z; the spin, about that axis, leaves it. */
export function northAxis(tiltDeg: number): [number, number, number] {
  return [0, Math.cos(tiltDeg * DEG), Math.sin(tiltDeg * DEG)]
}
