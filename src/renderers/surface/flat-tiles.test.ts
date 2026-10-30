import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { TilesRenderer } from '3d-tiles-renderer/three'
import { TerrariumMeshPlugin } from '3d-tiles-renderer/three/plugins'
import { SkirtedPlaneGeometry } from '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/SkirtedPlaneGeometry.js'
import { coarseTileIndex, createFlatTilePlugin, FLAT_TILE_CHORD_METRES, flatTileSegments } from './flat-tiles'
import { SURFACE_ELLIPSOID_RADIUS } from './surface-frame'
import { tileHeightRange } from './terrain-internals'

const SURFACE = 6 * 32 * 32
const SKIRTS = 6 * 4 * 32

/** A tile's mesh as the library makes it, `width` by `height` metres. */
function tileMesh(width: number, height = width) {
  const geometry = new SkirtedPlaneGeometry(1, 1, 32, 32)
  geometry.scale(width, height, 1)
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
}

/** A tile carrying the plugin's measured range. */
const tileOf = (min: number, max: number) => ({ [Symbol('HEIGHT_RANGE')]: { min, max } })

/** Parses `mesh` for `tile` through the plugin, as the renderer does at parse: the index entries it draws. */
function parse(mesh: THREE.Mesh, tile: object) {
  createFlatTilePlugin().processTileModel(mesh, tile)
  const array = mesh.geometry.index!.array as Uint32Array
  const { count } = mesh.geometry.drawRange
  return Number.isFinite(count) ? array.subarray(0, count) : array
}

const libraryIndex = () => new SkirtedPlaneGeometry(1, 1, 32, 32).index!.array as Uint32Array

/** Twice the signed area of triangle (a, b, c) in uv. */
function uvArea(uv: THREE.BufferAttribute, a: number, b: number, c: number) {
  const ax = uv.getX(a)
  const ay = uv.getY(a)
  return (uv.getX(b) - ax) * (uv.getY(c) - ay) - (uv.getY(b) - ay) * (uv.getX(c) - ax)
}

