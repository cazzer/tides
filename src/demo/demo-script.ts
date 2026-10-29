// What a demo is (tides-zec.5): a fixed list of steps, each a moment in time
// and a way of looking at it, with a caption saying what to notice.

import { Quaternion, Vector3 } from 'three'
import type {
  Layout,
  Location,
  PanelKey,
  PlanetFocus,
  SystemAids,
} from '../store'
import type { SkyLook } from '../sky-look'

export type DemoFocus = 'sun' | 'earth' | 'moon' | PlanetFocus

/** What a DemoPose's azimuth and elevation are measured against. */
export type DemoFrame = 'sun' | 'stars' | 'earth'

/**
 * Where the main view's eye sits, relative to the focused body. `distance`
 * is in scene units from the focus's centre, at least minDistance(focus).
 * The angles (deg) depend on `frame`:
 * - 'sun' (the default): `azimuth` turns about +Y (ecliptic north),
 *   counter-clockwise seen from the north, from 0 = from the focus toward
 *   the Sun (for the Sun itself, toward Earth); `elevation` is above the
 *   ecliptic plane.
 * - 'stars': `azimuth` is the ecliptic longitude of the eye seen from the
 *   focus, 0 toward the vernal equinox (scene -X), 90 = +Z, counter-clockwise
 *   about +Y; `elevation` is above the ecliptic. The eye keeps its place
 *   against the stars as the focus moves.
 * - 'earth': `azimuth` is the geographic east longitude and `elevation` the
 *   latitude of the point under the eye, which turns with Earth as shown.
 * A pose in 'stars' or 'earth' is followed for as long as the step runs.
 */
export interface DemoPose {
  focus: DemoFocus
  frame?: DemoFrame
  azimuth: number
  elevation: number
  distance: number
  /** Scene units about the focus kept in view: on a view too narrow for
   * them at `distance`, the eye backs off until they fit (poseDistance). */
  fit?: number
}

/** What a travel holds still on the way: Earth's spin, or the Moon (hidden). */
export type TravelHold = 'spin' | 'moon'

/**
 * How the clock gets from the instant shown to a step's date: eased over
 * `seconds`, or played at `rate` (sim seconds a second, like timeScale).
 * Reduced motion, or a rate that would take over TRAVEL_MAX_SECONDS, cuts.
 */
export type DemoTravel = ({ seconds: number; rate?: never } | { rate: number; seconds?: never }) & {
  hold?: TravelHold[]
  /** The pose held on the way, about the step's own camera focus; the eye
   * eases to the step's camera on arrival. Needs the step's camera. */
  camera?: Omit<DemoPose, 'focus'>
}

/**
 * A span of a step's time played over and over (tides-zec.15): the clock
 * runs from `from` to `to` (ISO 8601) at the step's speed, rests `holdMs` on
 * `to`, then starts again from `from`; after `times` passes it stops on `to`.
 * Forward only. Reduced motion plays one pass; the bar's Replay starts it
 * again.
 */
export interface DemoLoop {
  from: string
  to: string
  times: number
  holdMs?: number
}

/** The clock's speed from `at` (ISO 8601) on, within a step. */
export interface DemoSpeed {
  at: string
  timeScale: number
}

export interface DemoOverlays {
  showPlanets?: boolean
  showConstellations?: boolean
  showConstellationArt?: boolean
  showLunar?: boolean
  showZodiac?: boolean
  systemAids?: Partial<SystemAids>
}

/**
 * Demo-only drawing aids (tides-zec.1). Unlike DemoOverlays they are never
 * written to the store, so they can't reach the URL or outlast the demo: the
 * scene reads them from the running step through demoAidOn (demo-aids.ts).
 */
