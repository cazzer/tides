// Picking a moon in the main view (tides-2hv.8). Mimas or Phobos is a pixel
// or two across at the system view's zooms, too small to tap, so a moon
// answers taps within MOON_TAP_RADIUS_PX of its centre. The parent planet
// keeps taps on its own disc, unless the moon's real sphere is hit there.
import * as THREE from 'three'

/**
 * On-screen radius, CSS px, within which a tap picks a moon. [TUNE] ~22 px
 * is about a fingertip; much more and neighbouring moons start to overlap.
 */
export const MOON_TAP_RADIUS_PX = 22

/** What a moon mesh's userData carries for moonRaycast. */
export interface MoonPickData {
  /** The moon's sphere radius, scene units. */
  radius: number
  /** Its parent's centre, world space, kept current with the moon's. */
  parentPosition: THREE.Vector3
  /** Its parent's sphere radius, scene units. */
  parentRadius: number
}

const sphere = new THREE.Sphere()
const parent = new THREE.Sphere()
const hit = new THREE.Vector3()

/**
 * A mesh raycast (assign to Mesh.raycast) that hits the moon's sphere, grown
 * to MOON_TAP_RADIUS_PX on screen under an orthographic camera (drei sizes
 * its frustum in CSS pixels, so a pixel is 1 / zoom units). Inside the
 * parent's disc only the real sphere counts.
 */
export function moonRaycast(
  this: THREE.Mesh,
  raycaster: THREE.Raycaster,
  intersects: THREE.Intersection[]
): void {
  const data = this.userData as MoonPickData
  const camera = raycaster.camera as THREE.OrthographicCamera | undefined
  const pixel = camera?.isOrthographicCamera ? 1 / camera.zoom : 0
  this.getWorldPosition(sphere.center)
  sphere.radius = Math.max(data.radius, MOON_TAP_RADIUS_PX * pixel)
  if (!raycaster.ray.intersectSphere(sphere, hit)) return
  parent.set(data.parentPosition, data.parentRadius)
  if (sphere.radius > data.radius && raycaster.ray.intersectsSphere(parent)) {
    sphere.radius = data.radius
    if (!raycaster.ray.intersectSphere(sphere, hit)) return
  }
  const distance = raycaster.ray.origin.distanceTo(hit)
  if (distance < raycaster.near || distance > raycaster.far) return
  intersects.push({ distance, point: hit.clone(), object: this })
}
