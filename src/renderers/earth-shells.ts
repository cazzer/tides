// The outer edges of Earth's drawn shells, as fractions of its radius: shared
// by their renderers and by ship mode, whose collision sphere must stay
// outside them (tides-3bl.7). In ship mode both are drawn from inside too
// (pickShellFaces).
import * as THREE from 'three'
import { limbBody } from '../ship/limb-detail'

/** The atmosphere's limb-glow shell (AtmosphereRenderer). */
export const ATMOSPHERE_OUTER = 1.06

/** The aurora's shell (AuroraRenderer). */
export const AURORA_SHELL_OUTER = 1.07

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
 * A shell mesh's onBeforeRender (tides-01v.8.2): which faces to draw for
 * this camera. Out of the shell's reach (withinShellReach), the front faces
 * alone, as ever. Within it, both, and the shader (shaders/shell/face.glsl,
 * under three's DOUBLE_SIDED) keeps one per ray: the back face from inside
 * the shell or where the near plane clips the front. Those back faces lie
 * beyond the globe, so there the depth test is off and the shaders stop
 * each ray at the ground themselves. three keeps both programs, so crossing
 * the reach compiles only once.
 */
export function pickShellFaces(
  mesh: THREE.Object3D,
  material: THREE.Material,
  camera: THREE.Camera
): void {
  const shader = material as THREE.ShaderMaterial
  const reach = withinShellReach(mesh, camera, shader.uniforms.uOuter.value)
  const side = reach ? THREE.DoubleSide : THREE.FrontSide
  if (shader.side !== side) {
    shader.side = side
    shader.needsUpdate = true
  }
  shader.depthTest = !reach
}
