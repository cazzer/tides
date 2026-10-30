// The streamed tiles' material composer (tides-zmw.9.16), checked on the
// library's own tile material and geometry. Structural only: each feature
// pins its own GLSL in tile-<feature>.test.ts, so the beads that fill the
// stubs don't meet here.
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { wrapFadeMaterial } from '3d-tiles-renderer/src/three/plugins/fade/wrapFadeMaterial.js'
import { RELIEF } from '../../relief'
import { applySurfaceFrame, SURFACE_ELLIPSOID_RADIUS, SURFACE_SCALE } from './surface-frame'
import type { GlobeLink } from './surface-link'
import { SURFACE_STENCIL_REF } from './surface-scale'
import { TILE_FEATURES } from './tile-features'
import {
  createTileComposer,
  createTileMaterialPlugin,
  renameInSnippet,
  SURFACE_ANCHORS,
  SURFACE_GROUND_FROM_ECEF,
  surfaceGlobeUv,
  surfaceGlobeUvDelta,
  surfaceInject,
  TerrainPhongMaterial,
  type TileAdapter,
} from './tile-material'
import { compiled, fakeLink, flightLink, phongShader, tileMesh } from './tile-test-fixtures'

describe('the tiles\' frame (tides-zmw.9.16)', () => {
  it('turns ECEF into the ground mesh\'s frame as the tiles\' group does', () => {
    const group = new THREE.Object3D()
    applySurfaceFrame(group)
    const rotation = new THREE.Matrix3().setFromMatrix4(group.matrix).multiplyScalar(1 / SURFACE_SCALE)
    for (let i = 0; i < 9; i++) expect(rotation.elements[i]).toBeCloseTo(SURFACE_GROUND_FROM_ECEF.elements[i], 12)
    // North up, lon 0 at +X, east towards -Z.
    expect(new THREE.Vector3(0, 0, 1).applyMatrix3(SURFACE_GROUND_FROM_ECEF).distanceTo(new THREE.Vector3(0, 1, 0))).toBe(0)
    expect(new THREE.Vector3(0, 1, 0).applyMatrix3(SURFACE_GROUND_FROM_ECEF).distanceTo(new THREE.Vector3(0, 0, -1))).toBe(0)
  })

  it('reads the globe map per fragment at SphereGeometry\'s uvs', () => {
    const sphere = new THREE.SphereGeometry(1, 72, 36)
    const position = sphere.getAttribute('position')
    const uv = sphere.getAttribute('uv')
    const p = new THREE.Vector3()
    const at = new THREE.Vector2()
    let checked = 0
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i)
      if (Math.abs(p.y) > 1 - 1e-9) continue // the poles: any u
      surfaceGlobeUv(p, at)
      // The seam's u = 0 column is u = 1 per fragment.
      const du = at.x - uv.getX(i)
      expect(du - Math.round(du)).toBeCloseTo(0, 6)
      expect(at.y).toBeCloseTo(uv.getY(i), 6)
      checked++
    }
    expect(checked).toBeGreaterThan(2000)
    // The GLSL is the same formula.
    const shader = compiled(composerMaterial())
    expect(shader.fragmentShader).toContain(
      'return vec2(0.5 + atan(-up.z, up.x) * RECIPROCAL_PI2, 0.5 + asin(clamp(up.y, -1.0, 1.0)) * RECIPROCAL_PI);'
    )
  })

  it('takes the map\'s derivatives from a change of direction, smooth across the antimeridian', () => {
    const d = new THREE.Vector2()
    for (const [lat, lon] of [[36.1, -112.1], [-60, 179.9999], [10, -179.9999], [0, 0], [85, 40]]) {
      const la = THREE.MathUtils.degToRad(lat)
      const lo = THREE.MathUtils.degToRad(lon)
      // Lon 0 at +X, east towards -Z (SphereGeometry's frame).
      const up = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo))
      const step = new THREE.Vector3(3e-7, -2e-7, 5e-7)
      step.addScaledVector(up, -step.dot(up)) // along the sphere
      const a = surfaceGlobeUv(up)
      const b = surfaceGlobeUv(up.clone().add(step))
      const du = b.x - a.x
      surfaceGlobeUvDelta(up, step, d)
      expect(d.x).toBeCloseTo(du - Math.round(du), 9) // no jump at the seam
      expect(d.y).toBeCloseTo(b.y - a.y, 9)
    }
  })

  it('warns that surfaceGround is quantised: float32 steps ~0.5 m at Earth\'s radius', () => {
    const radius = SURFACE_ELLIPSOID_RADIUS * SURFACE_SCALE // scene units
    const f32 = new Float32Array([radius])
    const bits = new Uint32Array(f32.buffer)
    bits[0] += 1
    const step = (f32[0] - Math.fround(radius)) / SURFACE_SCALE // metres
    expect(step).toBeGreaterThan(0.4)
    expect(step).toBeLessThan(0.6)
    // So the base takes the map's derivatives from the ray's, never the ground's.
    const f = compiled(composerMaterial(fakeLink(), [])).fragmentShader
    expect(f).toContain('vec3 surfaceRayDx = dFdx(surfaceRay);')
    expect(f).not.toContain('dFdx(surfaceGround)')
    expect(f).not.toContain('dFdx(surfaceGlobeUv)')
  })
})

