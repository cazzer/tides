// The globe's colour on the streamed tiles (tides-zmw.9.11): the albedo's
// anchor to the day map, its ease with height, the sky fill by rename, the
// relief's evening out, and each tile's reference bound and freed.
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { GROUND_DETAIL_GLSL, groundDetailPatch } from '../groundDetail'
import {
  COLOUR_MATCH_BOTTOM_METRES,
  COLOUR_MATCH_TOP_METRES,
  COLOUR_REF_FADE_MS,
  colourEyeWeight,
  colourMatchWeight,
  createTileColour,
  fitTileGlobe,
  TILE_COLOUR_GLSL,
  TILE_SKY_FILL,
  type TileColourUniforms,
} from './tile-colour'
import { colourRefWindow, mercatorX, mercatorY, type ColourRefStore } from './tile-colour-ref'
import { createTileComposer, SURFACE_ANCHORS, type TerrainPhongMaterial } from './tile-material'
import { compiled, fakeLink, phongShader, tileMesh } from './tile-test-fixtures'

/** A store that records requests and hands their textures over on demand. */
function fakeStore() {
  const requests: { window: unknown; ready: (t: THREE.DataTexture) => void; released: boolean }[] = []
  const store: ColourRefStore = {
    request(window, ready) {
      const entry = { window, ready, released: false }
      requests.push(entry)
      return () => {
        entry.released = true
      }
    },
    size: 0,
  }
  return { store, requests }
}

/** A terrain tile as the plugin makes it: its region and its level. */
function terrainTile(level: number, west: number, south: number, east: number, north: number) {
  const tile: Record<string | symbol, unknown> = { boundingVolume: { region: [west, south, east, north, 0, 1] } }
  tile[Symbol('TILE_X')] = 0
  tile[Symbol('TILE_Y')] = 0
  tile[Symbol('TILE_LEVEL')] = level
  return tile
}

/** A Web Mercator tile's footprint, radians. */
function mercatorBounds(z: number, x: number, y: number) {
  const n = 2 ** z
  const lat = (row: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n)))
  return { west: (x / n) * 2 * Math.PI - Math.PI, east: ((x + 1) / n) * 2 * Math.PI - Math.PI, north: lat(y), south: lat(y + 1) }
}
const latOfMercator = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y)))

/**
 * A tile mesh as the terrain plugin builds it over Mercator tile z/x/y: a
 * grid of vertices on the sphere, ECEF metres from the tile's centre (its
 * position), with uvs the imagery's (t up, to the north), and the map's
 * transform (offset and repeat, as the plugin sets them).
 */
function terrainMesh(z: number, x: number, y: number, radius = 6371000) {
  const b = mercatorBounds(z, x, y)
  const [yN, yS] = [mercatorY(b.north), mercatorY(b.south)]
  const centre = new THREE.Vector3()
  const ecef = (lon: number, lat: number) =>
    new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)).multiplyScalar(radius)
  centre.copy(ecef((b.west + b.east) / 2, (b.north + b.south) / 2))
  const positions: number[] = []
  const uvs: number[] = []
  const N = 16
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      // The mesh's uv spans the map's [0.25, 0.75] (offset -0.5, repeat 2).
      const [s, t] = [i / N, j / N]
      const lon = b.west + s * (b.east - b.west)
      const lat = latOfMercator(yS + t * (yN - yS))
      positions.push(...ecef(lon, lat).sub(centre).toArray())
      uvs.push(0.25 + s / 2, 0.25 + t / 2)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  const mesh = tileMesh(geometry)
  mesh.position.copy(centre)
  const map = (mesh.material as THREE.MeshLambertMaterial).map!
  map.offset.set(-0.5, -0.5)
  map.repeat.set(2, 2)
  return { mesh, map, bounds: b, yN, yS }
}

