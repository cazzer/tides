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
import { PHONE_VIEW_PX } from '../system-aids/label-style'
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

/** The stand-in globe's least radius on screen, CSS px. [TUNE] */
export const MARKER_PX = { desktop: 14, phone: 10 }

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

/** A circle on screen, CSS px from the view's centre (y up). */
export interface ScreenCircle {
  x: number
  y: number
  r: number
}

/** A box on screen, CSS px from the view's centre (y up). */
export interface ScreenBox {
  left: number
  right: number
  bottom: number
  top: number
}

/** A stroke on screen from (ax, ay) to (bx, by), `r` px either side of it,
 * CSS px from the view's centre (y up). */
export interface ScreenSegment {
  ax: number
  ay: number
  bx: number
  by: number
  r: number
}

export interface LabelSideInput {
  /** The dot, px from the view's centre (y up). */
  dotX: number
  dotY: number
  /** The way out from the Sun at the dot, on screen (any length). */
  outX: number
  outY: number
  halfW: number
  halfH: number
  /** The gap kept between the dot's centre and the label's edge, px. */
  clearPx: number
  viewW: number
  viewH: number
  /** Drawn shapes that stay put, the label keeps off if it can: the Sun
   * and the stops' globes (circles), the stops' axes (segments). */
  obstacles: readonly ScreenCircle[]
  segments: readonly ScreenSegment[]
  /** Earth's own globe and axis, kept off too, but going by: a label
   * would rather sit where Earth will pass than over the Sun or a stop. */
  passing: readonly ScreenCircle[]
  passingSegments: readonly ScreenSegment[]
  /** The demo's boxes over the view, its caption and readouts: the label
   * must keep off them, as off the view's edge. */
  boxes: readonly ScreenBox[]
  /** The spot the label took last frame (LabelSpot's), if it showed: kept
   * while it stays as clear as any other, so the label doesn't hop back and
   * forth as Earth goes by. */
  held: number | null
}

/** Where labelSide puts a label: its centre, px from the view's centre (y
 * up), and which of its spots round the dot that is. */
export interface LabelSpot {
  x: number
  y: number
  spot: number
}

// A label keeps this far inside the view's edge and off the demo's boxes. [TUNE]
const LABEL_EDGE_MARGIN_PX = 8
// Left or right of its dot while the way out is at least this much sideways
// on screen (a cosine), else above or below. [TUNE]
const LABEL_SIDEWAYS = 0.35
// Rings of spots round the dot, each this much farther out than the last,
// for when every spot of the first is taken. [TUNE]
const LABEL_RINGS = 3
const LABEL_RING_STEP_PX = 8

// What a spot must keep off, strictest first: everything; all but Earth;
// only the view's edge and the demo's boxes.
const KEEP_ALL = 0
const KEEP_FIXED = 1
const KEEP_BOXES = 2

// Whether the stroke from (ax, ay) to (bx, by) meets the box x0..x1, y0..y1
// (Liang–Barsky's clip, slab by slab).
function segmentMeetsBox(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): boolean {
  let t0 = 0
  let t1 = 1
  const dx = bx - ax
  const dy = by - ay
  if (dx === 0) {
    if (ax < x0 || ax > x1) return false
  } else {
    const ta = (x0 - ax) / dx
    const tb = (x1 - ax) / dx
    t0 = Math.max(t0, Math.min(ta, tb))
    t1 = Math.min(t1, Math.max(ta, tb))
    if (t0 > t1) return false
  }
  if (dy === 0) return ay >= y0 && ay <= y1
  const ta = (y0 - ay) / dy
  const tb = (y1 - ay) / dy
  t0 = Math.max(t0, Math.min(ta, tb))
  t1 = Math.min(t1, Math.max(ta, tb))
  return t0 <= t1
}

function offShapes(
  x: number,
  y: number,
  halfW: number,
  halfH: number,
  circles: readonly ScreenCircle[],
  segments: readonly ScreenSegment[]
): boolean {
  for (const { x: cx, y: cy, r } of circles) {
    const nearX = Math.min(Math.max(cx, x - halfW), x + halfW)
    const nearY = Math.min(Math.max(cy, y - halfH), y + halfH)
    if (Math.hypot(cx - nearX, cy - nearY) < r) return false
  }
  for (const { ax, ay, bx, by, r } of segments) {
    if (segmentMeetsBox(ax, ay, bx, by, x - halfW - r, y - halfH - r, x + halfW + r, y + halfH + r)) return false
  }
  return true
}

// Whether a label centred at (x, y) stays in the view and off the demo's
// boxes, and off the drawn shapes `keep` asks for.
function boxFits(x: number, y: number, input: LabelSideInput, keep: number): boolean {
  const { halfW, halfH, viewW, viewH, boxes } = input
  const m = LABEL_EDGE_MARGIN_PX
  if (Math.abs(x) + halfW > viewW / 2 - m) return false
  if (Math.abs(y) + halfH > viewH / 2 - m) return false
  for (const box of boxes) {
    if (x + halfW > box.left - m && x - halfW < box.right + m && y + halfH > box.bottom - m && y - halfH < box.top + m) {
      return false
    }
  }
  if (keep === KEEP_BOXES) return true
  if (!offShapes(x, y, halfW, halfH, input.obstacles, input.segments)) return false
  return keep === KEEP_FIXED || offShapes(x, y, halfW, halfH, input.passing, input.passingSegments)
}