describe('flat tiles (tides-zmw.9.33)', () => {
  it.each([
    [300_000, 32],
    [130_000, 32],
    [50_000, 16],
    [9_000, 4],
    [8_000, 2],
    [1_000, 1],
  ])('gives a flat %d m tile %d segments a side', (metres, n) => {
    const mesh = tileMesh(metres)
    expect(flatTileSegments(mesh.geometry.attributes.position as THREE.BufferAttribute)).toBe(n)
    expect(parse(mesh, tileOf(0, 0))).toHaveLength(6 * n * n + SKIRTS)
  })

  it('sizes the segments by the longest edge', () => {
    expect(flatTileSegments(tileMesh(9_000, 50_000).geometry.attributes.position as THREE.BufferAttribute)).toBe(16)
    expect(flatTileSegments(tileMesh(50_000, 9_000).geometry.attributes.position as THREE.BufferAttribute)).toBe(16)
  })

  it('keeps every coarse segment within FLAT_TILE_CHORD_METRES, ~0.31 m of sag', () => {
    for (const metres of [500, 4_001, 16_000, 31_999, 64_000, 127_999]) {
      const n = flatTileSegments(tileMesh(metres).geometry.attributes.position as THREE.BufferAttribute)
      expect(metres / n).toBeLessThanOrEqual(FLAT_TILE_CHORD_METRES)
      if (n > 1) expect(metres / (n / 2)).toBeGreaterThan(FLAT_TILE_CHORD_METRES)
    }
    expect(FLAT_TILE_CHORD_METRES ** 2 / (8 * SURFACE_ELLIPSOID_RADIUS)).toBeCloseTo(0.31, 2)
  })

  it('leaves a tile with any vertex off sea level, no range, or all 32 segments, as the library made it', () => {
    for (const tile of [tileOf(-1, 0), tileOf(0, 3), tileOf(-40, 120), {}]) {
      const mesh = tileMesh(9_000)
      expect(parse(mesh, tile)).toEqual(libraryIndex())
      expect(mesh.geometry.drawRange.count).toBe(Infinity)
    }
    const wide = tileMesh(300_000)
    expect(parse(wide, tileOf(0, 0))).toEqual(libraryIndex())
    expect(wide.geometry.drawRange.count).toBe(Infinity)
  })

  it("reproduces the library's index at 32 segments", () => {
    const original = new SkirtedPlaneGeometry(1, 1, 32, 32).index!.array as Uint32Array
    expect(coarseTileIndex(original, 32)).toEqual(original)
  })

  it.each([1, 2, 4, 8, 16])('draws %d segments a side over the same surface, facing the same way, skirts untouched', (n) => {
    const geometry = new SkirtedPlaneGeometry(1, 1, 32, 32)
    const original = geometry.index!.array as Uint32Array
    const index = coarseTileIndex(original, n)
    expect(index).toBeInstanceOf(Uint32Array)
    const uv = geometry.attributes.uv as THREE.BufferAttribute
    const facing = Math.sign(uvArea(uv, original[0], original[1], original[2]))
    const step = 32 / n
    let area = 0
    for (let t = 0; t < 6 * n * n; t += 3) {
      const signed = uvArea(uv, index[t], index[t + 1], index[t + 2])
      expect(Math.sign(signed)).toBe(facing)
      area += Math.abs(signed) / 2
      for (const v of index.subarray(t, t + 3)) {
        expect(v).toBeLessThan(33 * 33)
        expect((v % 33) % step).toBe(0)
        expect(Math.floor(v / 33) % step).toBe(0)
      }
    }
    expect(area).toBeCloseTo(1, 10)
    expect(Array.from(index.subarray(6 * n * n))).toEqual(Array.from(original.subarray(SURFACE)))
  })

  it('rewrites the index in place, never swapping the attribute (three frees only the current one)', () => {
    const mesh = tileMesh(9_000)
    const index = mesh.geometry.index
    parse(mesh, tileOf(0, 0))
    expect(mesh.geometry.index).toBe(index)
    expect(index!.array).toHaveLength(SURFACE + SKIRTS)
    expect(mesh.geometry.drawRange.count).toBe(6 * 4 * 4 + SKIRTS)
  })

  describe('when a neighbour is stitched in later', () => {
    /** A flat 9 km tile drawing a 4 x 4 grid of zeros, parsed. */
    function stitchedTile() {
      const data = new Float32Array(16)
      const grid = new THREE.DataTexture(data, 4, 4, THREE.RedFormat, THREE.FloatType)
      const mesh = new THREE.Mesh(tileMesh(9_000).geometry, new THREE.MeshPhongMaterial({ displacementMap: grid }))
      parse(mesh, tileOf(0, 0))
      const draw = () => mesh.onBeforeRender({} as THREE.WebGLRenderer, new THREE.Scene(), new THREE.Camera(), mesh.geometry, mesh.material as THREE.Material, null)
      return { mesh, grid, data, draw }
    }

    it('stays coarse while the grid holds only sea level', () => {
      const { mesh, grid, draw } = stitchedTile()
      draw()
      grid.needsUpdate = true
      draw()
      expect(mesh.geometry.drawRange.count).toBe(6 * 4 * 4 + SKIRTS)
    })

    it("takes the library's index back once land reaches under a vertex", () => {
      const { mesh, grid, data, draw } = stitchedTile()
      // The stitched border: a land neighbour's edge texel.
      data[3] = 12
      draw()
      // Not until the stitch's needsUpdate moves the source's version.
      expect(mesh.geometry.drawRange.count).toBe(6 * 4 * 4 + SKIRTS)
      grid.needsUpdate = true
      const version = mesh.geometry.index!.version
      draw()
      expect(mesh.geometry.drawRange.count).toBe(Infinity)
      expect(mesh.geometry.index!.array).toEqual(libraryIndex())
      expect(mesh.geometry.index!.version).toBeGreaterThan(version)
    })
  })

  it("leaves the vertices alone (the ship's floor reads them)", () => {
    const mesh = tileMesh(9_000)
    const position = mesh.geometry.attributes.position.array.slice()
    const uv = mesh.geometry.attributes.uv.array.slice()
    parse(mesh, tileOf(0, 0))
    expect(mesh.geometry.attributes.position.array).toEqual(position)
    expect(mesh.geometry.attributes.uv.array).toEqual(uv)
  })

  // The real 0.5.3 plugin's tiles: the range is there by processTileModel,
  // and the mesh's frame is ECEF metres.
  describe('on the library plugin', () => {
    // The library's GridCache constructor makes an OffscreenCanvas (node has none).
    beforeEach(() => vi.stubGlobal('OffscreenCanvas', class {}))
    afterEach(() => vi.unstubAllGlobals())

    async function libraryTile(x: number, y: number, level: number, height: (i: number, j: number) => number) {
      const dim = 16
      const padded = dim + 2
      const tiles = new TilesRenderer()
      tiles.ellipsoid.radius.setScalar(SURFACE_ELLIPSOID_RADIUS)
      const plugin = new TerrariumMeshPlugin({ url: 'https://example.test/{z}/{x}/{y}.webp', tileDimension: dim, maxZoom: 16 })
      tiles.registerPlugin(plugin)
      ;(tiles as unknown as { preprocessTileset: () => void }).preprocessTileset = () => {}
      const internals = plugin as unknown as {
        loadRootTileset(): Promise<unknown>
        createChild(x: number, y: number, level: number): { boundingVolume: { region: number[] } } & Record<string, unknown>
        parseToMesh(buffer: ArrayBuffer, tile: unknown, ext: string, url: string, signal: AbortSignal): Promise<THREE.Mesh>
        _gridCache: unknown
      }
      await internals.loadRootTileset()
      const data = new Float32Array(padded * padded)
      for (let j = 0; j < padded; j++) for (let i = 0; i < padded; i++) data[j * padded + i] = height(i, j)
      const grid = new THREE.DataTexture(data, padded, padded, THREE.RedFormat, THREE.FloatType)
      internals._gridCache = { lock: () => grid, release() {} }
      const tile = internals.createChild(x, y, level)
      const [w, s, e, n] = tile.boundingVolume.region
      const centre = tiles.ellipsoid.getCartographicToPosition((s + n) / 2, (w + e) / 2, 0, new THREE.Vector3())
      tile.engineData = {
        boundingVolume: {
          getSphere: (sphere: THREE.Sphere) => (sphere.center.copy(centre), (sphere.radius = 1e7), sphere),
          setRegionData() {},
        },
      }
      const mesh = await internals.parseToMesh(new ArrayBuffer(0), tile, 'terrain', 'u', new AbortController().signal)
      return { tile, mesh }
    }

    // 20N 150W at z12: ~9.2 km a side
    const [X, Y, LEVEL] = [341, 1820, 12]

    it('coarsens a sea-level tile', async () => {
      const { tile, mesh } = await libraryTile(X, Y, LEVEL, () => 0)
      expect(tileHeightRange(tile)).toEqual({ min: 0, max: 0 })
      const before = mesh.geometry.index!.array as Uint32Array
      const index = parse(mesh, tile)
      expect(index).toHaveLength(6 * 4 * 4 + SKIRTS)
      expect(index.subarray(6 * 4 * 4)).toEqual(before.subarray(SURFACE))
    })

    it('leaves a tile with an island alone', async () => {
      const { tile, mesh } = await libraryTile(X, Y, LEVEL, (i, j) => (i === 9 && j === 9 ? 30 : 0))
      expect(tileHeightRange(tile)!.max).toBeGreaterThan(0)
      expect(parse(mesh, tile)).toEqual(libraryIndex())
    })
  })
})