export interface DemoAids {
  /** View from Earth: the Moon at the Sun's scale, a daylit sky that dims
   * with the Sun and the corona only once the Sun is hidden. */
  solarEclipseSky?: boolean
  /** Main view: the Moon's tilted orbit, the ecliptic and the node line. */
  moonNodes?: boolean
  /** Main view: Earth's axis, the subsolar dot and the readout latitude's
   * ring, plus the sunlight readout (tides-zec.3). */
  seasons?: boolean
  /** Main view: the Moon's and Sun's tidal pull as arrows round Earth, the
   * sea's equilibrium shape drawn exaggerated, a marked spot and the tide
   * readout (tides-zec.4). */
  tides?: boolean
  /** With `tides`: the Sun's arrows, its share of the sea's shape and of the
   * readout. Off, the tides aid shows the Moon's pull alone. */
  tidesSun?: boolean
  /** Main view: the Moon's umbra on Earth filled and ringed and the
   * penumbra's edge ringed, from the true shadow geometry (tides-zec.7). */
  moonShadow?: boolean
  /** Main view: the Moon is hidden, its body, refs and camera carrying on. */
  hideMoon?: boolean
  /** Main view: Earth's umbra and penumbra as circles at the Moon, from the
   * true shadow geometry, with the Moon's track across them and marks at the
   * umbral contacts (tides-zec.13). */
  earthShadow?: boolean
  /** With earthShadow: the previous and next full Moons' places beside the
   * shadow, which they miss. Not drawn without it. */
  fullMoonGhosts?: boolean
  /** With `moonShadow`: the path of totality darkened behind the umbra, from
   * landfall up to the sim time (tides-zec.12). */
  totalityPath?: boolean
  /** Main view: the month names round Earth's orbit, hidden in a demo
   * otherwise (the 3D clock always is: the caption's is the only one). */
  monthLabels?: boolean
}

/**
 * One stop. Every field but `date`, `travel`, `loop`, `speeds` and `caption`
 * carries over to the steps after it until one sets it again; before the
 * first step to set it, the user's own setting stands.
 */
export interface DemoStep {
  /** ISO 8601, UTC. */
  date: string
  /** The clock stops here (ISO 8601); omit to let it run. */
  until?: string
  /** Moving to this step from another, the clock travels to `date` rather
   * than cutting to it. Entering the demo always cuts. */
  travel?: DemoTravel
  timeScale?: number
  /** The first pass runs from `date`, the rest from `loop.from`. */
  loop?: DemoLoop
  /** Speed changes as the clock passes each `at`; on a loop, each pass
   * starts again at the speed for `loop.from`. */
  speeds?: DemoSpeed[]
  camera?: DemoPose
  mainPanel?: PanelKey
  layout?: Layout
  location?: Location
  skyLook?: SkyLook
  /** null is View from Earth's default field of view. */
  skyFov?: number | null
  overlays?: DemoOverlays
  /** Carries over like the rest; false turns one off again. */
  aids?: DemoAids
  caption: { title: string; body: string }
}

export interface Demo {
  id: string
  title: string
  blurb: string
  steps: DemoStep[]
}

const _ref = new Vector3()
const _up = new Vector3(0, 1, 0)

// eyeDirection's azimuth 0: the focus-to-Sun direction (Sun-to-Earth for
// the Sun itself) flattened onto the ecliptic plane, unit.
function sunReference(focus: Vector3, sun: Vector3, earth: Vector3, out: Vector3): Vector3 {
  if (focus.distanceToSquared(sun) < 1e-12) out.subVectors(earth, sun)
  else out.subVectors(sun, focus)
  out.y = 0
  if (out.lengthSq() < 1e-12) out.set(1, 0, 0)
  return out.normalize()
}

/**
 * The unit direction from the focus to the eye for a DemoPose's azimuth and
 * elevation (degrees). The reference is the focus-to-Sun direction flattened
 * onto the ecliptic plane, or Sun-to-Earth for the Sun itself.
 */
export function eyeDirection(
  focus: Vector3,
  sun: Vector3,
  earth: Vector3,
  azimuthDeg: number,
  elevationDeg: number,
  out = new Vector3()
): Vector3 {
  sunReference(focus, sun, earth, _ref).applyAxisAngle(_up, (azimuthDeg * Math.PI) / 180)
  const elevation = (elevationDeg * Math.PI) / 180
  return out
    .copy(_ref)
    .multiplyScalar(Math.cos(elevation))
    .addScaledVector(_up, Math.sin(elevation))
    .normalize()
}

/** Where a pose's angles are measured from, in world space. */
export interface PoseBodies {
  focus: Vector3
  sun: Vector3
  earth: Vector3
  /** Earth's world orientation, spin included. */
  earthTurn: Quaternion
}

const _vernal = new Vector3(-1, 0, 0)

