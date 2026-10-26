// The sun glint on the streamed tiles (tides-zmw.9.14): the globe's Phong
// specular, its strength from the globe's water mask sharpened at the coast
// by the tile's own elevation.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { BLINN_PHONG_DIRECT, GLINT_INLAND, GLINT_SEA, GLINT_SEA_LEVEL, GLINT_SUN, glintStrength, regionHasWater, tileGlint, TILE_GLINT_GLSL, WATER_GRID } from './tile-glint'
import { createTileComposer, GLOBE_SHININESS, GLOBE_SPECULAR, SURFACE_ANCHORS, type TerrainPhongMaterial } from './tile-material'
import { compiled, fakeLink, tileMesh } from './tile-test-fixtures'

function glintTile() {
  const link = fakeLink()
  const mesh = tileMesh()
  const composer = createTileComposer(link, [{ name: 'glint', adapter: tileGlint }])
  composer.prepare(mesh, {})
  const material = mesh.material as TerrainPhongMaterial
  return { link, composer, material, shader: compiled(material) }
}

describe('the glint on the tiles (tides-zmw.9.14)', () => {
  it('shades with the globe\'s Phong specular colour and shininess', () => {
    const { material } = glintTile()
    expect(material.specular.getHex()).toBe(GLOBE_SPECULAR)
    expect(material.shininess).toBe(GLOBE_SHININESS)
    expect(GLOBE_SPECULAR).toBe(new THREE.MeshPhongMaterial().specular.getHex()) // the globe leaves three's default
    expect(GLOBE_SHININESS).toBe(100) // EarthRenderer's shininess={100}
  })

  it('sets the strength after the base zeroes it, from the globe\'s mask through a uniform and the tile\'s grid', () => {
    const { link, composer, material, shader } = glintTile()
    expect(composer.key).toBe('surface-tile:surface-base+glint-surface')
    const f = shader.fragmentShader
    expect(f.indexOf('specularStrength = 0.0;')).toBeLessThan(f.indexOf(TILE_GLINT_GLSL.specular))
    expect(f.indexOf(SURFACE_ANCHORS.specular)).toBeLessThan(f.indexOf(TILE_GLINT_GLSL.specular))
    expect(f.indexOf('#include <specularmap_fragment>')).toBeLessThan(f.indexOf(TILE_GLINT_GLSL.specular))
    expect(f.indexOf(TILE_GLINT_GLSL.specular)).toBeLessThan(f.indexOf('#include <lights_phong_fragment>'))
    expect(f.indexOf('uniform sampler2D uTileSpecularMap;')).toBeLessThan(f.indexOf('void main'))
    expect(TILE_GLINT_GLSL.specular).toContain('surfaceGlobeTex(uTileSpecularMap, surfaceGlobeUv).r')
    expect(TILE_GLINT_GLSL.specular).toContain('textureLod(bumpMap, vBumpMapUv, 0.0).x')
    expect(shader.uniforms.uTileSpecularMap).toBe(link.maps.specular)
    // The mask stays out of the material's slots (TilesRenderer frees those).
    expect(material.specularMap).toBeNull()
    expect(shader.vertexShader).not.toContain('glint')
    expect(f.split('varying ').length).toBe(THREE.ShaderLib.phong.fragmentShader.split('varying ').length)
  })

  it('skips Phong\'s specular term only where the strength is 0, on three\'s own direct light', () => {
    // A three upgrade that changes RE_Direct_BlinnPhong fails here, not on screen.
    expect(THREE.ShaderChunk.lights_phong_pars_fragment).toContain(BLINN_PHONG_DIRECT)
    const gated = TILE_GLINT_GLSL.direct
    expect(gated).toContain('if ( material.specularStrength > 0.0 ) reflectedLight.directSpecular += irradiance * BRDF_BlinnPhong(')
    expect(gated.replace('RE_Direct_TileGlint(', 'RE_Direct_BlinnPhong(').replace('\tif ( material.specularStrength > 0.0 ) ', '\t')).toContain(BLINN_PHONG_DIRECT)
    const { shader } = glintTile()
    const f = shader.fragmentShader
    expect(f.indexOf('#include <lights_phong_pars_fragment>')).toBeLessThan(f.indexOf('#define RE_Direct RE_Direct_TileGlint'))
    expect(f.indexOf('#define RE_Direct RE_Direct_TileGlint')).toBeLessThan(f.indexOf('#include <lights_fragment_begin>'))
  })

  it('skips the taps on the Sun\'s far side and on dry tiles, and binds the link\'s Sun', () => {
    expect(GLINT_SUN).toBe(-0.02)
    expect(TILE_GLINT_GLSL.specular).toContain('if (uTileWet > 0.5 && dot(surfaceUp, uTileGlintSun) > -0.020000) {')
    const { link, shader } = glintTile()
    expect(shader.uniforms.uTileGlintSun).toBe(link.sunDir)
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
