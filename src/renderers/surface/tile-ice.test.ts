// The seasons tour's sea ice on the streamed tiles (tides-5oz): no texture
// unit of its own, its block placed between the glint's strength and the
// water's body, the shell's alpha and colour, and the per-tile gate.
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { gridPoint, NORTH_GRID, sampleGrid, unpackSeaIce } from '../../demo/sea-ice'
import { shippedSeaIceMask } from '../png-rgb-fixture'
import { attachSeaIce, SEA_ICE_ALBEDO_GLSL, SEA_ICE_LAYER, SEA_ICE_LAYER_SIZE, SEA_ICE_TAP_GLSL, seaIceSurface, showSeaIceFrames } from '../seaIceLayers'
import { waterSeaTexture, WATER_SEA_UNIFORM } from '../waterClimate'
import { ICE_LINEAR, ICE_SEA, iceOnTile, OCEAN_LINEAR, tileIce, TILE_ICE_GLSL } from './tile-ice'
import { TILE_GLINT_GLSL } from './tile-glint'
import { TILE_FEATURES } from './tile-features'
import { createTileComposer, type TerrainPhongMaterial } from './tile-material'
import { compiled, fakeLink, tileMesh } from './tile-test-fixtures'

const ice = unpackSeaIce(new Uint8Array(gunzipSync(readFileSync('src/assets/sea-ice-2025.bin'))))
const SEPTEMBER = 37 // 17 September 2025
const MARCH = 11 // 19 March 2025

function allFeatures(tile: object = {}) {
  const mesh = tileMesh()
  createTileComposer(fakeLink(), TILE_FEATURES).prepare(mesh, tile)
  const material = mesh.material as TerrainPhongMaterial
  return { mesh, material, shader: compiled(material) }
}

const samplers = (f: string) => f.match(/uniform\s+sampler\w+\s+\w+/g) ?? []

let release: () => void = () => {}
beforeAll(async () => {
  const revision = seaIceSurface.revision
  release = attachSeaIce(ice, shippedSeaIceMask())
  await vi.waitFor(() => expect(seaIceSurface.revision).toBeGreaterThan(revision), { timeout: 4000, interval: 2 })
})
afterAll(() => release())

