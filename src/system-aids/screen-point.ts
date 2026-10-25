// Where a scene point lands in the view, in CSS px, for the aids laid out on
// screen (BodyLabels, tides-tvr.5.2).
import * as THREE from 'three'

export interface ScreenPoint {
  /** CSS px from the view's centre, along the camera's right and up. */
  x: number
  y: number
  /** How far in front of the eye along its view axis (−view z); negative behind it. */
  depth: number
  /** Scene units per CSS px there, as worldUnitsPerPixel reads it. */
  upp: number
}

const view = new THREE.Vector3()
const stepped = new THREE.Vector3()
const from: ScreenPoint = { x: 0, y: 0, depth: 0, upp: 1 }
const to: ScreenPoint = { x: 0, y: 0, depth: 0, upp: 1 }

/**
 * Project `point` (world space) into a view `widthPx` × `heightPx` CSS px,
 * written into `out`. Reads the camera's matrices as they stand: update them
 * first if the camera has moved this frame. x and y mean nothing for a point
 * behind the eye (they are mirrored through the centre), and are 0 rather
 * than NaN at the eye's own depth.
 */
export function screenPointInto(
  camera: THREE.PerspectiveCamera,
  point: THREE.Vector3,
  widthPx: number,
  heightPx: number,
  out: ScreenPoint
): ScreenPoint {
  view.copy(point).applyMatrix4(camera.matrixWorldInverse)
  out.depth = -view.z
  view.applyMatrix4(camera.projectionMatrix)
  const finite = Number.isFinite(view.x) && Number.isFinite(view.y)
  out.x = finite ? (view.x * widthPx) / 2 : 0
  out.y = finite ? (view.y * heightPx) / 2 : 0
  // worldUnitsPerPixel's, from the depth in hand.
  const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2
  out.upp = (2 * Math.max(camera.near, out.depth) * Math.tan(halfFov)) / (camera.zoom * heightPx)
  return out
}

// A step this share of the point's depth: small enough to read as a
// derivative, large enough to stay clear of rounding.
const STEP_SHARE = 1e-3

/**
 * How fast `point` moves on screen as it moves along `along` (world space,
 * any length), px per scene unit, written into `out`. Taken in 3D so that it
 * holds for a point in view whatever `along` was measured from: two projected
 * points' difference flips when one of them is behind the eye.
 */
export function screenRateInto(
  camera: THREE.PerspectiveCamera,
  point: THREE.Vector3,
  along: THREE.Vector3,
  widthPx: number,
  heightPx: number,
  out: { x: number; y: number }
): { x: number; y: number } {
  screenPointInto(camera, point, widthPx, heightPx, from)
  const length = along.length()
  if (!(length > 0)) {
    out.x = 0
    out.y = 0
    return out
  }
  const step = STEP_SHARE * Math.max(camera.near, Math.abs(from.depth))
  stepped.copy(point).addScaledVector(along, step / length)
  screenPointInto(camera, stepped, widthPx, heightPx, to)
  out.x = (to.x - from.x) / step
  out.y = (to.y - from.y) / step
  return out
}
