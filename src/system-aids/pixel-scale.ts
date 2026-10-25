// How many scene units one CSS pixel spans at a point, for the aids that fade
// or size themselves by how large something reads on screen (tides-2hv.9).
import * as THREE from 'three'

const eye = new THREE.Vector3()
const toPoint = new THREE.Vector3()
const forward = new THREE.Vector3()

/**
 * Scene units per CSS pixel in an orthographic view `heightPx` CSS pixels
 * tall: (top − bottom) / (zoom · height), as camera.tsx measures it. The same
 * at every point in the view. drei's OrthographicCamera spans the canvas in
 * pixels (top − bottom = height), so the main view's is 1 / zoom.
 */
export function orthoUnitsPerPixel(
  top: number,
  bottom: number,
  zoom: number,
  heightPx: number
): number {
  return (top - bottom) / (zoom * heightPx)
}

/**
 * Scene units per CSS pixel at `point` (world space), for a view
 * `heightPx` CSS pixels tall. A perspective camera's (the main view's and
 * ship mode's) grows with depth in front of the eye, clamped to the near
 * plane so a point behind the eye never reads as huge; an ortho one's is
 * orthoUnitsPerPixel, the same everywhere.
 */
export function worldUnitsPerPixel(
  camera: THREE.Camera,
  point: THREE.Vector3,
  heightPx: number
): number {
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const { top, bottom, zoom } = camera as THREE.OrthographicCamera
    return orthoUnitsPerPixel(top, bottom, zoom, heightPx)
  }
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const perspective = camera as THREE.PerspectiveCamera
    camera.getWorldDirection(forward)
    const depth = Math.max(
      perspective.near,
      toPoint.subVectors(point, eye.setFromMatrixPosition(camera.matrixWorld)).dot(forward)
    )
    const halfFov = THREE.MathUtils.degToRad(perspective.fov) / 2
    return (2 * depth * Math.tan(halfFov)) / (perspective.zoom * heightPx)
  }
  return 1
}