describe('the colour on the tiles (tides-zmw.9.11)', () => {
  it('weighs the day map fully from 50 km over the ground up, easing in log height to none at 5 km', () => {
    expect(colourMatchWeight(200_000)).toBe(1)
    expect(colourMatchWeight(COLOUR_MATCH_TOP_METRES)).toBe(1)
    expect(colourMatchWeight(COLOUR_MATCH_BOTTOM_METRES)).toBe(0)
    expect(colourMatchWeight(100)).toBe(0)
    expect(colourMatchWeight(Math.sqrt(COLOUR_MATCH_TOP_METRES * COLOUR_MATCH_BOTTOM_METRES))).toBeCloseTo(0.5, 9)
    let last = 0
    for (let m = 5000; m <= 50000; m *= 1.1) {
      const w = colourMatchWeight(m)
      expect(w).toBeGreaterThanOrEqual(last)
      last = w
    }
  })

  it('takes the globe\'s sky fill by rename, at the globe\'s share', () => {
    expect(TILE_COLOUR_GLSL.lightBody).toBe(
      GROUND_DETAIL_GLSL.lightBody
        .replace('#if defined(USE_MAP) && defined(USE_SPECULARMAP) && NUM_DIR_LIGHTS > 0', '#if NUM_DIR_LIGHTS > 0')
        .split('groundUp').join('surfaceGeomNormal')
    )
    const globe = phongShader()
    groundDetailPatch(false).onBeforeCompile(globe, {} as THREE.WebGLRenderer)
    expect(globe.fragmentShader).toContain(`#define GROUND_SKY_FILL ${TILE_SKY_FILL.toFixed(1)}\n`)
    expect(TILE_COLOUR_GLSL.fragmentHead).toContain(`#define GROUND_SKY_FILL ${TILE_SKY_FILL.toFixed(1)}\n`)
  })

  it('anchors the albedo after the imagery\'s lookup, evens the relief out after the sky fill, on the globe\'s maps', () => {
    const link = fakeLink()
    const mesh = tileMesh()
    const { store } = fakeStore()
    const composer = createTileComposer(link, [{ name: 'colour', adapter: createTileColour(() => store) }])
    expect(composer.key).toBe('surface-tile:surface-base+colour-surface')
    composer.prepare(mesh, {})
    const shader = compiled(mesh.material as TerrainPhongMaterial)
    const f = shader.fragmentShader
    expect(f.indexOf(SURFACE_ANCHORS.fragmentHead)).toBeLessThan(f.indexOf('uniform float uColourW;'))
    expect(f.indexOf('uniform float uColourW;')).toBeLessThan(f.indexOf('void main'))
    // After the base's ground point and the imagery's lookup, before the normal;
    // the globe's coordinate from the tile's own (not the base's surfaceGlobeUv).
    expect(f.indexOf('surfaceGround = uSurfaceEyeGround + surfaceRay;')).toBeLessThan(f.indexOf('float colourW = 0.0;'))
    expect(TILE_COLOUR_GLSL.albedoBody).not.toContain('surfaceGlobe')
    expect(TILE_COLOUR_GLSL.albedoBody).toContain('uColourGlobeU.x + uColourGlobeU.y * vMapUv.x')
    expect(f.indexOf('#include <map_fragment>')).toBeLessThan(f.indexOf('float colourW = 0.0;'))
    expect(f.indexOf('float colourW = 0.0;')).toBeLessThan(f.indexOf('#include <normal_fragment_begin>'))
    // The sky fill, then the evening out, both after the lights.
    const lights = f.indexOf('#include <lights_fragment_end>')
    const fill = f.indexOf('GROUND_SKY_FILL * groundSkyLight')
    const relief = f.indexOf('reflectedLight.directDiffuse *= mix(1.0, 1.0 / max(dot(normal, surfaceGeomNormal)')
    expect(lights).toBeLessThan(fill)
    expect(fill).toBeLessThan(relief)
    // The globe's own map objects, by uniform: never a material slot.
    expect(shader.uniforms.uColourDay).toBe(link.maps.day)
    expect(shader.uniforms.uColourWater).toBeUndefined()
    expect((mesh.material as THREE.MeshPhongMaterial).specularMap).toBeNull()
    // No varyings of its own.
    expect(shader.vertexShader).not.toContain('colour')
  })

  it('fits the globe\'s coordinate and the reference\'s to the tile\'s imagery coordinate', () => {
    for (const [z, x, y] of [
      [10, 197, 403],
      [6, 12, 25],
      [4, 3, 6],
    ]) {
      const { mesh, map, bounds, yN, yS } = terrainMesh(z, x, y)
      const window = colourRefWindow(bounds, z)
      const fit = fitTileGlobe(mesh, map, window)!
      expect(fit, `${z}/${x}/${y}`).not.toBeNull()
      const n = 256 * 2 ** window.zoom
      for (const [s, t] of [
        [0, 0],
        [0.3, 0.8],
        [1, 1],
        [0.62, 0.11],
      ]) {
        const lon = bounds.west + s * (bounds.east - bounds.west)
        const lat = latOfMercator(yS + t * (yN - yS))
        expect(fit.u[0] + fit.u[1] * s).toBeCloseTo(0.5 + lon / (2 * Math.PI), 9)
        // Latitude's quadratic: well under a day-map texel (1/5400) from level 4 down.
        expect(Math.abs(fit.v[0] + t * (fit.v[1] + t * fit.v[2]) - (0.5 + lat / Math.PI))).toBeLessThan(z >= 6 ? 1e-6 : 1.5e-4)
        expect(fit.refX[0] + fit.refX[1] * s).toBeCloseTo((mercatorX(lon) * n - window.x0) / window.width, 6)
        expect(fit.refY[0] + fit.refY[1] * t).toBeCloseTo((mercatorY(lat) * n - window.y0) / window.height, 6)
      }
    }
    // No vertices, no fit.
    expect(fitTileGlobe(tileMesh(), new THREE.Texture(), colourRefWindow(mercatorBounds(10, 197, 403), 10))).toBeNull()
  })

  it('weighs the day map by the eye\'s own height over the ground under it, one value for the view', () => {
    const R = 2.95
    const m = R / 6371000
    // Straight over the north pole, ground 3 km high there.
    const sampler = { maxElevation: vi.fn(() => ({ metres: 3000, covered: true })) }
    const at = (metresOverSea: number, s: typeof sampler | null = sampler) => colourEyeWeight(new THREE.Vector3(0, R + metresOverSea * m, 0), R, s)
    expect(at(60_000)).toBe(1)
    expect(at(52_000)).toBeCloseTo(colourMatchWeight(49_000), 4)
    expect(at(7_000)).toBe(0)
    expect(sampler.maxElevation).toHaveBeenLastCalledWith(Math.PI / 2, expect.any(Number), 1000)
    // Without tiles, the height over the sea.
    expect(at(52_000, null)).toBe(1)
  })

  it('binds each tile its fit and reference, the view\'s weight each draw, fades a late reference in, and frees it with the tile', () => {
    const link = fakeLink()
    const { store, requests } = fakeStore()
    const composer = createTileComposer(link, [{ name: 'colour', adapter: createTileColour(() => store) }])
    const { mesh, bounds } = terrainMesh(10, 197, 403)
    const tile = terrainTile(10, bounds.west, bounds.south, bounds.east, bounds.north)
    composer.prepare(mesh, tile)
    const material = mesh.material as TerrainPhongMaterial
    const own = compiled(material).uniforms as unknown as TileColourUniforms & { uColourW: THREE.IUniform<number> }
    expect(requests).toHaveLength(1)
    expect(requests[0].window).toEqual(colourRefWindow(bounds, 10))
    expect(own.uColourGlobeU.value.y).toBeGreaterThan(0)
    expect(own.uColourGlobeV.value.w).toBe(1)
    expect(own.uColourRefV.value.z).toBe(0)
    const draw = () =>
      mesh.onBeforeRender({} as THREE.WebGLRenderer, new THREE.Scene(), new THREE.Camera(), mesh.geometry, material, null as never)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
    try {
      const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1)
      requests[0].ready(texture)
      expect(own.uColourRef.value).toBe(texture)
      // The eye 200 km over the sea: the whole view at w 1; the reference fading in.
      link.haze.frame.uGroundHazeEyeLocal.value.set(0, link.seaLevel * (1 + 200 / 6371), 0)
      clock.mockReturnValue(1000 + COLOUR_REF_FADE_MS / 2)
      draw()
      expect(own.uColourW.value).toBe(1)
      expect(own.uColourRefV.value.z).toBeCloseTo(0.5, 9)
      clock.mockReturnValue(1000 + COLOUR_REF_FADE_MS * 2)
      link.haze.frame.uGroundHazeEyeLocal.value.set(0, link.seaLevel * (1 + 4 / 6371), 0)
      draw()
      expect(own.uColourW.value).toBe(0)
      expect(own.uColourRefV.value.z).toBe(1)
    } finally {
      clock.mockRestore()
    }
    // Unloaded: the request is released (the store disposes the texture).
    material.dispose()
    expect(requests[0].released).toBe(true)
  })

  it('takes a reference in hand at once, without the fade', () => {
    const texture = new THREE.DataTexture(new Uint8Array(4), 1, 1)
    const store: ColourRefStore = {
      request: (_window, ready) => (ready(texture), () => {}),
      size: 0,
    }
    const { mesh, bounds } = terrainMesh(10, 197, 403)
    createTileComposer(fakeLink(), [{ name: 'colour', adapter: createTileColour(() => store) }]).prepare(
      mesh,
      terrainTile(10, bounds.west, bounds.south, bounds.east, bounds.north)
    )
    const own = compiled(mesh.material as TerrainPhongMaterial).uniforms as unknown as TileColourUniforms
    expect(own.uColourRefV.value.z).toBe(1)
  })

  it('leaves a tile with no region on its own colour (no reference asked for)', () => {
    const { store, requests } = fakeStore()
    const spy = vi.spyOn(store, 'request')
    const mesh = tileMesh()
    createTileComposer(fakeLink(), [{ name: 'colour', adapter: createTileColour(() => store) }]).prepare(mesh, {})
    expect(spy).not.toHaveBeenCalled()
    expect(requests).toHaveLength(0)
    const shader = compiled(mesh.material as TerrainPhongMaterial)
    expect((shader.uniforms as unknown as TileColourUniforms).uColourGlobeV.value.w).toBe(0)
  })
})