// A label above or below its dot slid along into the view (beside it, up
// or down), so far as it still spans the dot: `at` is its centre on that
// axis, `half` its half size, `viewHalf` the view's.
function slideIn(at: number, half: number, viewHalf: number): number {
  const room = viewHalf - LABEL_EDGE_MARGIN_PX - half
  if (room < 0) return at
  return Math.min(at + half, Math.max(at - half, Math.min(room, Math.max(-room, at))))
}

// `clearPx`, widened to clear any of `circles` over the dot at (x, y): by
// the circle's far edge while it covers the dot, tapering off as it moves
// away, so a label held beside Earth eases out and in rather than jumping.
function clearOf(circles: readonly ScreenCircle[], x: number, y: number, clearPx: number): number {
  for (const c of circles) {
    const d = Math.hypot(c.x - x, c.y - y)
    clearPx = Math.max(clearPx, d < c.r ? d + c.r : 3 * c.r - d)
  }
  return clearPx
}

/** How many spots labelSide tries round a dot. */
const LABEL_SPOTS = 8 * LABEL_RINGS

// Spot `spot` round the dot (into `out`), at `clearPx` from it: the sides,
// then the corners, ring by ring.
function spotAt(spot: number, input: LabelSideInput, clearPx: number, out: { x: number; y: number }) {
  const { dotX, dotY, outX, outY, halfW, halfH, viewW, viewH } = input
  const sideways = Math.abs(outX) >= LABEL_SIDEWAYS * Math.hypot(outX, outY)
  const sx = Math.sign(outX) || 1
  const sy = Math.sign(outY) || 1
  const clear = clearPx + Math.floor(spot / 8) * LABEL_RING_STEP_PX
  const k = spot % 8
  if (k < 4) {
    // The sides: (dx, dy) unit steps, primary first.
    const flip = k % 2 === 0 ? 1 : -1
    const along = k < 2 === sideways
    const dx = along ? sx * flip : 0
    const dy = along ? 0 : sy * flip
    out.x = dx ? dotX + dx * (clear + halfW) : slideIn(dotX, halfW, viewW / 2)
    out.y = dy ? dotY + dy * (clear + halfH) : slideIn(dotY, halfH, viewH / 2)
  } else {
    // The corners, the label's nearest corner `clear` from the dot.
    const cx = k < 6 ? sx : -sx
    const cy = k % 2 === 0 ? sy : -sy
    out.x = dotX + cx * (clear * Math.SQRT1_2 + halfW)
    out.y = dotY + cy * (clear * Math.SQRT1_2 + halfH)
  }
}

/**
 * Where an apsis label's centre goes, px from the view's centre (into
 * `out`, with the spot's number). Spots in turn, round the dot: beside it
 * on the side away from the Sun (left or right unless that is nearly
 * straight up or down), the other side, above or below (each slid into the
 * view so far as it still spans the dot), then the four corners; then the
 * same a ring farther out, LABEL_RINGS rings. The first spot inside the
 * view and off the demo's boxes and every drawn shape wins; else the first
 * off all but Earth; else the first off the boxes alone; else the first
 * spot. The spot it took last frame (`held`) goes before the rest at each
 * of those, so it stays while it is as clear as any. Anything over the dot
 * is cleared all round.
 */
export function labelSide(input: LabelSideInput, out: LabelSpot): LabelSpot {
  const { dotX, dotY } = input
  // Clear of anything over the dot too, as Earth at its closest.
  const clearPx = clearOf(input.passing, dotX, dotY, clearOf(input.obstacles, dotX, dotY, input.clearPx))
  const held = input.held
  for (let keep = KEEP_ALL; keep <= KEEP_BOXES; keep++) {
    for (let n = -1; n < LABEL_SPOTS; n++) {
      // The held spot first, then the rest in turn.
      const spot = n < 0 ? held : n
      if (spot === null || (n >= 0 && n === held)) continue
      spotAt(spot, input, clearPx, out)
      if (boxFits(out.x, out.y, input, keep)) {
        out.spot = spot
        return out
      }
    }
  }
  spotAt(0, input, clearPx, out)
  out.spot = 0
  return out
}

/** A camera's view offset (setViewOffset, as DemoPlayer frames the demo's
 * band), as the shift it gives everything on screen, CSS px (y up): a point
 * on the camera's axis shows this far from the view's centre. */
export function viewShift(
  view: { enabled: boolean; offsetX: number; offsetY: number } | null | undefined,
  out: { x: number; y: number }
): { x: number; y: number } {
  out.x = view?.enabled ? -view.offsetX : 0
  out.y = view?.enabled ? view.offsetY : 0
  return out
}

/** A DOM rect (viewport px) as a box from the centre of the view at
 * `view` (viewport px), into `out`; whether it overlaps the view at all. */
export function chromeBox(
  rect: { left: number; top: number; right: number; bottom: number },
  view: { left: number; top: number; width: number; height: number },
  out: ScreenBox
): boolean {
  const centreX = view.left + view.width / 2
  const centreY = view.top + view.height / 2
  out.left = rect.left - centreX
  out.right = rect.right - centreX
  out.top = centreY - rect.top
  out.bottom = centreY - rect.bottom
  return out.right > -view.width / 2 && out.left < view.width / 2 && out.top > -view.height / 2 && out.bottom < view.height / 2
}
