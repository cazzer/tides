// The outer edges of Earth's drawn shells, as fractions of its radius: shared
// by their renderers and by ship mode, whose near plane keeps clear of them
// and whose low-tier stop stays outside them (tides-3bl.7). In ship mode both
// are drawn from inside too (pickShellFaces), and on the high tier the ship
// flies down through them to the terrain floor (tides-01v.8.7).
import * as THREE from 'three'
import { limbBody } from '../ship/limb-detail'
import { CLOUD_FLAT_ALTITUDE, CLOUD_LAYER_TOP } from '../cloud-layer'

/** The atmosphere's limb-glow shell (AtmosphereRenderer). */
export const ATMOSPHERE_OUTER = 1.06

/** The atmosphere's haze (shaders/atmosphere/haze.glsl): its base, at the
 * cloud deck, its (exaggerated, ~60 km) scale height, its gain, and its
 * colours (linear RGB), blue overhead, reddening toward the terminator. */
export const ATMOSPHERE_SURFACE = 1.012
export const ATMOSPHERE_SCALE_HEIGHT = 0.0095
export const ATMOSPHERE_GAIN = 1.2
export const ATMOSPHERE_SKY: readonly [number, number, number] = [0.3, 0.55, 1.0]
export const ATMOSPHERE_DUSK: readonly [number, number, number] = [1.0, 0.45, 0.2]

/** The aurora's shell (AuroraRenderer). */
export const AURORA_SHELL_INNER = 1.024
export const AURORA_SHELL_OUTER = 1.07

/** Draw order of the additive shells, after the clouds'. */
export const ATMOSPHERE_RENDER_ORDER = 1
export const AURORA_RENDER_ORDER = 2

/**
 * The cloud shell's draw order within the ship camera's reach
 * (tides-01v.8.6): after the haze, which it lays over itself where in front
 * (cloudShaders.ts), so that the fog inside a cloud covers the rest; and
 * from under the aurora's shell, where the aurora lies past nearly every
 * cloud (only tall cloud over high ground reaches above its base), after
 * the aurora too. Inside the cloud shell (groundHazeTop()) the haze no
 * longer lies under the clouds over the ground (tides-zmw.5): the
 * atmosphere stops at the ground, which draws its own share, and a cloud
 * adds the haze in front of it; at the shell's top both ease to all of the
 * haze, added, as outside.
 */
export const CLOUD_REACH_RENDER_ORDER = 1.5
export const CLOUD_UNDER_AURORA_RENDER_ORDER = 3

/**
 * The cloud shell's top above sea level (cloudShaders.ts shellAltitude; flat
 * on the low tier), where the atmosphere hands the haze over the ground to
 * the ground (tides-zmw.5). Below it the clouds draw after the atmosphere
 * and add the haze in front of them themselves (CLOUD_REACH_RENDER_ORDER),
 * so the atmosphere can stop at the depth buffer's ground; above it, where
 * the clouds draw first and write no depth, it must not, or it would skip
 * every cloud.
 */
export function groundHazeTop(flat: boolean): number {
  return flat ? CLOUD_FLAT_ALTITUDE : CLOUD_LAYER_TOP
}

const eye = new THREE.Vector3()

/**
 * True for the ship's camera while Earth is its nearest body: the only
 * camera that draws the shells from inside. limbBody() is null outside ship
 * mode, which keeps every other view's camera on today's front faces,
 * including the Moon Phase panel's, which sits inside the shells.
 */
function shipNearEarth(camera: THREE.Camera): boolean {
  return (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true && limbBody() === 'earth'
}

/**
 * True when the ship's camera (shipNearEarth) is inside the shell of radius
 * `outer` round `shell`'s origin, or near enough that its near plane may clip
 * the shell (at the frustum's corners, the near plane reaches out to its
 * depth over the corner ray's cosine): where the shell needs its back faces.
 */
export function withinShellReach(
  shell: THREE.Object3D,
  camera: THREE.Camera,
  outer: number
): boolean {
  if (!shipNearEarth(camera)) return false
  const { near, fov, aspect } = camera as THREE.PerspectiveCamera
  const tan = Math.tan(THREE.MathUtils.degToRad(fov / 2))
  const cornerReach = near * Math.sqrt(1 + tan * tan * (1 + aspect * aspect))
  return shell.worldToLocal(camera.getWorldPosition(eye)).length() <= outer + cornerReach
}

/**
 * True when the ship's camera (shipNearEarth) is inside the shell of radius
 * `outer` round `shell`'s origin: where the shell shows its back faces alone.
 */
export function insideShell(shell: THREE.Object3D, camera: THREE.Camera, outer: number): boolean {
  return shipNearEarth(camera) && shell.worldToLocal(camera.getWorldPosition(eye)).length() < outer
}

/**
 * A shell mesh's onBeforeRender (tides-01v.8.2): which faces to draw for
 * this camera. Out of the shell's reach (withinShellReach), the front faces
 * alone, as ever. Within it, both, and the shader (shaders/shell/face.glsl,
 * under three's DOUBLE_SIDED) keeps one per ray: the back face from inside
 * the shell or where the near plane clips the front. Those back faces lie
 * beyond the globe, so there the depth test is off and the shaders stop
 * each ray at the ground themselves. three keeps both programs, so crossing
 * the reach compiles only once. `stopAtGround` (the atmosphere's, tides-
 * zmw.5): a radius (groundHazeTop() over sea level) inside which the depth
 * test stays on, so the back faces stop at the ground, which draws its own
 * share of the haze (groundHaze.ts).
 */
export function pickShellFaces(
  mesh: THREE.Object3D,
  material: THREE.Material,
  camera: THREE.Camera,
  stopAtGround?: number
): void {
  const shader = material as THREE.ShaderMaterial
  const outer = shader.uniforms.uOuter.value
  const reach = withinShellReach(mesh, camera, outer)
  const side = reach ? THREE.DoubleSide : THREE.FrontSide
  if (shader.side !== side) {
    shader.side = side
    shader.needsUpdate = true
  }
  shader.depthTest =
    !reach || (stopAtGround !== undefined && insideShell(mesh, camera, stopAtGround))
}
