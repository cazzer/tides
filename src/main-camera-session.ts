import type { OrthographicCamera } from 'three'
import type { OrbitControls } from 'three-stdlib'

type Vec3 = [number, number, number]
type Quat = [number, number, number, number]

export interface MainCameraPose {
  position: Vec3
  quaternion: Quat
  up: Vec3
  zoom: number
  target: Vec3
}

// MainCamera and MainControls unmount in ship mode. Their last pose stays here
// until the next entry overwrites it, including when the main panel remounts.
let saved: MainCameraPose | null = null

export function mainCameraPose(): MainCameraPose | null {
  return saved
}

export function rememberMainCameraPose(camera: OrthographicCamera, controls: OrbitControls): void {
  saved = {
    position: camera.position.toArray() as Vec3,
    quaternion: camera.quaternion.toArray() as Quat,
    up: camera.up.toArray() as Vec3,
    zoom: camera.zoom,
    target: controls.target.toArray() as Vec3,
  }
}
