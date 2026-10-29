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

/**
 * Where the main view's eye sits, relative to the focused body. `azimuth`
 * (deg) turns about +Y (ecliptic north), counter-clockwise seen from the
 * north, from 0 = from the focus toward the Sun (for the Sun itself, toward
 * Earth). `elevation` (deg) is above the ecliptic plane. `distance` is in
 * scene units from the focus's centre, at least minDistance(focus).
 */
export interface DemoPose {
  focus: DemoFocus
  azimuth: number
  elevation: number
  distance: number
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
}

/**
 * One stop. Every field but `date` and `caption` carries over to the steps
 * after it until one sets it again; before the first step to set it, the
 * user's own setting stands.
 */
export interface DemoStep {
  /** ISO 8601, UTC. */
  date: string
  /** The clock stops here (ISO 8601); omit to let it run. */
  until?: string
  timeScale?: number
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
  if (focus.distanceToSquared(sun) < 1e-12) _ref.subVectors(earth, sun)
  else _ref.subVectors(sun, focus)
  _ref.y = 0
  if (_ref.lengthSq() < 1e-12) _ref.set(1, 0, 0)
  _ref.normalize().applyAxisAngle(_up, (azimuthDeg * Math.PI) / 180)
  const elevation = (elevationDeg * Math.PI) / 180
  return out
    .copy(_ref)
    .multiplyScalar(Math.cos(elevation))
    .addScaledVector(_up, Math.sin(elevation))
    .normalize()
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
