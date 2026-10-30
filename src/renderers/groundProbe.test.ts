import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { WebGLPrograms as WebGLProgramsUntyped } from 'three/src/renderers/webgl/WebGLPrograms.js'
import { createGroundProbe, syncGroundProbe } from './groundProbe'
import { composePatches, type MaterialPatch } from './eclipseShadow'
import { globeStencil } from './surface/surface-scale'

// three's own program keys, as its renderer would key a draw (no GL: the
// key is built from the material, the object and the renderer's state).
interface ProgramKeys {
  getParameters(material: THREE.Material, lights: unknown, shadows: unknown[], scene: THREE.Scene, object: THREE.Object3D): unknown
  getProgramCacheKey(parameters: unknown): string
}
const WebGLPrograms = WebGLProgramsUntyped as unknown as new (...args: unknown[]) => ProgramKeys

function programKeys(): ProgramKeys {
  const renderer = {
    getRenderTarget: () => null,
    toneMapping: THREE.ACESFilmicToneMapping,
    outputColorSpace: THREE.SRGBColorSpace,
    shadowMap: { enabled: true, type: THREE.PCFSoftShadowMap },
    state: { buffers: { depth: { getReversed: () => false } } },
  }
  const maps = { get: (texture: unknown) => texture ?? null }
  const capabilities = {
    precision: 'highp',
    logarithmicDepthBuffer: false,
    vertexTextures: true,
    getMaxPrecision: () => 'highp',
  }
  const extensions = { has: () => true }
  const clipping = { numPlanes: 0, numIntersection: 0 }
  return new WebGLPrograms(renderer, maps, maps, extensions, capabilities, {}, clipping)
}

const lights = {
  directional: [{}],
  point: [],
  spot: [],
  spotLightMap: [],
  rectArea: [],
  hemi: [],
  directionalShadowMap: [],
  pointShadowMap: [],
  spotShadowMap: [],
  numSpotLightShadowsWithMaps: 0,
  numLightProbes: 0,
}

function keyOf(programs: ProgramKeys, object: THREE.Mesh, scene: THREE.Scene): string {
  return programs.getProgramCacheKey(programs.getParameters(object.material as THREE.Material, lights, [], scene, object))
}

const patch = (key: string): MaterialPatch => ({ onBeforeCompile() {}, customProgramCacheKey: () => key })

// The ground as EarthRenderer builds it: its maps, the relief, the tiles'
// stencil, and its patch spread onto the material.
function ground(drawn: MaterialPatch): THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhongMaterial> {
  const material = new THREE.MeshPhongMaterial({
    ...drawn,
    map: new THREE.Texture(),
    specularMap: new THREE.Texture(),
    emissiveMap: new THREE.Texture(),
    emissive: new THREE.Color(1, 0.8, 0.5),
    emissiveIntensity: 2,
    displacementMap: new THREE.DataTexture(),
    displacementScale: 0.01,
  })
  globeStencil(material, true)
  return new THREE.Mesh(new THREE.SphereGeometry(1, 128, 128), material)
}

describe('syncGroundProbe (tides-tvr.7.4)', () => {
  test("keys the program the ground draws with the probe's patch", () => {
    const programs = programKeys()
    const scene = new THREE.Scene()
    const flight = composePatches(patch('night-lights-flight'), patch('gibs-patch-8'), patch('ground-displacement-128x128'))
    const day = composePatches(patch('night-lights'), patch(''), patch('ground-displacement-128x128'))
    // Out of flight now, the ground's own key the day's.
    const earth = ground(day)
    scene.add(earth)
    const probe = createGroundProbe()

    syncGroundProbe(probe, earth, earth.material, flight)
    const probeKey = keyOf(programs, probe, scene)
    expect(probeKey).not.toBe(keyOf(programs, earth, scene))
    // The ground in flight: the probe's program, to the character.
    earth.material.onBeforeCompile = flight.onBeforeCompile
    earth.material.customProgramCacheKey = flight.customProgramCacheKey
    expect(probeKey).toBe(keyOf(programs, earth, scene))
    expect(probeKey.endsWith('night-lights-flight+gibs-patch-8+ground-displacement-128x128')).toBe(true)
    expect(probe.geometry).toBe(earth.geometry)
    expect(probe.parent).toBe(null)
  })

  test('follows the ground as it is when synced again', () => {
    const programs = programKeys()
    const scene = new THREE.Scene()
    const flight = patch('flight')
    const earth = ground(flight)
    const probe = createGroundProbe()
    syncGroundProbe(probe, earth, earth.material, flight)
    const version = probe.material.version

    earth.material.normalMap = new THREE.Texture()
    earth.material.side = THREE.DoubleSide
    syncGroundProbe(probe, earth, earth.material, flight)

    expect(keyOf(programs, probe, scene)).toBe(keyOf(programs, earth, scene))
    expect(probe.material.version).toBeGreaterThan(version)
  })

  test('a copy alone keys another program: copy() leaves the patch', () => {
    const programs = programKeys()
    const scene = new THREE.Scene()
    const earth = ground(patch('flight'))
    const copy = new THREE.Mesh(earth.geometry, new THREE.MeshPhongMaterial().copy(earth.material))

    expect(keyOf(programs, copy, scene)).not.toBe(keyOf(programs, earth, scene))
  })
})
