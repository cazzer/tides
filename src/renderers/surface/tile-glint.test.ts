// The water on the streamed tiles (tides-zmw.9.14, tides-07z): the globe's
// water (../water.ts), its strength from the globe's water mask sharpened at
// the coast by the tile's own elevation.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { WATER_GLSL, WATER_PRELUDE, WATER_WAVE_TABLE } from '../water'
import { GLINT_INLAND, GLINT_SEA, GLINT_SEA_LEVEL, glintStrength, regionHasWater, tileGlint, TILE_GLINT_GLSL, WATER_GRID } from './tile-glint'
import { createTileComposer, SURFACE_ANCHORS, type TerrainPhongMaterial } from './tile-material'
import { compiled, fakeLink, tileMesh } from './tile-test-fixtures'
import { TILE_FEATURES } from './tile-features'

function glintTile() {
  const link = fakeLink()
  const mesh = tileMesh()
  const composer = createTileComposer(link, [{ name: 'glint', adapter: tileGlint }])
  composer.prepare(mesh, {})
  const material = mesh.material as TerrainPhongMaterial
  return { link, composer, material, shader: compiled(material) }
}

describe('the glint on the tiles (tides-zmw.9.14)', () => {
  it('lays the globe\'s water on, with all its waves and its body', () => {
    const water = WATER_GLSL(WATER_WAVE_TABLE)
    expect(TILE_GLINT_GLSL.head).toContain(water.head)
    expect(TILE_GLINT_GLSL.normal).toBe(WATER_PRELUDE.tiles.body + water.normal)
    expect(TILE_GLINT_GLSL.direct).toBe(water.direct)
    expect(TILE_GLINT_GLSL.sky).toBe(water.sky)
    // The body comes with the waves (after the strength's anchor, by day).
    expect(TILE_GLINT_GLSL.specular).not.toContain('waterBody')
    expect(water.normal).toContain('waterBody(diffuseColor.rgb)')
    // The prelude takes the base's ray, up and frame.
    for (const name of ['surfaceRay', 'surfaceUp', 'uSurfaceViewToGround']) expect(WATER_PRELUDE.tiles.body).toContain(name)
  })

  it('sets the strength after the base zeroes it, from the globe\'s mask through a uniform and the tile\'s grid', () => {
    const { link, composer, material, shader } = glintTile()
    expect(composer.key).toBe('surface-tile:surface-base+water-surface')
    const f = shader.fragmentShader
    expect(f.indexOf('specularStrength = 0.0;')).toBeLessThan(f.indexOf(TILE_GLINT_GLSL.specular))
    expect(f.indexOf(SURFACE_ANCHORS.specular)).toBeLessThan(f.indexOf(TILE_GLINT_GLSL.specular))
    expect(f.indexOf('#include <specularmap_fragment>')).toBeLessThan(f.indexOf(TILE_GLINT_GLSL.specular))
    expect(f.indexOf(TILE_GLINT_GLSL.specular)).toBeLessThan(f.indexOf('#include <lights_phong_fragment>'))
    expect(f.indexOf('uniform sampler2D uTileSpecularMap;')).toBeLessThan(f.indexOf('void main'))
    expect(TILE_GLINT_GLSL.specular).toContain('surfaceGlobeTex(uTileSpecularMap, surfaceGlobeUv).r')
    expect(TILE_GLINT_GLSL.specular).toContain('textureLod(bumpMap, vBumpMapUv, 0.0).x')
    expect(shader.uniforms.uTileSpecularMap).toBe(link.maps.specular)
    // The sea's depth, the globe's map through the link's uniform, sampled at
    // the end of the water's prelude (tides-d9f.6).
    expect(shader.uniforms.uWaterDepth).toBe(link.maps.depth)
    expect(TILE_GLINT_GLSL.normal).toContain('surfaceGlobeTex(uWaterDepth, surfaceGlobeUv).r')
    expect(f.indexOf('uniform sampler2D uWaterDepth;')).toBeLessThan(f.indexOf('void main'))
    expect(f.indexOf('surfaceGlobeTex(uWaterDepth, surfaceGlobeUv)')).toBeLessThan(f.indexOf('waterBody(diffuseColor.rgb)'))
    // The mask stays out of the material's slots (TilesRenderer frees those).
    expect(material.specularMap).toBeNull()
    expect(shader.vertexShader).not.toContain('glint')
    expect(f.split('varying ').length).toBe(THREE.ShaderLib.phong.fragmentShader.split('varying ').length)
  })

  it('replaces Phong\'s direct light with the water\'s, and lands the waves and the sky in order', () => {
    const { shader } = glintTile()
    const f = shader.fragmentShader
    expect(f.indexOf('#include <lights_phong_pars_fragment>')).toBeLessThan(f.indexOf('#define RE_Direct RE_Direct_Water'))
    expect(f.indexOf('#define RE_Direct RE_Direct_Water')).toBeLessThan(f.indexOf('#include <lights_fragment_begin>'))
    // The waves after the library's bump (normal_fragment_maps), before the emissive.
    expect(f.indexOf('#include <normal_fragment_maps>')).toBeLessThan(f.indexOf(TILE_GLINT_GLSL.normal))
    expect(f.indexOf(TILE_GLINT_GLSL.normal)).toBeLessThan(f.indexOf('#include <emissivemap_fragment>'))
    expect(f.indexOf('#include <lights_fragment_end>')).toBeLessThan(f.indexOf(TILE_GLINT_GLSL.sky))
  })

  it('reads the ground haze\'s sky, composed with every feature, before the shadow dims the light', () => {
    const mesh = tileMesh()
    createTileComposer(fakeLink(), TILE_FEATURES).prepare(mesh, {})
    const f = compiled(mesh.material as TerrainPhongMaterial).fragmentShader
    const at = (text: string) => {
      const i = f.indexOf(text)
      expect(i, text.slice(0, 60)).toBeGreaterThan(-1)
      return i
    }
    expect(TILE_GLINT_GLSL.sky).toContain('groundHazeSky(')
    expect(at('vec3 groundHazeSky(vec3 up, vec3 rd) {')).toBeLessThan(at('void main'))
    const sky = at(TILE_GLINT_GLSL.sky)
    expect(at('#include <lights_fragment_end>')).toBeLessThan(sky)
    expect(sky).toBeLessThan(at('reflectedLight.directSpecular *= surfaceSunLit;'))
    expect(sky).toBeLessThan(at('reflectedLight.indirectDiffuse *= groundHorizonSky;'))
  })

  it('binds the globe\'s wave phases, and no longer the Sun', () => {
    const { link, shader } = glintTile()
    expect(shader.uniforms.uWavePhase).toBe(link.water.uniforms.uWavePhase)
    expect(shader.uniforms.uTileGlintSun).toBeUndefined()
    expect(TILE_GLINT_GLSL.specular).toContain('if (uTileWet > 0.5) {')
    // No region (or no mask loaded yet): wet, the glint as without the flag.
    expect(shader.uniforms.uTileWet.value).toBe(1)
  })

  it('finds water over a tile\'s region, one cell wider, across the antimeridian', () => {
    const [w, h] = WATER_GRID
    const grid = new Uint8Array(w * h)
    const cell = (lon: number, lat: number) => Math.floor(((90 - lat) / 180) * h) * w + Math.floor(((lon + 180) / 360) * w)
    const deg = (r: number[]) => r.map((d) => (d * Math.PI) / 180)
    grid[cell(-87.5, 42)] = 200 // Lake Michigan
    expect(regionHasWater(grid, deg([-88, 41.5, -87, 42.5]))).toBe(true)
    expect(regionHasWater(grid, deg([-87.4, 42.1, -87.3, 42.2]))).toBe(true) // the neighbouring cell
    expect(regionHasWater(grid, deg([-100, 38, -99, 39]))).toBe(false) // Kansas
    grid[cell(-87.5, 42)] = 1 // JPEG noise
    expect(regionHasWater(grid, deg([-88, 41.5, -87, 42.5]))).toBe(false)
    grid[cell(-179.9, 0)] = 255
    expect(regionHasWater(grid, deg([179.5, -0.5, -179.5, 0.5]))).toBe(true) // west > east
    expect(regionHasWater(grid, deg([179.5, -0.5, 179.9, 0.5]))).toBe(true) // the wrap's margin
  })

  it('takes its ramps from the exported constants (the GLSL mirrors glintStrength)', () => {
    const s = TILE_GLINT_GLSL.specular
    for (const [a, b] of [GLINT_SEA_LEVEL, GLINT_SEA, GLINT_INLAND]) expect(s).toContain(`smoothstep(${a.toFixed(6)}, ${b.toFixed(6)},`)
    expect(s).toContain('abs(textureLod(bumpMap, vBumpMapUv, 0.0).x)')
  })

  it('glints the open sea as the globe does, and the water to the DEM\'s coast', () => {
    expect(glintStrength(1, 0)).toBe(1) // open sea: the globe's mask, full
    expect(glintStrength(0.35, 0)).toBe(1) // near-shore water the coarse mask fades
    expect(glintStrength(0.15, 0)).toBeGreaterThan(0.3)
  })

  it('keeps the land dry at the sea\'s coast and a lake\'s shore', () => {
    expect(glintStrength(0.5, 3)).toBe(0) // coastal land the coarse mask spills onto
    expect(glintStrength(0.35, 1)).toBe(0)
    expect(glintStrength(0.5, 180)).toBe(0) // the Great Lakes' shore
    expect(glintStrength(0, 0)).toBe(0) // sea-level land the mask calls land
  })

  it('glints inland lakes by the mask, above and below sea level, and no dry depression', () => {
    expect(glintStrength(1, 176)).toBe(1) // Lake Michigan
    expect(glintStrength(1, -28)).toBe(1) // the Caspian
    expect(glintStrength(0.4, -400)).toBe(0) // the Dead Sea's shores
    expect(glintStrength(0, -86)).toBe(0) // Death Valley
    expect(glintStrength(0.02, 0.4)).toBe(0) // JPEG noise on a low beach
  })

  it('glints sea-level land under the coarse mask\'s spill (the known limit: tidal flats, deltas)', () => {
    expect(glintStrength(0.3, 0.2)).toBeGreaterThan(0.9)
  })
})
