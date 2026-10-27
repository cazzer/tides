// The tiles at the page's relief and the stencil handover (tides-zmw.9.7,
// tides-zmw.21), checked on the library's own tile material and geometry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { TerrariumMeshPlugin } from '3d-tiles-renderer/three/plugins'
import { TerrainLambertMaterial } from '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/TerrainLambertMaterial.js'
import { wrapFadeMaterial } from '3d-tiles-renderer/src/three/plugins/fade/wrapFadeMaterial.js'
import { RELIEF } from '../../relief'
import { surfaceOpacityUniform } from '../../surface-handover'
import type { MaterialPatch } from '../eclipseShadow'
import { createSurfaceTiles, SURFACE_RENDER_ORDER } from './createSurfaceTiles'
import { SURFACE_SCALE } from './surface-frame'
import { TerrainPhongMaterial } from './tile-material'
import { globeStencil, patchSurfaceShader, prepareSurfaceMaterial, SURFACE_STENCIL_REF, surfaceElevationMetres } from './surface-scale'

/** What three hands onBeforeCompile for a Lambert material (chunks unresolved). */
function lambertShader(): THREE.WebGLProgramParametersWithUniforms {
  return {
    vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.lambert.uniforms),
  } as unknown as THREE.WebGLProgramParametersWithUniforms
}

const renderer = {} as THREE.WebGLRenderer

function compiled(material: THREE.Material) {
  const shader = lambertShader()
  material.onBeforeCompile(shader, renderer)
  return shader
}

