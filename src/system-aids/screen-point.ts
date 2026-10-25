// Where a scene point lands in the view, in CSS px, for the aids laid out on
// screen (BodyLabels, tides-tvr.5.2).
import * as THREE from 'three'
import { worldUnitsPerPixel } from './pixel-scale'

export interface ScreenPoint {
  /** CSS px from the view's centre, along the camera's right and up. */
  x: number
  y: number
  /** How far in front of the eye along its view axis (−view z); negative behind it. */
  depth: number
  /** Scene units per CSS px there (worldUnitsPerPixel). */
  upp: number
}

const view = new THREE.Vector3()

/**
 * Project `point` (world space) into a view `widthPx` × `heightPx` CSS px,
 * written into `out`. Reads the camera's matrices as they stand: update them
 * first if the camera has moved this frame. x and y mean nothing for a point
 * behind the eye.
 */
export function screenPointInto(
  camera: THREE.Camera,
  point: THREE.Vector3,
  widthPx: number,
  heightPx: number,
  out: ScreenPoint
): ScreenPoint {
  view.copy(point).applyMatrix4(camera.matrixWorldInverse)
  out.depth = -view.z
  view.applyMatrix4(camera.projectionMatrix)
  out.x = (view.x * widthPx) / 2
  out.y = (view.y * heightPx) / 2
  out.upp = worldUnitsPerPixel(camera, point, heightPx)
  return out
}
