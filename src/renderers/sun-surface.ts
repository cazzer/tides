import * as THREE from 'three'
import bakeVertex from '../shaders/sun-bake/vertex.glsl'
import bakeFragment from '../shaders/sun-bake/fragment.frag'
import coronaBakeFragment from '../shaders/sun-bake/corona.frag'
import plasmaBakeFragment from '../shaders/sun-bake/plasma.frag'
import { activeRegions, type ActiveRegion } from './sun-activity'

/*
 * The disc's EUV detail and churn and the corona's pattern, baked once
 * into three cube maps in the Sun's frame (sun-bake/fragment.frag,
 * plasma.frag and corona.frag say what each channel holds). Before
 * tides-d9x a CubeCamera re-rendered six 256 px faces of 4D noise every
 * frame; this bakes one face per frame for the first eighteen frames after
 * load, and then the disc costs three cube lookups per pixel and the
 * corona one. One bake per renderer, shared by every view that draws the
 * Sun, kept for the renderer's life (~13 MB on the low tier): views mount and unmount as panels change, and rebaking each
 * time would cost more than holding it.
 */

/** [TUNE] Cube face size per quality tier, texels. */
export const SUN_SURFACE_SIZE = { high: 1024, low: 512 } as const

/**
 * [TUNE] The corona pattern's face size. Its finest feature, the spicule
 * fringe, has ~600 cycles round the Sun; 256 texels a face give ~1000.
 */
export const SUN_CORONA_SIZE = 256

/**
 * [TUNE] The plasma's face size per tier: mid-scale churn, a few billows
 * per radius, which never needs the surface bake's resolution.
 */
export const SUN_PLASMA_SIZE = { high: 512, low: 256 } as const

interface CubeBake {
  target: THREE.WebGLCubeRenderTarget
  scene: THREE.Scene
  camera: THREE.CubeCamera
  /** Faces baked so far; 6 when done. */
  faces: number
}

const bakes = new WeakMap<THREE.WebGLRenderer, CubeBake[]>()

/**
 * The bake's uniforms: each region of activeRegions() as its centre and
 * reach, and its leading and following poles, which the loops join.
 */
export function surfaceBakeUniforms(regions: ActiveRegion[] = activeRegions()) {
  const uRegions = regions.map(
    (r) => new THREE.Vector4(...r.dir, r.span * 1.1 + (3 + 4 * r.strength) * (Math.PI / 180))
  )
  const uLead = regions.map((r) => new THREE.Vector4(...r.spots[0].dir, r.strength))
  const uFollow = regions.map((r) => new THREE.Vector4(...r.spots[1].dir, r.span))
  return {
    uRegions: { value: uRegions },
    uLead: { value: uLead },
    uFollow: { value: uFollow },
    regionCount: regions.length,
  }
}

// A cube target whose faces `material` (BackSide, on a unit sphere round
// the cube camera) fills, cleared to `blank` until each face is baked.
function createCubeBake(
  renderer: THREE.WebGLRenderer,
  size: number,
  material: THREE.ShaderMaterial,
  blank: THREE.Color
): CubeBake {
  const target = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
  })
  const scene = new THREE.Scene()
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), material))
  const camera = new THREE.CubeCamera(0.1, 10, target)
  camera.coordinateSystem = renderer.coordinateSystem
  camera.updateCoordinateSystem()
  camera.updateMatrixWorld(true)
  scene.add(camera)

  const previous = renderer.getRenderTarget()
  const clear = renderer.getClearColor(new THREE.Color())
  const alpha = renderer.getClearAlpha()
  renderer.setClearColor(blank, 0)
  for (let face = 0; face < 6; face++) {
    renderer.setRenderTarget(target, face)
    renderer.clear(true, false, false)
  }
  renderer.setClearColor(clear, alpha)
  renderer.setRenderTarget(previous)
  return { target, scene, camera, faces: 0 }
}

function bakeMaterial(fragmentShader: string, extra: Partial<THREE.ShaderMaterialParameters> = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: bakeVertex,
    fragmentShader,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    ...extra,
  })
}

function createBakes(renderer: THREE.WebGLRenderer, low: boolean): CubeBake[] {
  const { regionCount, ...uniforms } = surfaceBakeUniforms()
  const surface = bakeMaterial(bakeFragment, {
    defines: { SUN_REGIONS: regionCount },
    uniforms,
  })
  return [
    // Unbaked, the disc reads as plain quiet Sun...
    createCubeBake(renderer, SUN_SURFACE_SIZE[low ? 'low' : 'high'], surface, new THREE.Color(0, 0, 1)),
    // ...and the corona as even, middling streamers.
    createCubeBake(renderer, SUN_CORONA_SIZE, bakeMaterial(coronaBakeFragment), new THREE.Color(0.5, 0.5, 0.5)),
    // ...and the plasma as even, featureless.
    createCubeBake(renderer, SUN_PLASMA_SIZE[low ? 'low' : 'high'], bakeMaterial(plasmaBakeFragment), new THREE.Color(0.5, 0.5, 0.5)),
  ]
}

/**
 * The Sun's baked cubes for this renderer, set up on first use. Call `step`
 * once a frame: it bakes the next face until all eighteen are done.
 */
export function sunSurface(renderer: THREE.WebGLRenderer, low: boolean) {
  let own = bakes.get(renderer)
  if (!own) {
    own = createBakes(renderer, low)
    bakes.set(renderer, own)
  }
  const [surface, corona, plasma] = own
  return {
    surface: surface.target.texture,
    corona: corona.target.texture,
    plasma: plasma.target.texture,
    /** Bakes the next face, if any; true once all are. */
    step(): boolean {
      const bake = own.find((b) => b.faces < 6)
      if (!bake) return true
      const previous = renderer.getRenderTarget()
      const previousFace = renderer.getActiveCubeFace()
      const previousLevel = renderer.getActiveMipmapLevel()
      const xr = renderer.xr.enabled
      renderer.xr.enabled = false
      renderer.setRenderTarget(bake.target, bake.faces)
      renderer.render(bake.scene, bake.camera.children[bake.faces] as THREE.Camera)
      renderer.setRenderTarget(previous, previousFace, previousLevel)
      renderer.xr.enabled = xr
      bake.faces++
      return false
    },
  }
}