function composerMaterial(link: GlobeLink | null = fakeLink(), slots = TILE_FEATURES) {
  const mesh = tileMesh()
  createTileComposer(link, slots).prepare(mesh, {})
  return mesh.material as TerrainPhongMaterial
}

describe('the Phong swap (tides-zmw.9.16)', () => {
  it('carries the library material\'s maps and bump chunk, with no specular', () => {
    const mesh = tileMesh()
    const lambert = mesh.material as THREE.MeshLambertMaterial
    const disposed = vi.fn()
    lambert.addEventListener('dispose', disposed)
    createTileComposer(null).prepare(mesh, {})
    const phong = mesh.material as TerrainPhongMaterial
    expect(phong).toBeInstanceOf(TerrainPhongMaterial)
    expect(phong.isMeshPhongMaterial).toBe(true)
    expect(phong.type).toBe('MeshPhongMaterial')
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(phong.map).toBe(lambert.map)
    expect(phong.displacementMap).toBe(lambert.displacementMap)
    expect(phong.bumpMap).toBe(lambert.bumpMap)
    // prepareSurfaceMaterial: metres and scene units at the relief, the stencil mark.
    expect(phong.displacementScale).toBe(RELIEF)
    expect(phong.bumpScale).toBe(SURFACE_SCALE * RELIEF)
    expect(phong.stencilRef).toBe(SURFACE_STENCIL_REF)
    expect(phong.emissive.getHex()).toBe(0)
    const shader = compiled(phong)
    // The library's bump chunk, as it comes.
    expect(shader.fragmentShader).toContain('DEGENERATE_DET_EPSILON')
    expect(shader.fragmentShader).toContain('float dBx = bumpScale * ( gradU * dSTdx.x + gradV * dSTdx.y );')
    expect(shader.fragmentShader).not.toContain('#include <bumpmap_pars_fragment>')
    // No specular after three's chunk sets its strength.
    expect(shader.fragmentShader).toContain('#include <specularmap_fragment>\n\nspecularStrength = 0.0;\n' + SURFACE_ANCHORS.specular)
    expect(shader.uniforms.uTerrainScale).toBeUndefined()
  })
})

describe('the Phong swap\'s edges (tides-zmw.9.16)', () => {
  it('clones (three makes the copy with no constructor argument)', () => {
    const phong = composerMaterial(null, [])
    const copy = phong.clone()
    expect(copy).toBeInstanceOf(TerrainPhongMaterial)
    expect(copy.map).toBe(phong.map)
    expect(copy.bumpMap).toBe(phong.bumpMap)
  })

  it('leaves a tile material that isn\'t the plugin\'s Lambert as it came', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const basic = new THREE.MeshBasicMaterial()
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), basic)
    createTileComposer(fakeLink(), TILE_FEATURES).prepare(mesh, {})
    expect(mesh.material).toBe(basic)
    expect(basic.stencilWrite).toBe(false)
    warn.mockRestore()
  })
})

