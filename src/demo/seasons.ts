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

import { Body, Equator, Observer } from 'astronomy-engine'
import { airMass } from '../cloud-layer'
import type { Location } from '../store'

/** W/m² at 1 AU above the air (TSI, Kopp & Lean 2011). */
export const SOLAR_CONSTANT = 1361

/** The readout's latitude with no pin set: a mid-latitude of either season.
 * Not DEFAULT_SURFACE_LOCATION (sky.ts), which is in the south. */
export const SEASONS_FALLBACK_LAT = 45

/** The almanac's sunrise: the Sun's top edge on the horizon, refraction in. */
const SUNRISE_ALTITUDE = -0.833

// Below this the equinox's day is too dark to compare against.
const TILT_PERCENT_FLOOR_WM2 = 5

const DEG = Math.PI / 180

export function seasonsLatitude(location: Location | null): { lat: number; pinned: boolean } {
  return location ? { lat: location.lat, pinned: true } : { lat: SEASONS_FALLBACK_LAT, pinned: false }
}

/** The Sun's declination (deg, of date) and distance (AU) at `ms`. */
export function sunForSeasons(ms: number): { dec: number; distanceAu: number } {
  const eq = Equator(Body.Sun, new Date(ms), new Observer(0, 0, 0), true, true)
  return { dec: eq.dec, distanceAu: eq.dist }
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
  /** Degrees; negative when the Sun stays down all day. */
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