describe('the tile patch (tides-zmw.9.7)', () => {
  it("leaves three's displacement chunk and the terrain material's bump chunk as they are, and declares the dissolve once", () => {
    const material = new TerrainLambertMaterial()
    prepareSurfaceMaterial(material)
    const shader = compiled(material)
    expect(shader.vertexShader).toBe(THREE.ShaderLib.lambert.vertexShader)
    expect(shader.vertexShader).toContain('#include <displacementmap_vertex>')
    // The library's bump chunk, not three's (which normalises the slope away).
    expect(shader.fragmentShader).toContain('float dBx = bumpScale * ( gradU * dSTdx.x + gradV * dSTdx.y );')
    expect(shader.fragmentShader).toContain('float dBy = bumpScale * ( gradU * dSTdy.x + gradV * dSTdy.y );')
    expect(shader.vertexShader + shader.fragmentShader).not.toContain('uTerrainScale')
    expect(shader.uniforms.uSurfaceOpacity).toBe(surfaceOpacityUniform)
    // Declared once, before its first use (GLSL needs it).
    const f = shader.fragmentShader
    const declared = f.indexOf('uniform float uSurfaceOpacity;')
    expect(f.split('uniform float uSurfaceOpacity;')).toHaveLength(2)
    expect(declared).toBeGreaterThanOrEqual(0)
    expect(f.indexOf('uSurfaceOpacity')).toBe(declared + 'uniform float '.length)
  })

  it('dissolves on an 8x8 Bayer pattern nested in the fade plugin\'s 4x4, first thing in main', () => {
    const material = new TerrainLambertMaterial()
    prepareSurfaceMaterial(material)
    const { fragmentShader } = compiled(material)
    const main = fragmentShader.indexOf('void main() {')
    const discard = fragmentShader.indexOf('/ 64.0 >= uSurfaceOpacity) discard;')
    expect(fragmentShader.split('>= uSurfaceOpacity) discard;')).toHaveLength(2)
    expect(discard).toBeGreaterThan(main)
    expect(fragmentShader.slice(main, discard)).not.toContain(';')
    // The GLSL's patterns: the 64 thresholds each once over an 8x8 block,
    // each 4x4 level split into four consecutive 8x8 ones.
    const mod = (a: number, n: number) => ((a % n) + n) % n
    const b2 = (x: number, y: number) => mod(3 * y + 2 * x, 4)
    const b4 = (x: number, y: number) => 4 * b2(mod(x, 2), mod(y, 2)) + b2(Math.floor(mod(x, 4) / 2), Math.floor(mod(y, 4) / 2))
    const b8 = (x: number, y: number) => 4 * b4(mod(x, 4), mod(y, 4)) + b2(Math.floor(mod(x, 8) / 4), Math.floor(mod(y, 8) / 4))
    const seen = new Set<number>()
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        seen.add(b8(x, y))
        expect(Math.floor(b8(x, y) / 4)).toBe(b4(x, y))
      }
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([...Array(64).keys()])
    const four = new Set<number>()
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) four.add(b4(x, y))
    expect(four.size).toBe(16)
  })

  it('throws when its anchor is missing', () => {
    const shader = lambertShader()
    expect(() => patchSurfaceShader({ ...shader, fragmentShader: 'void mainly() {}' })).toThrow(/void main/)
  })

  it('sets metres times the relief for the displacement, scene units times it for the bump, and the stencil mark', () => {
    const material = new TerrainLambertMaterial()
    material.displacementScale = 7
    material.bumpScale = 7
    prepareSurfaceMaterial(material)
    expect(material.displacementScale).toBe(RELIEF)
    expect(material.bumpScale).toBe(SURFACE_SCALE * RELIEF)
    const twelve = new TerrainLambertMaterial()
    prepareSurfaceMaterial(twelve, [], 12)
    expect(twelve.displacementScale).toBe(12)
    expect(twelve.bumpScale).toBe(SURFACE_SCALE * 12)
    expect(material.stencilWrite).toBe(true)
    expect(material.stencilFunc).toBe(THREE.AlwaysStencilFunc)
    expect(material.stencilRef).toBe(SURFACE_STENCIL_REF)
    expect(material.stencilZPass).toBe(THREE.ReplaceStencilOp)
    expect(material.stencilWriteMask).toBe(0xff)
  })

  it('runs extra patches (the haze) after its own, and survives the fade wrapper', () => {
    const material = new TerrainLambertMaterial()
    const order: string[] = []
    const haze: MaterialPatch = {
      onBeforeCompile(shader) {
        order.push(shader.fragmentShader.includes('uSurfaceOpacity') ? 'haze after dissolve' : 'haze before dissolve')
        shader.uniforms.uHaze = { value: 1 }
      },
      customProgramCacheKey: () => 'haze',
    }
    prepareSurfaceMaterial(material, [haze])
    const params = wrapFadeMaterial(material, material.onBeforeCompile)
    const shader = compiled(material)
    expect(order).toEqual(['haze after dissolve'])
    // The wrapper calls what it wraps unbound and without the renderer.
    const unbound = lambertShader()
    const run = material.onBeforeCompile
    expect(() => run(unbound, undefined as unknown as THREE.WebGLRenderer)).not.toThrow()
    expect(unbound.uniforms.uSurfaceOpacity).toBe(surfaceOpacityUniform)
    expect(shader.uniforms.uSurfaceOpacity).toBe(surfaceOpacityUniform)
    expect(shader.uniforms.uHaze).toBeDefined()
    expect(shader.uniforms.fadeIn).toBe(params.fadeIn)
    expect(shader.fragmentShader).toContain('if ( dither >= fadeIn )')
    // three's default key, the wrapper's source: the same for every tile.
    expect(material.customProgramCacheKey()).toBe(material.onBeforeCompile.toString())
  })
})