describe('renameInSnippet (tides-zmw.9.16)', () => {
  const snippet = 'vec2 a = vMapUv; vec2 b = vMapUv * 2.0; float c = vMapUvX; d = fract(vMapUv.x);'
  it('renames every whole-word match, literally', () => {
    expect(renameInSnippet(snippet, 'vMapUv', 'surfaceGlobeUv')).toBe(
      'vec2 a = surfaceGlobeUv; vec2 b = surfaceGlobeUv * 2.0; float c = vMapUvX; d = fract(surfaceGlobeUv.x);'
    )
    expect(renameInSnippet('x = vMapUv;', 'vMapUv', '$&$1')).toBe('x = $&$1;')
    expect(renameInSnippet('m(a) * (b) + m(a)', 'm(a)', 'n')).toBe('n * (b) + n')
  })
  it('throws on none, or on a count other than expected', () => {
    expect(() => renameInSnippet(snippet, 'vNope', 'x')).toThrow(/no vNope/)
    expect(() => renameInSnippet(snippet, 'vMapUv', 'x', 'test', 2)).toThrow(/3 of vMapUv, expected 2/)
    expect(renameInSnippet(snippet, 'vMapUv', 'x', 'test', 3)).toContain('vMapUvX')
  })
})

describe('the composer (tides-zmw.9.16)', () => {
  it('lists the features in the globe\'s composePatches order', () => {
    expect(TILE_FEATURES.map((s) => s.name)).toEqual(['eclipse', 'clouds', 'night', 'colour', 'shadow', 'glint', 'haze'])
  })

  it('applies the base, then the features in order, skipping nulls, under one key', () => {
    const order: string[] = []
    const feature = (name: string): TileAdapter => () => ({
      patch: {
        onBeforeCompile(shader) {
          order.push(name)
          // Every anchor is there, after the base's code.
          shader.fragmentShader = surfaceInject(shader.fragmentShader, 'fragmentBody', `// feature ${name}`)
        },
        customProgramCacheKey: () => name,
      },
    })
    const composer = createTileComposer(fakeLink(), [
      { name: 'a', adapter: feature('a') },
      { name: 'b', adapter: () => null },
      { name: 'c', adapter: feature('c') },
    ])
    expect(composer.features).toEqual(['a', 'c'])
    expect(composer.key).toBe('surface-tile:surface-base+a+c')
    const mesh = tileMesh()
    composer.prepare(mesh, {})
    const material = mesh.material as THREE.Material
    const shader = compiled(material)
    expect(order).toEqual(['a', 'c'])
    expect(material.customProgramCacheKey()).toBe(composer.key)
    // As three's includes on the globe: the later injection first.
    const f = shader.fragmentShader
    expect(f.indexOf('surfaceGlobeUv = surfaceGlobeUvAt(surfaceUp);')).toBeLessThan(f.indexOf(SURFACE_ANCHORS.fragmentBody))
    expect(f.indexOf(SURFACE_ANCHORS.fragmentBody)).toBeLessThan(f.indexOf('// feature c'))
    expect(f.indexOf('// feature c')).toBeLessThan(f.indexOf('// feature a'))
  })

  it('lays each slot that returns a patch, in order, under the composed key', () => {
    const link = fakeLink()
    const composer = createTileComposer(link, TILE_FEATURES)
    const laid = TILE_FEATURES.flatMap(({ name, adapter }) => {
      const feature = adapter(link)
      return feature ? [{ name, key: feature.patch.customProgramCacheKey() }] : []
    })
    expect(composer.features).toEqual(laid.map(({ name }) => name))
    expect(composer.key).toBe(['surface-tile:surface-base', ...laid.map(({ key }) => key)].join('+'))
    for (const { key } of laid) expect(key, 'a feature needs a cache key of its own').not.toBe('')
    expect(createTileComposer(null, TILE_FEATURES).key).toBe('surface-tile:surface-base')
    // Every slot's patch compiles together on a tile.
    expect(() => compiled(composerMaterial(link))).not.toThrow()
  })

  it('keeps the globe\'s textures out of the tiles\' material slots (TilesRenderer disposes those with the tile)', () => {
    const mesh = tileMesh()
    const lambert = mesh.material as THREE.MeshLambertMaterial
    const own = new Set([lambert.map, lambert.displacementMap, lambert.bumpMap])
    createTileComposer(fakeLink(), TILE_FEATURES).prepare(mesh, {})
    const material = mesh.material as unknown as Record<string, unknown>
    compiled(mesh.material as THREE.Material)
    for (const key in material) {
      const value = material[key] as { isTexture?: boolean } | null
      if (value?.isTexture) expect(own.has(value as THREE.Texture), key).toBe(true)
    }
  })

  it('declares each base anchor once and every name before its first use', () => {
    const shader = compiled(composerMaterial(fakeLink(), []))
    for (const [stage, anchors] of [
      [shader.vertexShader, ['vertexHead', 'vertexBody']],
      [shader.fragmentShader, ['fragmentHead', 'fragmentBody', 'specular']],
    ] as const) {
      for (const a of anchors) expect(stage.split(SURFACE_ANCHORS[a]), a).toHaveLength(2)
    }
    const v = shader.vertexShader
    expect(v.indexOf('#include <project_vertex>')).toBeLessThan(v.indexOf('surfaceUp = SURFACE_GROUND_FROM_ECEF * objectNormal;'))
    expect(v.indexOf('surfaceUp = SURFACE_GROUND_FROM_ECEF * objectNormal;')).toBeLessThan(v.indexOf(SURFACE_ANCHORS.vertexBody))
    // The base adds no varyings (each costs a write per vertex).
    expect(v.split('varying ').length).toBe(THREE.ShaderLib.phong.vertexShader.split('varying ').length)
    const f = shader.fragmentShader
    expect(f.indexOf('surfaceRay = uSurfaceViewToGround * -vViewPosition;')).toBeLessThan(f.indexOf('surfaceUp = normalize(surfaceGround);'))
    expect(f.indexOf('surfaceGlobeDy = surfaceGlobeUvDelta(')).toBeLessThan(f.indexOf(SURFACE_ANCHORS.fragmentBody))
    expect(f.indexOf('mat3 surfaceWorldFromGround()')).toBeLessThan(f.indexOf(SURFACE_ANCHORS.fragmentHead))
    expect(f.indexOf(SURFACE_ANCHORS.fragmentHead)).toBeLessThan(f.indexOf('void main'))
    expect(f.indexOf('#include <normal_fragment_begin>\n\nsurfaceGeomNormal = normal;')).toBeGreaterThan(0)
    expect(shader.uniforms.uSurfaceViewToGround).toBeDefined()
    expect(shader.uniforms.uSurfaceEyeGround).toBeDefined()
  })

  it('reads its frame from the haze\'s uniform objects', () => {
    const link = fakeLink()
    const shader = compiled(composerMaterial(link, []))
    expect(shader.uniforms.uSurfaceViewToGround).toBe(link.haze.frame.uGroundHazeViewToLocal)
    expect(shader.uniforms.uSurfaceEyeGround).toBe(link.haze.frame.uGroundHazeEyeLocal)
  })

  it('binds per-tile uniforms through onTile, the shared ones for every tile', () => {
    const shared = { value: 1 }
    const composer = createTileComposer(fakeLink(), [
      {
        name: 'grid',
        adapter: () => ({
          patch: {
            onBeforeCompile(shader) {
              shader.uniforms.uShared = shared
            },
            customProgramCacheKey: () => 'grid',
          },
          onTile: (material, mesh, tile) => ({ uGrid: { value: (tile as { id: number }).id }, uSame: { value: mesh.material === material } }),
        }),
      },
    ])
    const [a, b] = [tileMesh(), tileMesh()]
    composer.prepare(a, { id: 1 })
    composer.prepare(b, { id: 2 })
    const [sa, sb] = [compiled(a.material as THREE.Material), compiled(b.material as THREE.Material)]
    expect(sa.uniforms.uGrid.value).toBe(1)
    expect(sb.uniforms.uGrid.value).toBe(2)
    expect(sa.uniforms.uSame.value).toBe(true)
    expect(sa.uniforms.uShared).toBe(shared)
    expect(sb.uniforms.uShared).toBe(shared)
  })

  it('frees what onTile made once, when the tile unloads or its parse aborts', () => {
    const made: THREE.Texture[] = []
    const freed: string[] = []
    const composer = createTileComposer(fakeLink(), [
      {
        name: 'grid',
        adapter: () => ({
          patch: { onBeforeCompile() {}, customProgramCacheKey: () => 'grid' },
          onTile: () => {
            const texture = new THREE.Texture()
            made.push(texture)
            return { uGridMap: { value: texture } }
          },
          onDispose: (material, uniforms) => {
            freed.push(material.uuid)
            ;(uniforms.uGridMap.value as THREE.Texture).dispose()
          },
        }),
      },
    ])
    const [unloaded, aborted] = [tileMesh(), tileMesh()]
    composer.prepare(unloaded, {})
    composer.prepare(aborted, {})
    const [a, b] = [unloaded.material as TerrainPhongMaterial, aborted.material as TerrainPhongMaterial]
    const disposedA = vi.fn()
    made[0].addEventListener('dispose', disposedA)
    // Unload: TilesRenderer disposes the material and its slots' textures.
    a.dispose()
    a.displacementMap!.dispose()
    expect(freed).toEqual([a.uuid])
    expect(disposedA).toHaveBeenCalledTimes(1)
    // A parse aborted after processTileModel: the slots' textures alone.
    b.displacementMap!.dispose()
    expect(freed).toEqual([a.uuid, b.uuid])
    b.dispose()
    expect(freed).toHaveLength(2)
  })

  it('survives the fade wrapper (unbound, no renderer), keeping its key', () => {
    const material = composerMaterial()
    const params = wrapFadeMaterial(material, material.onBeforeCompile)
    const shader = phongShader()
    const run = material.onBeforeCompile
    expect(() => run(shader, undefined as unknown as THREE.WebGLRenderer)).not.toThrow()
    expect(shader.uniforms.fadeIn).toBe(params.fadeIn)
    expect(shader.fragmentShader).toContain('if ( dither >= fadeIn )')
    expect(shader.fragmentShader).toContain('surfaceUp = normalize(surfaceGround);')
    expect(material.customProgramCacheKey()).toMatch(/^surface-tile:/)
  })
})

