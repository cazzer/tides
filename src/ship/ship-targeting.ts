// Target lock helpers (tides-3bl.5): projecting ship bodies to the screen,
// picking one under a tap, cycling through them, and placing the marker. The
// scene has no R3F pointer events in ship mode, so picking is done here
// against projected discs rather than by raycasting meshes; a small body far
// off is a few pixels across, and a generous disc is easier to hit.

import * as THREE from 'three'
import type { Body as FlightBody } from './flight'
import { isMoonKey } from '../moons/moon-keys'
import { MOONS } from '../moons/moons'

export interface ScreenBody {
  key: string
  /** CSS px from the view's top-left; meaningless unless inFront. */
  x: number
  y: number
  /** Projected radius, CSS px; Infinity with the camera inside the body. */
  radiusPx: number
  /** Camera to centre, scene units. */
  distance: number
  inFront: boolean
  /** Camera-space direction, for an edge arrow: right +x, down +y. */
  dirX: number
  dirY: number
}

export function createScreenBody(): ScreenBody {
  return {
    key: '',
    x: 0,
    y: 0,
    radiusPx: 0,
    distance: 0,
    inFront: false,
    dirX: 0,
    dirY: 0,
  }
}

const view = new THREE.Vector3()
const ndc = new THREE.Vector3()
const DEG = Math.PI / 180

/**
 * Project `body` for `camera` onto a `width` × `height` px view, into `out`.
 * The camera's world matrix and projection must be current.
 */
export function projectBody(
  body: FlightBody,
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
  out: ScreenBody
): ScreenBody {
  view.copy(body.position).applyMatrix4(camera.matrixWorldInverse)
  out.key = body.key
  out.distance = view.length()
  out.inFront = view.z < 0
  out.dirX = view.x
  out.dirY = -view.y
  ndc.copy(view).applyMatrix4(camera.projectionMatrix)
  out.x = ((ndc.x + 1) / 2) * width
  out.y = ((1 - ndc.y) / 2) * height
  out.radiusPx =
    out.distance > body.radius
      ? ((height / 2) * Math.tan(Math.asin(body.radius / out.distance))) /
        Math.tan((camera.fov / 2) * DEG)
      : Infinity
  return out
}

/** Earth's Moon or one of the planets' major moons. */
export function isMoonBody(key: string): boolean {
  return key === 'moon' || isMoonKey(key)
}

/** The planet a moon orbits, or null for anything else. */
export function moonParent(key: string): string | null {
  if (key === 'moon') return 'earth'
  return isMoonKey(key) ? MOONS[key].parent : null
}

/**
 * A moon smaller than this on screen, px radius, can't be picked while its
 * planet is under the tap too, unless it is already the target: from afar
 * Io sits inside Jupiter's dot, and a tap meant for the planet would lock
 * the moon (tides-2hv.12). Off on its own, a sub-pixel moon is still fair
 * game.
 */
export const PICK_MOON_MIN_PX = 1.5

/** A tap counts as on a body within this many px of its disc… */
export const PICK_SLOP = 12
/** …or of its centre, so a distant dot is still easy to hit. */
export const PICK_MIN_RADIUS = 24

/**
 * The body under a tap at (x, y), or null. Hits are within
 * max(PICK_MIN_RADIUS, radius + PICK_SLOP) of a body's centre; of several,
 * the one whose disc edge is nearest wins, and among discs the tap is inside,
 * the nearest to the camera (it is drawn in front). A moon under
 * PICK_MOON_MIN_PX is skipped when its planet is also hit, unless it is
 * `current`, the target already.
 */
export function pickBody(
  bodies: readonly ScreenBody[],
  x: number,
  y: number,
  current: string | null = null
): string | null {
  const hits = (body: ScreenBody) =>
    body.inFront &&
    Math.hypot(body.x - x, body.y - y) <= Math.max(PICK_MIN_RADIUS, body.radiusPx + PICK_SLOP)
  let best: ScreenBody | null = null
  let bestEdge = Infinity
  for (const body of bodies) {
    if (!hits(body)) continue
    if (body.key !== current && body.radiusPx < PICK_MOON_MIN_PX) {
      const parent = moonParent(body.key)
      if (parent != null && bodies.some((b) => b.key === parent && hits(b))) continue
    }
    const d = Math.hypot(body.x - x, body.y - y)
    const edge = Math.max(0, d - body.radiusPx)
    if (
      edge < bestEdge ||
      (edge === bestEdge && best != null && body.distance < best.distance)
    ) {
      best = body
      bestEdge = edge
    }
  }
  return best?.key ?? null
}

const forward = new THREE.Vector3()
const toBody = new THREE.Vector3()

/**
 * The next target for the T key: bodies ordered by angle off the camera's
 * nose (the screen centre), and the one after `current` in that order; the
 * nearest to centre when there is no current target or it is last.
 */
export function cycleTarget(
  bodies: readonly FlightBody[],
  camera: THREE.Camera,
  current: string | null
): string | null {
  if (bodies.length === 0) return null
  camera.getWorldDirection(forward)
  const order = bodies
    .map((body) => ({
      key: body.key,
      angle: forward.angleTo(toBody.subVectors(body.position, camera.position)),
    }))
    .sort((a, b) => a.angle - b.angle)
  const index = order.findIndex((entry) => entry.key === current)
  return order[(index + 1) % order.length].key
}

export interface EdgePoint {
  x: number
  y: number
  /** Radians, clockwise from pointing right (CSS rotate). */
  angle: number
}

/** A rectangle in view px. */
export interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Where an edge arrow for an off-screen target sits: on the edge of `bounds`,
 * in direction (dirX, dirY) from its centre (screen axes, +y down). Straight
 * behind (no direction) points down.
 */
export function edgePoint(dirX: number, dirY: number, bounds: Bounds): EdgePoint {
  let dx = dirX
  let dy = dirY
  const length = Math.hypot(dx, dy)
  if (length < 1e-9) {
    dx = 0
    dy = 1
  } else {
    dx /= length
    dy /= length
  }
  const halfW = Math.max(0, (bounds.right - bounds.left) / 2)
  const halfH = Math.max(0, (bounds.bottom - bounds.top) / 2)
  const t = Math.min(
    Math.abs(dx) > 1e-9 ? halfW / Math.abs(dx) : Infinity,
    Math.abs(dy) > 1e-9 ? halfH / Math.abs(dy) : Infinity
  )
  return {
    x: bounds.left + halfW + dx * t,
    y: bounds.top + halfH + dy * t,
    angle: Math.atan2(dy, dx),
  }
}

/**
 * What the scene side of targeting (ShipTargeting, in the R3F frame loop)
 * hands the DOM HUD, written every frame: true ranges for the nearest body
 * and the target, and the km per scene unit for speed (ship-distances.ts).
 * NaN until measured.
 */
export interface ShipNav {
  /** The body with the smallest true range; null until measured. */
  nearestKey: string | null
  nearestKm: number
  targetKm: number
  kmPerUnit: number
}

export const shipNav: ShipNav = {
  nearestKey: null,
  nearestKm: NaN,
  targetKm: NaN,
  kmPerUnit: NaN,
}

/**
 * The marker element (rendered by the HUD) that ShipTargeting positions each
 * frame, straight after the camera moves, so it never lags the scene; and the
 * size of the layer it sits in and the bottom of the HUD strip (which an edge
 * arrow keeps below), px, kept by the HUD's ResizeObserver so the frame loop
 * never reads layout.
 */
export const targetMarker: {
  current: HTMLElement | null
  width: number
  height: number
  hudBottom: number
} = { current: null, width: 0, height: 0, hudBottom: 0 }
