// What a demo is (tides-zec.5): a fixed list of steps, each a moment in time
// and a way of looking at it, with a caption saying what to notice.

import { Vector3 } from 'three'
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

/** 0..1 smoothstep of the ease's progress. */
export function easeProgress(elapsed: number, duration: number): number {
  if (!(duration > 0)) return 1
  const t = Math.min(1, Math.max(0, elapsed / duration))
  return t * t * (3 - 2 * t)
}