describe('the tile material plugin (tides-zmw.9.16)', () => {
  it('builds every mesh of a parsed tile in processTileModel', () => {
    const plugin = createTileMaterialPlugin(createTileComposer(null))
    const [a, b] = [tileMesh(), tileMesh()]
    plugin.processTileModel(new THREE.Group().add(a, new THREE.Group().add(b)), {})
    for (const m of [a, b]) {
      expect(m.material).toBeInstanceOf(TerrainPhongMaterial)
      expect((m.material as THREE.MeshPhongMaterial).displacementScale).toBe(RELIEF)
      expect((m.material as THREE.MeshPhongMaterial).stencilRef).toBe(SURFACE_STENCIL_REF)
    }
  })
})


describe('the composer\'s material for the warm-ups (tides-tvr.7.7)', () => {
  it('is the material prepare builds: the same key and shader text', () => {
    const composer = createTileComposer(flightLink(), TILE_FEATURES)
    const tile = tileMesh()
    composer.prepare(tile, {})
    const drawn = tile.material as TerrainPhongMaterial
    const terrain = tileMesh().material as THREE.MeshLambertMaterial
    const probe = composer.material(terrain)

    expect(probe).toBeInstanceOf(TerrainPhongMaterial)
    expect(probe.customProgramCacheKey()).toBe(drawn.customProgramCacheKey())
    expect(probe.customProgramCacheKey()).toContain('night-surface-flight-gibs8')
    const a = compiled(probe)
    const b = compiled(drawn)
    expect(a.vertexShader).toBe(b.vertexShader)
    expect(a.fragmentShader).toBe(b.fragmentShader)
    expect(probe.stencilRef).toBe(drawn.stencilRef)
    expect(probe.bumpScale).toBe(drawn.bumpScale)
    // The library's material is the caller's to free.
    const disposed = vi.fn()
    terrain.addEventListener('dispose', disposed)
    composer.material(terrain)
    expect(disposed).not.toHaveBeenCalled()
  })
})
