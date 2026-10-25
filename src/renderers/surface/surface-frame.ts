// Where the streamed surface tiles (tides-zmw.9.1) sit: inside Earth's
// OrbitingBody, so the body's tilt and spin carry them like the globe, with
// the tileset's own frame (ECEF in metres: Z through the north pole, X
// through lon 0, Y through lon 90E) turned into Earth's local one (Y north,
// lon 0 at +X, east towards -Z, as calculateLocationAndRotationForLatLng in
// ../../utils.ts places a lat/lon) and scaled from metres to scene units.
// The recipe is the tides-zmw.8 spike's, measured there to keep tile LOD and
// culling correct at this scale.
import * as THREE from 'three'
import { EARTH_RADIUS } from '../../ship/ship-bodies'

/** The tileset's ellipsoid: a sphere of Earth's mean radius, like the globe. */
export const SURFACE_ELLIPSOID_RADIUS = 6371000

/** Scene units per metre (~4.632e-7: one unit is ~2159 km). */
export const SURFACE_SCALE = EARTH_RADIUS / SURFACE_ELLIPSOID_RADIUS

/**
 * SurfaceTiles' useFrame priority: tiles.update() must see this frame's
 * camera and spin, so it runs after SimClock (-1), ShipController (0, the
 * camera) and OrbitingBody (0, the spin) and before drei's View renders (1).
 * At 0 it would share a slot with OrbitingBody, and R3F runs equal priorities
 * in subscription order, child effects first: the tiles would update against
 * last frame's spin. At 1 it would tie with the View's render. Any priority
 * above 0 hands rendering to whoever subscribed it, which drei's View already
 * has.
 */
export const SURFACE_FRAME_PRIORITY = 0.5

/** Turns the tiles' group from the tileset's ECEF metres into Earth's local frame. */
export function applySurfaceFrame(group: THREE.Object3D): void {
  group.rotation.set(-Math.PI / 2, 0, 0)
  group.scale.setScalar(SURFACE_SCALE)
  group.updateMatrix()
}

/**
 * The point at (lat, lon) degrees and `height` metres above the ellipsoid,
 * in the tileset's ECEF metres (the spherical form of its ellipsoid's
 * getCartographicToPosition).
 */
export function surfaceEcef(lat: number, lon: number, height: number, target = new THREE.Vector3()): THREE.Vector3 {
  const la = THREE.MathUtils.degToRad(lat)
  const lo = THREE.MathUtils.degToRad(lon)
  const r = SURFACE_ELLIPSOID_RADIUS + height
  return target.set(r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la))
}

/**
 * Rescales the bump shading of a loaded terrain tile's meshes to the group's
 * scale. The terrain material (the library's TerrainLambertMaterial) shades
 * with the elevation map's gradient in metres against the surface's screen
 * derivatives in view space, which the group's scale has shrunk to scene
 * units: left at the plugin's bumpScale (the height scale), every slope
 * shades ~2e6 times too steep, nearly black or white by its aspect. Scaling
 * bumpScale by SURFACE_SCALE puts both in scene units. displacementScale
 * stays in metres: it moves vertices in object space, before the scale.
 * The plugin resets bumpScale when its heightScale changes, so a live height
 * scale (tides-zmw.9.7) must reapply this.
 */
export function applySurfaceBumpScale(root: THREE.Object3D, heightScale: number): void {
  root.traverse((object) => {
    const material = (object as THREE.Mesh).material as THREE.MeshLambertMaterial | undefined
    if (material?.bumpMap) material.bumpScale = heightScale * SURFACE_SCALE
  })
}

const _frame = new THREE.Object3D()
applySurfaceFrame(_frame)

/** An ECEF point (metres) in Earth's local frame (scene units), as the tiles draw it. */
export function ecefToEarthLocal(ecef: THREE.Vector3, target = new THREE.Vector3()): THREE.Vector3 {
  return target.copy(ecef).applyMatrix4(_frame.matrix)
}
