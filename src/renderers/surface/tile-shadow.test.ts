// Terrain cast shadows on the tiles (tides-zmw.9.15): the globe's horizon
// shadows by rename, and each grid's own horizon map bound per tile.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { TERRAIN_DISPLACEMENT } from '../../cloud-layer'
import { surfaceOpacityUniform } from '../../surface-handover'
import { surfaceEcef } from './surface-frame'
import { GROUND_SHADOW_GLSL } from '../groundShadow'
import { gridHorizon, horizonTexture, setGridHorizon } from './terrain-internals'
import { tileHorizonSize } from './terrarium'
import { createTileComposer, SURFACE_ANCHORS, SURFACE_GROUND_FROM_ECEF, type TerrainPhongMaterial } from './tile-material'
import { tileFrame, tileShadow, tileShadowGlsl, tileSun } from './tile-shadow'
import { compiled, fakeLink, tileMesh } from './tile-test-fixtures'

const slot = [{ name: 'shadow', adapter: tileShadow }]

describe('terrain shadows on the tiles (tides-zmw.9.15)', () => {
  it("takes the globe's GLSL at the vertex, renaming its ground, map coordinate, footprint, scale and the multiplies only", () => {
    const g = GROUND_SHADOW_GLSL.lightBody
    const footprint = g.slice(g.indexOf('float footprint ='), g.indexOf(';', g.indexOf('float footprint =')) + 1)
    const renamed = g
      .replace('#if defined(USE_MAP) && defined(USE_SPECULARMAP) && NUM_DIR_LIGHTS > 0', '#if NUM_DIR_LIGHTS > 0')
      .replace('#define GROUND_HORIZON\n', '')
      .replace(footprint, 'float footprint = 0.0;')
      .replace('vec3 eye = normalize(vViewPosition);', '')
      .split('vGroundDetailPos')
      .join('(surfaceUp * SURFACE_SHADOW_RADIUS)')
      .replace('texture(uGroundHorizon, vec3(vMapUv, 0.0))', 'textureLod(uGroundHorizon, vec3(surfaceShadowUv, 0.0), 0.0)')
      .replace('texture(uGroundHorizon, vec3(vMapUv, 1.0))', 'textureLod(uGroundHorizon, vec3(surfaceShadowUv, 1.0), 0.0)')
      .replace('vMapUv', 'surfaceShadowUv')
      .replace('uGroundShadowScale', `(${TERRAIN_DISPLACEMENT.toExponential(9)})`)
      .replace('reflectedLight.directDiffuse *= sunLit;', 'vSurfaceShadow.x = sunLit;')
      .replace('reflectedLight.directSpecular *= sunLit;', '')
      .replace('reflectedLight.indirectDiffuse *= groundHorizonSky;', 'vSurfaceShadow.y = groundHorizonSky;')
    const glsl = tileShadowGlsl(2.95)
    expect(glsl.vertexBody).toContain(renamed)
    expect(glsl.vertexHead.startsWith(GROUND_SHADOW_GLSL.fragmentHead.replace('uniform float uGroundShadowScale;', ''))).toBe(true)
    expect(glsl.vertexHead).toContain('const float SURFACE_SHADOW_RADIUS = 2.950000000;')
    // nothing of the globe's frame, map or screen left
    for (const name of ['vMapUv', 'vGroundDetailPos', 'uGroundShadowScale', 'uTerrainScale', 'dFdx', 'reflectedLight']) {
      expect(glsl.vertexBody).not.toContain(name)
    }
    expect(glsl.fragmentBody).not.toContain('uTerrainScale')
  })

  it('lays (a) at the vertex and (b) after the lights, on the globe\'s uniforms, one multiply of the deeper shadow', () => {
    const link = fakeLink()
    const mesh = tileMesh()
    const composer = createTileComposer(link, slot)
    expect(composer.key).toBe('surface-tile:surface-base+shadow-surface')
    composer.prepare(mesh, {})
    const shader = compiled(mesh.material as TerrainPhongMaterial)
    const v = shader.vertexShader
    const f = shader.fragmentShader
    expect(shader.uniforms.uGroundShadowSun).toBe(link.sunDir)
    expect(shader.uniforms.uGroundHorizon).toBe(link.horizon.map)
    expect(shader.uniforms.uGroundHorizonCode).toBe(link.horizon.code)
    // no grid horizon: the placeholder, off
    expect(shader.uniforms.uTileHorizonOn.value).toBe(0)
    expect((shader.uniforms.uTileHorizon.value as THREE.DataArrayTexture).isDataArrayTexture).toBe(true)
    // (a) after the base's vertex code (surfaceUp set), one varying
    expect(v.indexOf(SURFACE_ANCHORS.vertexBody)).toBeLessThan(v.indexOf('vSurfaceShadow.x = sunLit;'))
    expect(v.indexOf('surfaceUp = SURFACE_GROUND_FROM_ECEF * objectNormal;')).toBeLessThan(v.indexOf('vSurfaceShadow = vec2(1.0);'))
    expect(v.match(/varying vec2 vSurfaceShadow;/g)).toHaveLength(1)
    expect(f.match(/varying vec2 vSurfaceShadow;/g)).toHaveLength(1)
    expect(f.indexOf(SURFACE_ANCHORS.fragmentHead)).toBeLessThan(f.indexOf('uniform sampler2DArray uTileHorizon;'))
    const lights = f.indexOf('#include <lights_fragment_end>')
    const fine = f.indexOf('textureLod(uTileHorizon, vec3(vBumpMapUv, uTileSunLayers.x), 0.0)')
    const multiply = f.indexOf('reflectedLight.directDiffuse *= surfaceSunLit;')
    expect(lights).toBeGreaterThan(0)
    expect(lights).toBeLessThan(fine)
    expect(fine).toBeLessThan(multiply)
    expect(f).toContain('surfaceSunLit = min(surfaceSunLit, mix(1.0, fine, uSurfaceOpacity));')
    // the sky occlusion the colour slot reads is the globe's, declared for it
    expect(f).toContain('#define GROUND_HORIZON\nfloat groundHorizonSky = vSurfaceShadow.y;')
    expect(f).toContain('reflectedLight.indirectDiffuse *= groundHorizonSky;')
    expect(f.match(/reflectedLight\.directDiffuse \*=/g)).toHaveLength(1)
    // no trigonometry per pixel for (b)
    const body = f.slice(fine, multiply)
    for (const fn of ['tan(', 'atan(', 'asin(']) expect(body).not.toContain(fn)
  })

  it("weighs the Sun's two directions either side as the globe does, and is off where the Sun clears the grid's horizon", () => {
    // a tile at 36°N 112°W, in the ground's frame (lon 0 at +X, east towards -Z)
    const lat = 36 * (Math.PI / 180)
    const lon = -112 * (Math.PI / 180)
    const up = new THREE.Vector3(Math.cos(lat) * Math.cos(-lon), Math.sin(lat), Math.cos(lat) * Math.sin(-lon))
    const east = new THREE.Vector3(0, 1, 0).cross(up).normalize()
    const north = up.clone().cross(east)
    const target = () => ({ on: 0, a: new THREE.Vector4(), b: new THREE.Vector4(), layers: new THREE.Vector2() })
    const sunAt = (azimuthDeg: number, elevationDeg: number) => {
      const a = (azimuthDeg * Math.PI) / 180
      const e = (elevationDeg * Math.PI) / 180
      return north.clone().multiplyScalar(Math.cos(a) * Math.cos(e)).addScaledVector(east, Math.sin(a) * Math.cos(e)).addScaledVector(up, Math.sin(e))
    }
    const east5 = tileSun(tileFrame(up, 1e-4), 0.5, sunAt(90, 5).normalize(), 1, 1, target())
    expect(east5.on).toBe(1)
    expect(east5.a.toArray()).toEqual([0, 0, 1, 0].map((v) => expect.closeTo(v, 9)))
    expect(east5.layers.toArray()).toEqual([0, -1])
    // between SE (layer 0, 4th) and S (layer 1, 1st)
    const sse = tileSun(tileFrame(up, 1e-4), 0.5, sunAt(157.5, 5).normalize(), 1, 1, target())
    expect(sse.layers.toArray()).toEqual([0, 1])
    expect(sse.a.w).toBeCloseTo(0.5, 9)
    expect(sse.b.x).toBeCloseTo(0.5, 9)
    // between NW and N, wrapping
    const nnw = tileSun(tileFrame(up, 1e-4), 0.5, sunAt(-11.25, 5).normalize(), 1, 1, target())
    expect(nnw.layers.toArray()).toEqual([1, 0])
    expect(nnw.a.w).toBeCloseTo(0.25, 9)
    expect(nnw.b.x).toBeCloseTo(0.75, 9)
    // off: the Sun over the highest horizon (at the relief), at night, or no tiles drawn
    expect(tileSun(tileFrame(up, 1e-4), 0.5, sunAt(90, 40).normalize(), 1, 1, target()).on).toBe(0)
    expect(tileSun(tileFrame(up, 1e-4), 0.5, sunAt(90, 40).normalize(), 2, 1, target()).on).toBe(1) // atan(2 * 0.5) = 45°
    expect(tileSun(tileFrame(up, 1e-4), 0.5, sunAt(90, -10).normalize(), 1, 1, target()).on).toBe(0)
    expect(tileSun(tileFrame(up, 1e-4), 0.5, sunAt(90, 5).normalize(), 1, 0, target()).on).toBe(0)
    // a wide tile: somewhere on it the Sun is lower
    expect(tileSun(tileFrame(up, (20 * Math.PI) / 180), 0.5, sunAt(90, 40).normalize(), 1, 1, target()).on).toBe(1)
  })

  it("binds the grid's horizon map lazily as a clone (one that comes after the tile, or again), frees clones with the tile, the map with the grid", () => {
    const link = fakeLink()
    const composer = createTileComposer(link, slot)
    const mesh = tileMesh()
    const lambert = mesh.material as THREE.MeshLambertMaterial
    // the cache's grid; the tile's displacement map is a clone of it (the plugin's)
    const grid = lambert.displacementMap!
    const tileGrid = grid.clone()
    lambert.displacementMap = lambert.bumpMap = tileGrid
    // where the plugin puts a tile: its centre, ECEF metres (36°N 112°W)
    mesh.position.copy(surfaceEcef(36, -112, 0))
    composer.prepare(mesh, {})
    const material = mesh.material as TerrainPhongMaterial
    const shader = compiled(material)
    const up = surfaceEcef(36, -112, 0).applyMatrix3(SURFACE_GROUND_FROM_ECEF).normalize()
    const east = new THREE.Vector3(0, 1, 0).cross(up).normalize()
    link.sunDir.value.copy(east).addScaledVector(up, 0.1).normalize()
    surfaceOpacityUniform.value = 1
    try {
      // no map yet (the bake follows the grid): off, the placeholder
      expect(shader.uniforms.uTileHorizonOn.value).toBe(0)
      const placeholder = shader.uniforms.uTileHorizon.value as THREE.DataArrayTexture
      expect([placeholder.image.width, placeholder.image.depth]).toEqual([1, 2])
      // the map arrives: the next draw binds a clone of it
      const side = tileHorizonSize(512)
      const horizon = horizonTexture(new Uint8Array(side * side * 8), 512)
      horizon.userData.maxCode = 200 // a horizon of ~72° at true scale
      setGridHorizon(grid, horizon)
      expect(gridHorizon(tileGrid)).toBe(horizon)
      const bound = shader.uniforms.uTileHorizon.value as THREE.DataArrayTexture
      expect(bound).not.toBe(horizon)
      expect(bound.source).toBe(horizon.source)
      expect([bound.image.width, bound.image.depth]).toEqual([side, 2])
      // the Sun low in the east over it: on, east's weight
      expect(shader.uniforms.uTileHorizonOn.value).toBe(1)
      expect((shader.uniforms.uTileSunA.value as THREE.Vector4).z).toBeCloseTo(1, 6)
      expect(shader.uniforms.uTileHorizon.value).toBe(bound) // the same clone while the map stands
      // the Sun high: over the grid's highest horizon, off
      link.sunDir.value.copy(up)
      expect(shader.uniforms.uTileHorizonOn.value).toBe(0)
      // not a slot TilesRenderer would free with the tile
      for (const key of ['map', 'specularMap', 'emissiveMap', 'alphaMap', 'aoMap', 'lightMap', 'normalMap'] as const) {
        expect((material as unknown as Record<string, unknown>)[key]).not.toBe(bound)
      }
      // baked again: the old map and the tile's clone of it go, a clone of the new one comes
      const freed: string[] = []
      bound.addEventListener('dispose', () => freed.push('clone'))
      horizon.addEventListener('dispose', () => freed.push('map'))
      const again = horizonTexture(new Uint8Array(side * side * 8), 512)
      setGridHorizon(grid, again)
      expect(freed).toEqual(['map'])
      const rebound = shader.uniforms.uTileHorizon.value as THREE.DataArrayTexture
      expect(rebound.source).toBe(again.source)
      expect(freed).toEqual(['map', 'clone'])
      rebound.addEventListener('dispose', () => freed.push('clone 2'))
      again.addEventListener('dispose', () => freed.push('map 2'))
      material.dispose()
      expect(freed).toEqual(['map', 'clone', 'clone 2'])
      grid.dispose()
      expect(freed).toEqual(['map', 'clone', 'clone 2', 'map 2'])
      expect(gridHorizon(grid)).toBeNull()
    } finally {
      surfaceOpacityUniform.value = 0
    }
  })
})