describe('the sea ice on the tiles (tides-5oz)', () => {
  it('binds no texture of its own: the water\'s array, declared once', () => {
    const withIce = allFeatures().shader
    const mesh = tileMesh()
    createTileComposer(fakeLink(), TILE_FEATURES.filter(({ name }) => name !== 'ice')).prepare(mesh, {})
    const without = compiled(mesh.material as TerrainPhongMaterial)
    expect(samplers(withIce.fragmentShader)).toEqual(samplers(without.fragmentShader))
    expect(withIce.fragmentShader.split(WATER_SEA_UNIFORM).length - 1).toBe(1)
    expect(withIce.uniforms.uWaterSea.value).toBe(waterSeaTexture())
    // Alone (no glint), it declares the array itself.
    const alone = tileMesh()
    createTileComposer(fakeLink(), [{ name: 'ice', adapter: tileIce }]).prepare(alone, {})
    const f = compiled(alone.material as TerrainPhongMaterial).fragmentShader
    expect(f.split(WATER_SEA_UNIFORM).length - 1).toBe(1)
    expect(f.indexOf(WATER_SEA_UNIFORM)).toBeLessThan(f.indexOf('void main'))
  })

  it('keys its program, with no variant of its own', () => {
    const mesh = tileMesh()
    const composer = createTileComposer(fakeLink(), TILE_FEATURES)
    composer.prepare(mesh, {})
    expect(composer.key).toContain('+water-surface+sea-ice-surface+ground-haze-surface')
    expect(composer.features).toContain('ice')
    expect(TILE_ICE_GLSL.head + TILE_ICE_GLSL.body + TILE_ICE_GLSL.colour).not.toMatch(/#define|#if(?!def USE_BUMPMAP)/)
  })

  it('runs after the glint\'s strength and before the water\'s body, and paints before the night\'s lights', () => {
    const f = allFeatures().shader.fragmentShader
    const at = (text: string) => {
      const i = f.indexOf(text)
      expect(i, text.slice(0, 60)).toBeGreaterThan(-1)
      return i
    }
    const body = at(TILE_ICE_GLSL.body)
    expect(at(TILE_GLINT_GLSL.specular)).toBeLessThan(body)
    expect(at('#include <normal_fragment_maps>')).toBeLessThan(body)
    expect(body).toBeLessThan(at('waterBody(diffuseColor.rgb)'))
    expect(body).toBeLessThan(at('float glintDeep = specularStrength'))
    const colour = at(TILE_ICE_GLSL.colour)
    expect(at('#include <emissivemap_fragment>')).toBeLessThan(colour)
    expect(colour).toBeLessThan(at('totalEmissiveRadiance = uTileCityLights'))
    expect(colour).toBeLessThan(at('#include <lights_phong_fragment>'))
    expect(at(TILE_ICE_GLSL.head)).toBeLessThan(at('void main'))
    // Switched by one uniform: the ice on and the tile's gate, folded.
    expect(TILE_ICE_GLSL.body).toContain('if (uTileIce > 0.5) {')
    expect(f).not.toContain('uSeaIceOn')
    expect(TILE_ICE_GLSL.body).toContain('specularStrength *= 1.0 - seaIceAlpha;')
    // The ground's tap and maths (seaIceLayers.ts): bounded to the grid.
    expect(TILE_ICE_GLSL.body).toContain(SEA_ICE_TAP_GLSL('surfaceUp'))
    expect(TILE_ICE_GLSL.body).toContain(`seaIceNorth ? ${SEA_ICE_LAYER.north.toFixed(6)} : ${SEA_ICE_LAYER.south.toFixed(6)}`)
    expect(TILE_ICE_GLSL.body).toContain(`seaIceAt / ${SEA_ICE_LAYER_SIZE.toFixed(6)}`)
    expect(TILE_ICE_GLSL.body).toContain(`smoothstep(${ICE_SEA[0].toFixed(6)}, ${ICE_SEA[1].toFixed(6)}, seaIceTexel.b)`)
    expect(TILE_ICE_GLSL.head).toContain('vec2 seaIceCells(vec3 dir) {')
    expect(TILE_ICE_GLSL.colour).toContain('if (seaIceAlpha > 0.0)')
    // The colour made with the alpha, the ground's.
    expect(TILE_ICE_GLSL.body).toContain(`seaIceAlbedo = ${SEA_ICE_ALBEDO_GLSL};`)
  })

  it('shares the ice\'s blend with the ground', () => {
    const { shader } = allFeatures()
    expect(shader.uniforms.uSeaIceMix).toBe(seaIceSurface.mix)
    // The probe (no tile) skips the block.
    const probe = createTileComposer(fakeLink(), TILE_FEATURES).material(tileMesh().material as THREE.MeshLambertMaterial)
    expect(compiled(probe).uniforms.uTileIce.value).toBe(0)
  })

  it('draws what the shell draws over the open sea: its alpha and colour, at the cells', () => {
    const data = waterSeaTexture().image.data as Uint8Array
    const texel = (layer: number, col: number, row: number) => {
      const o = layer * SEA_ICE_LAYER_SIZE * SEA_ICE_LAYER_SIZE * 4 + (row * SEA_ICE_LAYER_SIZE + col) * 4
      return Array.from(data.subarray(o, o + 4), (v) => v / 255)
    }
    let checked = 0
    for (const [lat, lon] of [[85, 0], [82.5, 45], [80, 90], [87.5, -135], [80, -170], [76, -150]]) {
      const p = gridPoint(NORTH_GRID, lat, lon)
      const [col, row] = [Math.floor(p.col), Math.floor(p.row)]
      for (const [a, b, mix] of [[SEPTEMBER, SEPTEMBER + 1, 0.3], [MARCH, MARCH + 1, 0.6]]) {
        const t = texel(SEA_ICE_LAYER.north, col, row)
        t[0] = ice.north.frames[a][row * NORTH_GRID.width + col] / 255
        t[1] = ice.north.frames[b][row * NORTH_GRID.width + col] / 255
        if (t[2] < 1 || t[3] < 1) continue
        // The shell over open sea where the day map paints ice (mask r = g = 1).
        const cover = (1 - mix) * sampleGrid(ice.north.frames[a], 304, 448, col + 0.5, row + 0.5) + mix * sampleGrid(ice.north.frames[b], 304, 448, col + 0.5, row + 0.5)
        const shell = { alpha: Math.max(cover, 1), albedo: OCEAN_LINEAR.clone().lerp(ICE_LINEAR, cover / Math.max(cover, 1, 1e-3)) }
        const tile = iceOnTile(t, mix, 0)
        expect(tile.alpha).toBeCloseTo(shell.alpha, 6)
        for (const c of ['r', 'g', 'b'] as const) expect(tile.albedo[c]).toBeCloseTo(shell.albedo[c], 6)
        checked++
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8)
  })

  it('opens the water north of Franz Josef Land in September and freezes it in March', () => {
    const p = gridPoint(NORTH_GRID, 82.5, 45)
    const cell = Math.floor(p.row) * NORTH_GRID.width + Math.floor(p.col)
    const data = waterSeaTexture().image.data as Uint8Array
    const o = SEA_ICE_LAYER.north * SEA_ICE_LAYER_SIZE * SEA_ICE_LAYER_SIZE * 4 + (Math.floor(p.row) * SEA_ICE_LAYER_SIZE + Math.floor(p.col)) * 4
    const [b, a] = [data[o + 2] / 255, data[o + 3] / 255]
    expect(b).toBe(1)
    expect(a).toBe(1)
    const september = iceOnTile([ice.north.frames[SEPTEMBER][cell] / 255, 0, b, a], 0, 0)
    expect(september.alpha).toBe(1)
    expect(september.albedo.equals(OCEAN_LINEAR)).toBe(true)
    const march = iceOnTile([ice.north.frames[MARCH][cell] / 255, 0, b, a], 0, 0)
    expect(march.alpha).toBe(1)
    expect(march.albedo.r).toBeGreaterThan(0.8 * ICE_LINEAR.r)
    // Never on the land beside it (above sea level), nor a cell from any sea.
    expect(iceOnTile([1, 1, 1, 1], 0, 3).alpha).toBe(0)
    expect(iceOnTile([1, 1, 0, 0], 0, 0).alpha).toBe(0)
    // The day map's water stays the imagery's: no all-year ice, no cover.
    expect(iceOnTile([0, 0, 1, 0], 0, 0).alpha).toBe(0)
  })

  it('gates each tile by its region, and re-reads the gate when the ice changes', () => {
    const deg = (r: number[]) => r.map((d) => (d * Math.PI) / 180)
    const arctic = allFeatures({ boundingVolume: { region: deg([-150, 80, -149, 81, 0, 0]) } })
    const sahara = allFeatures({ boundingVolume: { region: deg([5, 20, 6, 21, 0, 0]) } })
    const none = allFeatures({})
    // Off until a tile draws with the ice on.
    for (const t of [arctic, sahara, none]) expect(t.shader.uniforms.uTileIce.value).toBe(0)
    // A draw of an icy tile writes the date's frames and turns the ice on;
    // the Sahara's never does.
    showSeaIceFrames(ice, { a: SEPTEMBER, b: SEPTEMBER + 1, mix: 0 })
    const draw = (mesh: THREE.Mesh) => mesh.onBeforeRender({} as THREE.WebGLRenderer, new THREE.Scene(), new THREE.Camera(), mesh.geometry, mesh.material as THREE.Material, null)
    expect(seaIceSurface.on.value).toBe(0)
    draw(sahara.mesh)
    expect(seaIceSurface.on.value).toBe(0)
    expect(sahara.shader.uniforms.uTileIce.value).toBe(0)
    draw(arctic.mesh)
    expect(seaIceSurface.on.value).toBe(1)
    expect(arctic.shader.uniforms.uTileIce.value).toBe(1)
    draw(none.mesh)
    expect(none.shader.uniforms.uTileIce.value).toBe(1)
    draw(sahara.mesh)
    expect(sahara.shader.uniforms.uTileIce.value).toBe(0)
    // The globe hides the ice: the next draw turns the block off.
    showSeaIceFrames(ice, null)
    draw(arctic.mesh)
    expect(arctic.shader.uniforms.uTileIce.value).toBe(0)
    showSeaIceFrames(ice, { a: SEPTEMBER, b: SEPTEMBER + 1, mix: 0 })
    draw(arctic.mesh)
    expect(arctic.shader.uniforms.uTileIce.value).toBe(1)
    // A chained hook keeps the one before it.
    const before = vi.fn()
    const mesh = tileMesh()
    mesh.onBeforeRender = before
    createTileComposer(fakeLink(), TILE_FEATURES).prepare(mesh, {})
    draw(mesh)
    expect(before).toHaveBeenCalledOnce()
    // The gate's revision: re-read at the next draw.
    seaIceSurface.revision++
    draw(sahara.mesh)
    expect(sahara.shader.uniforms.uTileIce.value).toBe(0)
    draw(arctic.mesh)
    expect(arctic.shader.uniforms.uTileIce.value).toBe(1)
  })
})