describe('globeStencil (tides-zmw.9.7)', () => {
  it('draws the globe only where no tile marked the stencil, writing nothing, with the tiles on', () => {
    const material = new THREE.MeshPhongMaterial()
    globeStencil(material, true)
    expect(material.stencilWrite).toBe(true)
    expect(material.stencilFunc).toBe(THREE.NotEqualStencilFunc)
    expect(material.stencilRef).toBe(SURFACE_STENCIL_REF)
    expect(material.stencilWriteMask).toBe(0)
    expect(material.stencilFail).toBe(THREE.KeepStencilOp)
    expect(material.stencilZFail).toBe(THREE.KeepStencilOp)
    expect(material.stencilZPass).toBe(THREE.KeepStencilOp)
  })

  it('leaves the material as three made it with the tiles off (production)', () => {
    const material = new THREE.MeshPhongMaterial()
    const before = JSON.stringify(material.toJSON())
    globeStencil(material, false)
    expect(JSON.stringify(material.toJSON())).toBe(before)
    expect(material.stencilWrite).toBe(false)
  })
})

// The library's GridCache constructor makes an OffscreenCanvas (node has none).
class FakeOffscreenCanvas {
  constructor(
    public width: number,
    public height: number
  ) {}
  getContext() {
    return null
  }
}

describe('createSurfaceTiles at the relief (tides-zmw.9.7, tides-zmw.21)', () => {
  beforeEach(() => vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas))
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('builds the plugin at RELIEF and never calls the heightScale setter again', () => {
    const setter = vi.spyOn(TerrariumMeshPlugin.prototype, 'heightScale', 'set')
    const surface = createSurfaceTiles({ floatLinear: true })
    try {
      expect(surface.terrain.heightScale).toBe(RELIEF)
      // the constructor's own assignment
      expect(setter).toHaveBeenCalledTimes(1)
      const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(new THREE.BufferGeometry(), new TerrainLambertMaterial())
      const scene = new THREE.Group().add(mesh)
      const plugins = (surface.tiles as unknown as { plugins: { name: string; processTileModel?: (s: THREE.Object3D, t: unknown) => unknown }[] }).plugins
      for (const p of plugins) p.processTileModel?.(scene, {})
      expect(setter).toHaveBeenCalledTimes(1)
      // The composer's Phong (tile-material.ts) in the Lambert's place,
      // drawn at the plugin's heightScale: its skirts and bounding regions
      // are the ground as drawn, so neither is refitted (tides-zmw.21).
      expect(mesh.material).toBeInstanceOf(TerrainPhongMaterial)
      expect((mesh.material as THREE.MeshPhongMaterial).displacementScale).toBe(surface.terrain.heightScale)
      expect(Object.prototype.hasOwnProperty.call(surface.terrain, '_updateBoundingVolume')).toBe(false)
    } finally {
      surface.dispose()
    }
  })

  it('registers the scale plugin and the fade, and draws the group first', () => {
    const surface = createSurfaceTiles({ floatLinear: true })
    try {
      const names = (surface.tiles as unknown as { plugins: { name: string }[] }).plugins.map((p) => p.name)
      expect(names).toContain('SURFACE_SCALE')
      expect(names).toContain('FADE_TILES_PLUGIN')
      expect(surface.tiles.group.renderOrder).toBe(SURFACE_RENDER_ORDER)
      expect(SURFACE_RENDER_ORDER).toBeLessThan(0)
      const fade = (surface.tiles as unknown as { plugins: { name: string; fadeRootTiles?: boolean }[] }).plugins.find(
        (p) => p.name === 'FADE_TILES_PLUGIN'
      )
      expect(fade?.fadeRootTiles).toBe(true)
    } finally {
      surface.dispose()
    }
  })

  it('reads true metres back from the plugin, whose samples are times its heightScale', () => {
    const terrain = { heightScale: RELIEF, sampleCartographicElevation: () => 2400 * RELIEF } as unknown as TerrariumMeshPlugin
    expect(surfaceElevationMetres(terrain, 0, 0)).toBeCloseTo(2400, 9)
    const none = { heightScale: RELIEF, sampleCartographicElevation: () => null } as unknown as TerrariumMeshPlugin
    expect(surfaceElevationMetres(none, 0, 0)).toBeNull()
  })
})
