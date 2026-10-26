// The tiles on the live terrain scale and the stencil handover
// (tides-zmw.9.7), checked on the library's own tile material and geometry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { TerrariumMeshPlugin } from '3d-tiles-renderer/three/plugins'
import { TerrainLambertMaterial } from '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/TerrainLambertMaterial.js'
import { SkirtedPlaneGeometry } from '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/SkirtedPlaneGeometry.js'
import { wrapFadeMaterial } from '3d-tiles-renderer/src/three/plugins/fade/wrapFadeMaterial.js'
import { RELIEF } from '../../relief'
import { surfaceOpacityUniform, terrainScaleUniform } from '../../terrain-scale'
import type { MaterialPatch } from '../eclipseShadow'
import { createSurfaceTiles, SURFACE_RENDER_ORDER } from './createSurfaceTiles'
import { SURFACE_SCALE } from './surface-frame'
import {
  createSurfaceScalePlugin,
  DISPLACEMENT_VERTEX,
  globeStencil,
  patchSurfaceShader,
  prepareSurfaceMaterial,
  fitSurfaceBounds,
  SURFACE_FIT_STEP,
  SURFACE_STENCIL_REF,
  SURFACE_VERTEX_COUNT,
  surfaceElevationMetres,
  surfaceFitScale,
  surfaceSkirtRange,
} from './surface-scale'

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
  it("stands in for three's displacement chunk, times the live scale", () => {
    const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
    expect(squash(DISPLACEMENT_VERTEX.replace(' * uTerrainScale', ''))).toBe(squash(THREE.ShaderChunk.displacementmap_vertex))
  })

  it('puts the height and the bump on the live scale, after the terrain material its own bump chunk', () => {
    const material = new TerrainLambertMaterial()
    prepareSurfaceMaterial(material)
    const shader = compiled(material)
    expect(shader.vertexShader).toContain('uniform float uTerrainScale;')
    expect(shader.vertexShader).toContain(
      'texture2D( displacementMap, vDisplacementMapUv ).x * displacementScale * uTerrainScale + displacementBias'
    )
    expect(shader.vertexShader).not.toContain('#include <displacementmap_vertex>')
    // The library's bump chunk, not three's (which normalises the slope away).
    expect(shader.fragmentShader).toContain('float dBx = bumpScale * uTerrainScale * ( gradU * dSTdx.x + gradV * dSTdx.y );')
    expect(shader.fragmentShader).toContain('float dBy = bumpScale * uTerrainScale * ( gradU * dSTdy.x + gradV * dSTdy.y );')
    expect(shader.uniforms.uTerrainScale).toBe(terrainScaleUniform)
    expect(shader.uniforms.uSurfaceOpacity).toBe(surfaceOpacityUniform)
    // Each declared once, before its first use (GLSL needs it).
    for (const [stage, uniform] of [
      [shader.vertexShader, 'uTerrainScale'],
      [shader.fragmentShader, 'uTerrainScale'],
      [shader.fragmentShader, 'uSurfaceOpacity'],
    ]) {
      const declared = stage.indexOf(`uniform float ${uniform};`)
      expect(stage.split(`uniform float ${uniform};`), uniform).toHaveLength(2)
      expect(declared, uniform).toBeGreaterThanOrEqual(0)
      expect(stage.indexOf(uniform), uniform).toBe(declared + 'uniform float '.length)
    }
  })

  it('dissolves on an 8x8 Bayer pattern nested in the fade plugin\'s 4x4, first thing in main', () => {
    const material = new TerrainLambertMaterial()
    prepareSurfaceMaterial(material)
    const { fragmentShader } = compiled(material)
    const main = fragmentShader.indexOf('void main() {')
    const discard = fragmentShader.indexOf('/ 64.0 >= uSurfaceOpacity) discard;')
    expect(main).toBeGreaterThan(0)
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

  it('throws when an anchor is missing', () => {
    const shader = lambertShader()
    expect(() => patchSurfaceShader({ ...shader, vertexShader: 'void main() {}' })).toThrow(/displacementmap_vertex/)
    // three's own bump chunk has dBx too, but the terrain material's replacement is what runs;
    // without either it must throw.
    expect(() => patchSurfaceShader({ ...shader, fragmentShader: 'void main() {}' })).toThrow(/dBx/)
  })

  it('sets metres for the displacement, scene units for the bump, and the stencil mark', () => {
    const material = new TerrainLambertMaterial()
    material.displacementScale = 7
    material.bumpScale = 7
    prepareSurfaceMaterial(material)
    expect(material.displacementScale).toBe(1)
    expect(material.bumpScale).toBe(SURFACE_SCALE)
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
        order.push(shader.fragmentShader.includes('uTerrainScale') ? 'haze after scale' : 'haze before scale')
        shader.uniforms.uHaze = { value: 1 }
      },
      customProgramCacheKey: () => 'haze',
    }
    prepareSurfaceMaterial(material, [haze])
    const params = wrapFadeMaterial(material, material.onBeforeCompile)
    const shader = compiled(material)
    expect(order).toEqual(['haze after scale'])
    expect(shader.uniforms.uTerrainScale).toBe(terrainScaleUniform)
    expect(shader.uniforms.uHaze).toBeDefined()
    expect(shader.uniforms.fadeIn).toBe(params.fadeIn)
    expect(shader.fragmentShader).toContain('if ( dither >= fadeIn )')
    // three's default key, the wrapper's source: the same for every tile.
    expect(material.customProgramCacheKey()).toBe(material.onBeforeCompile.toString())
  })

  it("prepares every mesh of a parsed tile in processTileModel, reading the extras per tile", () => {
    let calls = 0
    const plugin = createSurfaceScalePlugin(() => {
      calls++
      return []
    })
    const a = new TerrainLambertMaterial()
    const b = new TerrainLambertMaterial()
    const scene = new THREE.Group().add(new THREE.Mesh(new THREE.BufferGeometry(), a), new THREE.Group().add(new THREE.Mesh(new THREE.BufferGeometry(), b)))
    plugin.processTileModel(scene, {})
    expect(calls).toBe(1)
    for (const m of [a, b]) {
      expect(m.displacementScale).toBe(1)
      expect(m.stencilRef).toBe(SURFACE_STENCIL_REF)
    }
  })

  it('lifts the skirts from the full relief\'s depth to the live scale\'s, each tile by its own range', () => {
    // A tile's geometry as the plugin leaves it: surface on the sphere, skirt
    // vertices dropped geometricError + range x RELIEF along the normal.
    const geometry = new SkirtedPlaneGeometry(1, 1, 32, 32)
    const position = geometry.getAttribute('position')
    const geometricError = 150
    const range = 1800
    for (let k = 0; k < geometry.skirtSourceIndices.length; k++) {
      const src = geometry.skirtSourceIndices[k]
      position.setXYZ(geometry.surfaceVertexCount + k, position.getX(src), position.getY(src), position.getZ(src) - (geometricError + range * RELIEF))
    }
    expect(surfaceSkirtRange(geometry, geometricError)).toBeCloseTo(range, 2)
    expect(surfaceSkirtRange(new THREE.PlaneGeometry(), geometricError)).toBe(0)

    const a = new TerrainLambertMaterial()
    const b = new TerrainLambertMaterial()
    createSurfaceScalePlugin().processTileModel(new THREE.Group().add(new THREE.Mesh(geometry, a)), { geometricError })
    prepareSurfaceMaterial(b)
    const sa = compiled(a)
    const sb = compiled(b)
    expect(sa.uniforms.uSkirtRange.value).toBeCloseTo(range, 2)
    expect(sb.uniforms.uSkirtRange.value).toBe(0)
    expect(sa.uniforms.uSkirtRange).not.toBe(sb.uniforms.uSkirtRange)
    expect(sa.vertexShader).toContain(
      `if ( gl_VertexID >= ${SURFACE_VERTEX_COUNT} ) transformed += normalize( objectNormal ) * uSkirtRange * ( ${RELIEF.toFixed(6)} - uTerrainScale );`
    )
    // After the displacement it corrects.
    expect(sa.vertexShader.indexOf('gl_VertexID >=')).toBeGreaterThan(sa.vertexShader.indexOf('displacementScale * uTerrainScale'))
  })

  it('counts the surface vertices before the skirts as the library builds them', () => {
    expect(new SkirtedPlaneGeometry(1, 1, 32, 32).surfaceVertexCount).toBe(SURFACE_VERTEX_COUNT)
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

describe('createSurfaceTiles on the live scale (tides-zmw.9.7)', () => {
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
      const material = new TerrainLambertMaterial()
      const scene = new THREE.Group().add(new THREE.Mesh(new THREE.BufferGeometry(), material))
      const plugins = (surface.tiles as unknown as { plugins: { name: string; processTileModel?: (s: THREE.Object3D, t: unknown) => unknown }[] }).plugins
      for (const p of plugins) p.processTileModel?.(scene, {})
      expect(setter).toHaveBeenCalledTimes(1)
      expect(material.displacementScale).toBe(1)
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

describe('the bounding regions on the live scale (tides-zmw.9.7)', () => {
  it('fits to the next step up, never under the drawn scale, between 1 and the relief', () => {
    expect(surfaceFitScale(1)).toBe(1)
    expect(surfaceFitScale(0.5)).toBe(1)
    expect(surfaceFitScale(RELIEF)).toBe(RELIEF)
    expect(surfaceFitScale(RELIEF * 2)).toBe(RELIEF)
    const fits = new Set<number>()
    for (let k = 0; k <= 2000; k++) {
      const s = 1 + ((RELIEF - 1) * k) / 2000
      const fit = surfaceFitScale(s)
      expect(fit).toBeGreaterThanOrEqual(s)
      expect(fit).toBeLessThanOrEqual(Math.min(RELIEF, s * SURFACE_FIT_STEP) + 1e-9)
      fits.add(fit)
    }
    // A descent from the relief to 1x refits a dozen times or so, not per frame.
    expect(fits.size).toBeLessThanOrEqual(Math.ceil(Math.log(RELIEF) / Math.log(SURFACE_FIT_STEP)) + 1)
  })

  it('writes every region at the fit, keeps the plugin at its own scale, and refits a tile once per step it is traversed at', () => {
    const written: number[] = []
    const terrain = {
      _heightScale: RELIEF,
      _updateBoundingVolume(this: { _heightScale: number }, tile: object) {
        written.push(this._heightScale)
        void tile
      },
    }
    const viewed: object[] = []
    const tiles = {
      calculateTileViewError(tile: object) {
        viewed.push(tile)
      },
    }
    let scale = 1.1
    const bounds = fitSurfaceBounds(tiles, terrain, () => scale)
    expect(bounds.fit).toBe(1.25)
    const tile = {}
    // The plugin writing a region (a parse) writes it at the fit.
    terrain._updateBoundingVolume(tile)
    expect(written).toEqual([1.25])
    expect(terrain._heightScale).toBe(RELIEF)
    // Traversed at the same fit: no refit.
    tiles.calculateTileViewError(tile)
    tiles.calculateTileViewError(tile)
    expect(written).toEqual([1.25])
    expect(viewed).toHaveLength(2)
    // Within the step: none either.
    scale = 1.2
    bounds.update()
    tiles.calculateTileViewError(tile)
    expect(written).toEqual([1.25])
    // A new step: refitted once, before its view error.
    scale = 3
    bounds.update()
    tiles.calculateTileViewError(tile)
    tiles.calculateTileViewError(tile)
    expect(written).toEqual([1.25, surfaceFitScale(3)])
    expect(bounds.refits).toBe(2)
    // A tile never written is fitted on its first visit.
    tiles.calculateTileViewError({})
    expect(written).toHaveLength(3)
    expect(terrain._heightScale).toBe(RELIEF)
  })

  it('refuses objects that are not the 0.5.3 plugin and renderer', () => {
    expect(() => fitSurfaceBounds({}, {}, () => 1)).toThrow(/0\.5\.3/)
  })
})