/** The unit direction from the focus to the eye for `pose` in its frame. */
export function poseDirection(
  pose: Pick<DemoPose, 'frame' | 'azimuth' | 'elevation'>,
  bodies: PoseBodies,
  out = new Vector3()
): Vector3 {
  const { azimuth, elevation } = pose
  if (pose.frame === 'earth') {
    // As calculateLocationAndRotationForLatLng (utils.ts) places the location
    // pin, so a pose over a city sits over its pin: longitude 0 on +X, east
    // toward -Z. Inlined, as it runs every frame.
    const lat = (elevation * Math.PI) / 180
    const lon = (azimuth * Math.PI) / 180
    return out
      .set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon))
      .applyQuaternion(bodies.earthTurn)
      .normalize()
  }
  if (pose.frame === 'stars') {
    const lift = (elevation * Math.PI) / 180
    return out
      .copy(_vernal)
      .applyAxisAngle(_up, (azimuth * Math.PI) / 180)
      .multiplyScalar(Math.cos(lift))
      .addScaledVector(_up, Math.sin(lift))
      .normalize()
  }
  return eyeDirection(bodies.focus, bodies.sun, bodies.earth, azimuth, elevation, out)
}

const _frameRef = new Vector3()
const _frameTurn = new Quaternion()

/**
 * A pose frame's world orientation: Earth's turn for 'earth', none for
 * 'stars', and for 'sun' the turn about the ecliptic pole taking +X onto
 * eyeDirection's reference, which swings round as the focus orbits.
 */
export function poseFrameTurn(frame: DemoFrame, bodies: PoseBodies, out = new Quaternion()): Quaternion {
  if (frame === 'earth') return out.copy(bodies.earthTurn)
  if (frame === 'stars') return out.identity()
  const ref = sunReference(bodies.focus, bodies.sun, bodies.earth, _frameRef)
  return out.setFromAxisAngle(_up, Math.atan2(-ref.z, ref.x))
}

/** World `v` in a pose frame's own axes, so it can be kept turning with it. */
export function intoPoseFrame(v: Vector3, frame: DemoFrame, bodies: PoseBodies, out = new Vector3()): Vector3 {
  return out.copy(v).applyQuaternion(poseFrameTurn(frame, bodies, _frameTurn).invert())
}

/** `v` in a pose frame's own axes, back in world space as the frame stands now. */
export function outOfPoseFrame(v: Vector3, frame: DemoFrame, bodies: PoseBodies, out = new Vector3()): Vector3 {
  return out.copy(v).applyQuaternion(poseFrameTurn(frame, bodies, _frameTurn))
}

/**
 * A pose's eye distance in a view of vertical field `vfovDeg` and `aspect`
 * (width / height): its `distance`, or farther if a sphere of radius `fit`
 * about the focus would not fit the view's narrower half-angle there.
 */
export function poseDistance(pose: Pick<DemoPose, 'distance' | 'fit'>, vfovDeg: number, aspect: number): number {
  if (!(pose.fit && pose.fit > 0)) return pose.distance
  const halfV = (vfovDeg * Math.PI) / 360
  const half = Math.min(halfV, Math.atan(Math.tan(halfV) * aspect))
  return Math.max(pose.distance, pose.fit / Math.sin(half))
}

const _fromDir = new Vector3()
const _turn = new Quaternion()
const _partial = new Quaternion()

/**
 * The eye `t` (0..1) of the way from `from` (eye minus target when the step
 * began) to `goal` (eyeDirection) at `distance`, turning along the arc and
 * scaling the distance geometrically. It is placed about the focus, not the
 * view's target: a step's date jump moves the focus far from the target,
 * which CameraProvider turns about the eye, so an eye placed about the target
 * fed back into it and flew off (tides-ytp).
 */
export function easedEye(
  from: Vector3,
  goal: Vector3,
  focus: Vector3,
  t: number,
  distance: number,
  out = new Vector3()
): Vector3 {
  const fromDistance = from.length()
  if (!(fromDistance > 0)) return out.copy(goal).multiplyScalar(distance).add(focus)
  _fromDir.copy(from).divideScalar(fromDistance)
  _turn.setFromUnitVectors(_fromDir, goal)
  _partial.identity().slerp(_turn, t)
  const eased = Math.exp((1 - t) * Math.log(fromDistance) + t * Math.log(distance))
  return out.copy(_fromDir).applyQuaternion(_partial).multiplyScalar(eased).add(focus)
}

/** 0..1 smoothstep of the ease's progress. */
export function easeProgress(elapsed: number, duration: number): number {
  if (!(duration > 0)) return 1
  const t = Math.min(1, Math.max(0, elapsed / duration))
  return t * t * (3 - 2 * t)
}

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** The sim time as the captions quote it: "3 Mar 2026, 11:33 UTC". */
export function formatDemoTime(timestamp: number): string {
  return `${timeFormat.format(timestamp)} UTC`
}
