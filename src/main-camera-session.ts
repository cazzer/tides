import { OrthographicCamera, type PerspectiveCamera } from 'three'
import type { OrbitControls } from 'three-stdlib'

type Vec3 = [number, number, number]
type Quat = [number, number, number, number]

interface CameraPoseBase {
  position: Vec3
  quaternion: Quat
  up: Vec3
  target: Vec3
}

export type MainCameraPose = CameraPoseBase & (
  | { projection: 'orthographic'; zoom: number; visibleHeight: number }
  | { projection: 'perspective'; zoom: number; fov: number }
)

// MainCamera and MainControls unmount in ship mode. Their last pose stays here
// until the next entry overwrites it, including when the main panel remounts.
let saved: MainCameraPose | null = null

export function mainCameraPose(): MainCameraPose | null {
  return saved
}

export function rememberMainCameraPose(camera: OrthographicCamera | PerspectiveCamera, controls: OrbitControls): void {
  const base = {
    position: camera.position.toArray() as Vec3,
    quaternion: camera.quaternion.toArray() as Quat,
    up: camera.up.toArray() as Vec3,
    target: controls.target.toArray() as Vec3,
  }
  saved = camera instanceof OrthographicCamera
    ? { ...base, projection: 'orthographic', zoom: camera.zoom, visibleHeight: camera.top - camera.bottom }
    : { ...base, projection: 'perspective', zoom: camera.zoom, fov: camera.fov }
}
