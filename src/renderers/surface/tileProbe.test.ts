// The tiles' warm-up probes (tides-tvr.7.7): each keys, in three's own
// program key, the program a real tile draws with flight detail, at its
// fade variant.
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { WebGLPrograms as WebGLProgramsUntyped } from 'three/src/renderers/webgl/WebGLPrograms.js'
import { SkirtedPlaneGeometry } from '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/SkirtedPlaneGeometry.js'
import { wrapFadeMaterial } from '3d-tiles-renderer/src/three/plugins/fade/wrapFadeMaterial.js'
import type { GlobeLink } from './surface-link'
import { TILE_FEATURES } from './tile-features'
import { createTileComposer, type TerrainPhongMaterial } from './tile-material'
import { createTileProbes } from './tileProbe'
import { compiled, flightLink, tileMesh } from './tile-test-fixtures'

// three's own program keys, as its renderer would key a draw (no GL), as
// in ../groundProbe.test.ts.
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

function keyOf(programs: ProgramKeys, object: THREE.Object3D, scene: THREE.Scene): string {
  return programs.getProgramCacheKey(
    programs.getParameters((object as THREE.Mesh).material as THREE.Material, lights, [], scene, object)
  )
}

// A tile as the tileset makes it: the plugin's mesh, the composer's
// material (processTileModel), the fade's wrapper (load-model) and its
// define as setFade leaves it.
function realTile(link: GlobeLink, fade: number) {
  const mesh = tileMesh(new SkirtedPlaneGeometry(1, 1, 4, 4))
  createTileComposer(link, TILE_FEATURES).prepare(mesh, {})
  const material = mesh.material as TerrainPhongMaterial
  wrapFadeMaterial(material, material.onBeforeCompile)
  material.defines!.FEATURE_FADE = fade
  return mesh
}

describe('the tiles\' warm-up probes (tides-tvr.7.7)', () => {
  it('key the program a tile in flight draws, at each fade', () => {
    const programs = programKeys()
    const scene = new THREE.Scene()
    const link = flightLink()
    const { probes, dispose } = createTileProbes(link)
    expect(probes).toHaveLength(2)
    // The program the cold descent linked (tides-tvr.7.4's audit).
    const tail = 'night-surface-flight-gibs8+colour-surface+shadow-surface+water-surface+ground-haze-surface'
    for (const { object } of probes) {
      expect(((object as THREE.Mesh).material as THREE.Material).customProgramCacheKey().endsWith(tail)).toBe(true)
    }
    for (const [i, fade] of [1, 0].entries()) {
      const tile = realTile(link, fade)
      const probe = probes[i].object as THREE.Mesh
      expect(probe.parent).toBe(null)
      expect(keyOf(programs, probe, scene)).toBe(keyOf(programs, tile, scene))
      const a = compiled(probe.material as THREE.Material)
      const b = compiled(tile.material as THREE.Material)
      expect(a.vertexShader).toBe(b.vertexShader)
      expect(a.fragmentShader).toBe(b.fragmentShader)
      expect(a.fragmentShader).toContain('if ( dither >= fadeIn )')
    }
    dispose()
  })

  it('tell the fades and the flight state apart', () => {
    const programs = programKeys()
    const scene = new THREE.Scene()
    const { probes, dispose } = createTileProbes(flightLink())
    const [fading, settled] = probes.map(({ object }) => keyOf(programs, object, scene))
    expect(fading).not.toBe(settled)
    // A tile out of flight (no night flight) keys another program.
    const day = flightLink()
    day.nightFlight = null
    expect(keyOf(programs, realTile(day, 0), scene)).not.toBe(settled)
    dispose()
  })

  it('free their materials, maps and geometry', () => {
    const { probes, dispose } = createTileProbes(flightLink())
    const meshes = probes.map(({ object }) => object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhongMaterial>)
    const freed = vi.fn()
    meshes[0].geometry.addEventListener('dispose', freed)
    for (const { material } of meshes) {
      material.addEventListener('dispose', freed)
      material.map!.addEventListener('dispose', freed)
      material.displacementMap!.addEventListener('dispose', freed)
    }
    expect(probes.map((probe) => probe.prepare?.())).toEqual([true, true])
    dispose()
    // The geometry, and each probe's material, map and grid.
    expect(freed).toHaveBeenCalledTimes(1 + 2 * 3)
    // A warm-up still holding them skips them.
    expect(probes.map((probe) => probe.prepare?.())).toEqual([false, false])
  })
})
