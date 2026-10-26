// What the globe hands the streamed tiles (tides-zmw.9.7): its ground haze,
// whose uniforms EarthRenderer fills for each camera, so the tiles take the
// same aerial perspective. Keyed by the scene both are drawn in: every drei
// View portals its own scene with its own EarthRenderer, and the tiles must
// read the haze their own View's camera fills. Kept out of both components
// (and of the lazy surface chunk) so neither imports the other.
import type * as THREE from 'three'
import type { GroundHaze } from '../groundHaze'

type Listener = () => void

const hazes = new Map<THREE.Object3D, GroundHaze>()
const listeners = new Set<Listener>()

/** EarthRenderer: publishes `haze` for `scene` (null withdraws it). */
export function setSurfaceHaze(scene: THREE.Object3D, haze: GroundHaze | null): void {
  if (haze) hazes.set(scene, haze)
  else hazes.delete(scene)
  listeners.forEach((listener) => listener())
}

/** The haze published for `scene`, or null. */
export function surfaceHaze(scene: THREE.Object3D): GroundHaze | null {
  return hazes.get(scene) ?? null
}

/** Calls `listener` on every change; returns the unsubscribe. */
export function subscribeSurfaceHaze(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
