// Picking the Sun (tides-9us). Its halo sphere, SUN_CLICK_MARGIN wider than
// the disc and picked by its bounds, let a click just off the limb focus it;
// the corona billboard that replaced it (tides-hd9) takes no clicks, so the
// disc's own mesh picks that margin instead. One analytic sphere test, never
// the mesh's triangles (bcaf80e: those cost a click ~13 ms).
import * as THREE from 'three'

/** How far outside the Sun's disc a click still hits it, in its own units. */
export const SUN_CLICK_MARGIN = 4

const sphere = new THREE.Sphere()
const hit = new THREE.Vector3()

/** A raycast for the Sun's mesh, its geometry a sphere of the Sun's radius. */
export function sunRaycast(
  this: THREE.Mesh<THREE.SphereGeometry>,
  raycaster: THREE.Raycaster,
  intersects: THREE.Intersection[]
): void {
  this.getWorldPosition(sphere.center)
  sphere.radius = (this.geometry.parameters.radius + SUN_CLICK_MARGIN) * this.matrixWorld.getMaxScaleOnAxis()
  if (!raycaster.ray.intersectSphere(sphere, hit)) return
  const distance = raycaster.ray.origin.distanceTo(hit)
  if (distance < raycaster.near || distance > raycaster.far) return
  intersects.push({ distance, point: hit.clone(), object: this })
}
