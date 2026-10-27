// Fixtures for the tile composer's tests (tile-material.test.ts and each
// tile-<feature>.test.ts, tides-zmw.9.16): a GlobeLink on the globe's real
// patches where a test needs them, a tile mesh as the terrain plugin makes
// it, and three's Phong shader as onBeforeCompile receives it. Test-only;
// nothing in the app imports it.
import * as THREE from 'three'
import { TerrainLambertMaterial } from '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/TerrainLambertMaterial.js'
import { RELIEF } from '../../relief'
import { createEclipseShadow } from '../eclipseShadow'
import { createGroundHaze } from '../groundHaze'
import { createWater } from '../water'
import type { GlobeLink } from './surface-link'

/** What three hands onBeforeCompile for a Phong material (chunks unresolved). */
export function phongShader(): THREE.WebGLProgramParametersWithUniforms {
  return {
    vertexShader: THREE.ShaderLib.phong.vertexShader,
    fragmentShader: THREE.ShaderLib.phong.fragmentShader,
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
  } as unknown as THREE.WebGLProgramParametersWithUniforms
}

/** `material`'s onBeforeCompile run on a fresh Phong shader. */
export function compiled(material: THREE.Material): THREE.WebGLProgramParametersWithUniforms {
  const shader = phongShader()
  material.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
  return shader
}

const noPatch = () => ({ patch: { onBeforeCompile() {}, customProgramCacheKey: () => '' }, uniforms: {}, side: 0 })

/** A link with the globe's real haze and eclipse; the rest placeholders
 * (a feature's test swaps in its own globe module's objects). */
export function fakeLink(): GlobeLink {
  const sunDir = { value: new THREE.Vector3(1, 0, 0) }
  const haze = createGroundHaze(sunDir, 2.95, false)
  return {
    haze,
    sunDir,
    clouds: { uniforms: {} as GlobeLink['clouds']['uniforms'], flat: false },
    eclipse: createEclipseShadow('earth').uniforms,
    nightFlight: null,
    gibs: noPatch(),
    gibsNight: noPatch(),
    maps: { day: { value: new THREE.Texture() }, specular: { value: new THREE.Texture() }, night: { value: new THREE.Texture() } },
    horizon: { map: { value: new THREE.DataArrayTexture() }, code: { value: new THREE.Vector2() } },
    seaLevel: 2.95,
    water: createWater(haze.frame),
  }
}

/** A tile mesh as the terrain plugin leaves it: its Lambert with the
 * imagery and the elevation grid (displacement and bump). */
export function tileMesh(geometry: THREE.BufferGeometry = new THREE.BufferGeometry()) {
  const lambert = new TerrainLambertMaterial()
  const grid = new THREE.DataTexture(new Float32Array(4), 2, 2, THREE.RedFormat, THREE.FloatType)
  lambert.map = new THREE.Texture()
  lambert.displacementMap = grid
  lambert.bumpMap = grid
  lambert.displacementScale = RELIEF
  lambert.bumpScale = RELIEF
  return new THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>(geometry, lambert)
}
