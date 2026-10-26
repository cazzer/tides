import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { TilesRenderer } from '3d-tiles-renderer/three'
import { TerrariumMeshPlugin } from '3d-tiles-renderer/three/plugins'
import { SURFACE_MAX_METRES } from '../../terrain-scale'
import { earthLatLon } from '../../surface-ground'
import {
  ANTICIPATE_MAX_M,
  SURFACE_TREE_DEEPEST,
  TILE_VERTICES,
  buildTileGround,
  coversWindow,
  createSurfaceGround,
  gridLinear,
  gridFootprintMax,
  gridNearest,
  type SurfaceGroundTiles,
} from './surface-ground'
import { SURFACE_ELLIPSOID_RADIUS, ecefToEarthLocal, surfaceEcef } from './surface-frame'
import { MAPTERHORN_MAX_ZOOM } from './createSurfaceTiles'

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

// Small grids keep the tests quick: the plugin meshes any tileDimension the same way.
const DIM = 16
const PADDED = DIM + 2

interface LibraryTile {
  tile: { boundingVolume: { region: number[] } }
  mesh: THREE.Mesh
}

interface Library {
  tile(x: number, y: number, level: number, height: (i: number, j: number) => number, filter?: 'linear' | 'nearest'): Promise<LibraryTile>
}

// Tiles meshed by the real 0.5.3 terrain plugin (its parseToMesh), each
// reading a padded grid of `height(column, row)` metres.
async function library(): Promise<Library> {
  const tiles = new TilesRenderer()
  tiles.ellipsoid.radius.setScalar(SURFACE_ELLIPSOID_RADIUS)
  const plugin = new TerrariumMeshPlugin({ url: 'https://example.test/{z}/{x}/{y}.webp', tileDimension: DIM, maxZoom: 16 })
  tiles.registerPlugin(plugin)
  // The synthetic tileset's preprocess wants a browser; nothing here needs it.
  ;(tiles as unknown as { preprocessTileset: () => void }).preprocessTileset = () => {}
  const internals = plugin as unknown as {
    loadRootTileset(): Promise<unknown>
    createChild(x: number, y: number, level: number): LibraryTile['tile'] & Record<string, unknown>
    parseToMesh(buffer: ArrayBuffer, tile: unknown, ext: string, url: string, signal: AbortSignal): Promise<THREE.Mesh>
    _gridCache: unknown
  }
  await internals.loadRootTileset()
  return {
    async tile(x, y, level, height, filter = 'linear') {
      const data = new Float32Array(PADDED * PADDED)
      for (let j = 0; j < PADDED; j++) for (let i = 0; i < PADDED; i++) data[j * PADDED + i] = height(i, j)
      const grid = new THREE.DataTexture(data, PADDED, PADDED, THREE.RedFormat, THREE.FloatType)
      // As SurfaceGridCache makes them.
      grid.minFilter = grid.magFilter = filter === 'linear' ? THREE.LinearFilter : THREE.NearestFilter
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
    },
  }
}

// A seeded generator, so a failure repeats.
function random(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function tilesOf(drawn: LibraryTile[], loaded: LibraryTile[]): SurfaceGroundTiles {
  const group = new THREE.Group()
  for (const { mesh } of drawn) group.children.push(mesh)
  const all = [...new Set([...drawn, ...loaded])]
  return {
    group,
    forEachLoadedModel: (callback) => all.forEach(({ mesh, tile }) => callback(mesh, tile)),
  }
}

describe('the surface ground sampler (tides-zmw.9.8)', () => {
  let lib: Library
  beforeEach(async () => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    lib = await library()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reads each vertex as the GPU does: bilinear, or the highest texel either side on a nearest grid; and places its rows and columns', async () => {
    const rand = random(7)
    const field = Array.from({ length: PADDED * PADDED }, () => 3000 * rand())
    const near = await lib.tile(1205, 3232, 13, (i, j) => field[j * PADDED + i], 'nearest')
    const nearGround = buildTileGround(near.mesh)!
    const { tile, mesh } = await lib.tile(1205, 3232, 13, (i, j) => field[j * PADDED + i])
    const ground = buildTileGround(mesh)!
    const image = (mesh.material as THREE.MeshStandardMaterial).displacementMap!.image as {
      data: Float32Array
      width: number
      height: number
    }
    const { uv } = mesh.geometry.attributes
    for (let i = 0; i < TILE_VERTICES * TILE_VERTICES; i++) {
      const [tu, tv] = [uv.getX(i), uv.getY(i)]
      expect(ground.heights[i]).toBeCloseTo(gridLinear(image, tu, tv), 3)
      // Nearest: whichever texel either side of the boundary the GPU takes.
      for (const [du, dv] of [[-1e-6, -1e-6], [1e-6, 1e-6], [0, 0], [-1e-6, 1e-6]]) {
        expect(nearGround.heights[i]).toBeGreaterThanOrEqual(gridNearest(image, tu + du, tv + dv) - 1e-3)
      }
      expect(nearGround.heights[i]).toBeCloseTo(gridFootprintMax(image, tu, tv), 3)
    }
    // The library's own linear read (its sampleGrid), for a vertex mid-tile.
    expect(gridLinear(image, 0.37, 0.61)).toBeCloseTo(
      (() => {
        const fx = 0.37 * PADDED - 0.5
        const fy = 0.61 * PADDED - 0.5
        const [x0, y0] = [Math.floor(fx), Math.floor(fy)]
        const [tx, ty] = [fx - x0, fy - y0]
        const at = (x: number, y: number) => image.data[y * PADDED + x]
        return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty
      })(),
      9
    )
    const [w, s, e, n] = tile.boundingVolume.region
    const lats = [ground.rowLat[0], ground.rowLat[TILE_VERTICES - 1]].sort((a, b) => a - b)
    expect(lats[0]).toBeCloseTo(s, 7)
    expect(lats[1]).toBeCloseTo(n, 7)
    expect(ground.colLon[0]).toBeCloseTo(w, 7)
    expect(ground.colLon[TILE_VERTICES - 1]).toBeCloseTo(e, 7)
    expect(ground.max).toBe(Math.max(...ground.heights))
  })

  it('never reads under the mesh the GPU draws, at any scale, across tile edges and two-tile windows', async () => {
    const rand = random(11)
    // Two neighbours over a canyon-like field: high walls, a deep gorge.
    const field = () => (rand() < 0.2 ? 2500 + 300 * rand() : 800 * rand())
    const a = await lib.tile(1205, 3232, 13, field)
    const b = await lib.tile(1206, 3232, 13, field)
    const sampler = createSurfaceGround(tilesOf([a, b], []))
    const raycaster = new THREE.Raycaster()
    const R = SURFACE_ELLIPSOID_RADIUS
    for (const scale of [1, 7.5]) {
      // The surface triangles, displaced as the vertex shader does.
      const drawn = [a, b].map(({ mesh }) => {
        const image = (mesh.material as THREE.MeshStandardMaterial).displacementMap!.image as Parameters<typeof gridLinear>[0]
        const { position, normal, uv } = mesh.geometry.attributes
        const surface = TILE_VERTICES * TILE_VERTICES
        const positions = new Float32Array(surface * 3)
        const p = new THREE.Vector3()
        const nrm = new THREE.Vector3()
        for (let i = 0; i < surface; i++) {
          p.fromBufferAttribute(position, i).add(mesh.position)
          nrm.fromBufferAttribute(normal, i)
          p.addScaledVector(nrm, gridLinear(image, uv.getX(i), uv.getY(i)) * scale)
          positions.set([p.x, p.y, p.z], 3 * i)
        }
        const index = Array.from(mesh.geometry.index!.array)
        const tris: number[] = []
        for (let k = 0; k < index.length; k += 3) {
          if (index[k] < surface && index[k + 1] < surface && index[k + 2] < surface) tris.push(index[k], index[k + 1], index[k + 2])
        }
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        geometry.setIndex(tris)
        const out = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }))
        out.updateMatrixWorld()
        return out
      })
      const [w] = a.tile.boundingVolume.region
      const [, s, e, n] = b.tile.boundingVolume.region
      let checked = 0
      for (let k = 0; k < 400; k++) {
        const lat = s + (n - s) * rand()
        const lon = w + (e - w) * rand()
        const dir = surfaceEcef(THREE.MathUtils.radToDeg(lat), THREE.MathUtils.radToDeg(lon), 0).normalize()
        raycaster.set(new THREE.Vector3(), dir)
        const hits = raycaster.intersectObjects(drawn)
        if (hits.length === 0) continue
        const height = Math.max(...hits.map((h) => h.distance)) - R
        // A point query, and windows reaching over the neighbour.
        for (const radius of [0.01, 300, 2500]) {
          const q = sampler.maxElevation(lat, lon, radius)!
          expect(q.metres * scale).toBeGreaterThanOrEqual(height - 1e-3)
        }
        checked++
      }
      expect(checked).toBeGreaterThan(300)
    }
  })

  it('takes the drawn tiles and the deepest loaded ones, not a cached parent', async () => {
    // A parent (z12) at 1000 m and one of its children (z13) at 300 m.
    const parent = await lib.tile(602, 1616, 12, () => 1000)
    const child = await lib.tile(1205, 3232, 13, () => 300)
    const [w, s, e, n] = child.tile.boundingVolume.region
    const [lat, lon] = [(s + n) / 2, (w + e) / 2]
    // Drawn parent, child loaded and about to fade in: both.
    expect(createSurfaceGround(tilesOf([parent], [child])).maxElevation(lat, lon, 50)).toEqual({ metres: 1000, covered: true })
    // The child drawn, the parent still cached: the child alone.
    expect(createSurfaceGround(tilesOf([child], [parent])).maxElevation(lat, lon, 50)).toEqual({ metres: 300, covered: true })
    // Looking away culls both from the drawn set: the deepest loaded still answers.
    expect(createSurfaceGround(tilesOf([], [parent, child])).maxElevation(lat, lon, 50)).toEqual({ metres: 300, covered: true })
    // A window off the child's edge, over ground only the undrawn parent holds: not covered.
    const edge = createSurfaceGround(tilesOf([], [parent, child])).maxElevation(lat, w, 5000)!
    expect(edge.metres).toBe(300)
    expect(edge.covered).toBe(false)
    // Nothing loaded there at all.
    expect(createSurfaceGround(tilesOf([], [child])).maxElevation(lat + 0.1, lon, 50)).toBeNull()
  })

  it('says where loaded tiles leave a gap in the window', async () => {
    const a = await lib.tile(1205, 3232, 13, () => 100)
    const c = await lib.tile(1207, 3232, 13, () => 100)
    const [w, s, e, n] = a.tile.boundingVolume.region
    const lat = (s + n) / 2
    // From 1205's east edge, over the missing 1206.
    const reachM = 0.4 * (e - w) * SURFACE_ELLIPSOID_RADIUS * Math.cos(lat)
    const lon = e
    expect(createSurfaceGround(tilesOf([a, c], [])).maxElevation(lat, lon, reachM)!.covered).toBe(false)
    const b = await lib.tile(1206, 3232, 13, () => 100)
    expect(createSurfaceGround(tilesOf([a, b, c], [])).maxElevation(lat, lon, reachM)!.covered).toBe(true)
  })

  it('covers by union, with the float edges of neighbours meeting', () => {
    const win = { south: 0, north: 1, west: 0, east: 1 }
    const cover = (rects: number[][]) => coversWindow(win, rects.flat())
    expect(cover([[-1, -1, 2, 2]])).toBe(true)
    expect(cover([[-1, -1, 0.5, 2], [0.5 + 5e-8, -1, 2, 2]])).toBe(true)
    expect(cover([[-1, -1, 0.5, 2], [0.5 + 1e-5, -1, 2, 2]])).toBe(false)
    expect(cover([[-1, -1, 2, 0.5], [-1, 0.5, 0.5, 2]])).toBe(false)
    expect(cover([])).toBe(false)
    // Only the first `count` rectangles count.
    expect(coversWindow(win, [-1, -1, 0.5, 2, 0.5, -1, 2, 2], 1)).toBe(false)
    // Many tiles: the point grid.
    const many: number[][] = []
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) many.push([i / 5, j / 5, (i + 1) / 5, (j + 1) / 5])
    expect(cover(many)).toBe(true)
    expect(cover(many.filter((_, k) => k !== 12))).toBe(false)
  })

  it("rebuilds a tile's heights when a neighbour is stitched into its grid's border", async () => {
    const t = await lib.tile(1205, 3232, 13, () => 100)
    const sampler = createSurfaceGround(tilesOf([t], []))
    const [, s, e, n] = t.tile.boundingVolume.region
    // At the east edge, whose vertices read into the border (a window past
    // ANTICIPATE_MAX_M: the vertex heights alone, which are cached).
    const at = () => sampler.maxElevation((s + n) / 2, e - 1e-9, 2 * ANTICIPATE_MAX_M)!.metres
    expect(at()).toBeCloseTo(100, 6)
    // GridCache.fillBorder: the neighbour's edge copied into the border column, then needsUpdate.
    const map = (t.mesh.material as THREE.MeshStandardMaterial).displacementMap!
    const { data, width, height } = map.image as { data: Float32Array; width: number; height: number }
    for (let y = 0; y < height; y++) data[y * width + width - 1] = 900
    expect(at()).toBeCloseTo(100, 6) // the source hasn't said it changed
    map.needsUpdate = true
    expect(at()).toBeGreaterThan(400)
  })

  it('reads tiles on either side of the antimeridian, whichever way float32 puts their edges', async () => {
    const level = 13
    const west = await lib.tile(0, 3232, level, () => 300)
    const east = await lib.tile(2 ** level - 1, 3232, level, () => 700)
    const [, s, , n] = west.tile.boundingVolume.region
    const lat = (s + n) / 2
    for (const lon of [-Math.PI + 1e-7, Math.PI - 1e-7]) {
      const q = createSurfaceGround(tilesOf([west, east], [])).maxElevation(lat, lon, 50)!
      expect(q).toEqual({ metres: 700, covered: true })
      // One side alone: its heights, and the window over the other side not covered.
      const one = createSurfaceGround(tilesOf([west], [])).maxElevation(lat, lon, 50)!
      expect(one).toEqual({ metres: 300, covered: false })
    }
    // Wholly inside one tile, a window by the edge reads that tile only.
    expect(createSurfaceGround(tilesOf([west, east], [])).maxElevation(lat, -Math.PI + 0.0005, 10)).toEqual({ metres: 300, covered: true })
  })

  it('takes the grid texels under a small window for a tile above the deepest level, which its children cannot exceed', async () => {
    // A one-texel spire between vertices: the tile's own mesh misses it.
    const spire = (i: number, j: number) => (i === 9 && j === 9 ? 2000 : 100)
    const t = await lib.tile(1205, 3232, 13, spire)
    const ground = buildTileGround(t.mesh)!
    expect(ground.max).toBeLessThan(2000)
    const [w, s, e, n] = t.tile.boundingVolume.region
    const sampler = createSurfaceGround(tilesOf([t], []))
    const ANY = 10_000 // a window over the whole tile (wider than ANTICIPATE_MAX_M: vertices only)
    expect(sampler.maxElevation((s + n) / 2, (w + e) / 2, ANY)!.metres).toBe(ground.max)
    // Small windows anywhere over the spire's texel take it.
    let saw = 0
    for (let k = 0; k <= 20; k++) {
      const q = sampler.maxElevation(s + ((n - s) * k) / 20, w + ((e - w) * k) / 20, ANTICIPATE_MAX_M)!
      if (q.metres === 2000) saw++
    }
    expect(saw).toBeGreaterThan(0)
    // At the deepest level nothing finer comes: the mesh alone.
    const deepest = createSurfaceGround(tilesOf([t], []), { deepest: 13 })
    for (let k = 0; k <= 20; k++) {
      expect(deepest.maxElevation(s + ((n - s) * k) / 20, w + ((e - w) * k) / 20, ANTICIPATE_MAX_M)!.metres).toBeLessThan(2000)
    }
  })

  it("anticipates up to the terrain tree's deepest level, a level past Mapterhorn's grids", () => {
    expect(SURFACE_TREE_DEEPEST).toBe(MAPTERHORN_MAX_ZOOM + 1)
  })

  it('clamps to the highest ground the tiles stand on (SURFACE_MAX_METRES)', async () => {
    const t = await lib.tile(1205, 3232, 13, () => 20000)
    const [w, s, e, n] = t.tile.boundingVolume.region
    expect(createSurfaceGround(tilesOf([t], [])).maxElevation((s + n) / 2, (w + e) / 2, 10)!.metres).toBe(SURFACE_MAX_METRES)
  })

  it('refreshes its tile list only when invalidated', async () => {
    const a = await lib.tile(1205, 3232, 13, () => 100)
    const b = await lib.tile(1205, 3232, 13, () => 700)
    const loaded = [a]
    const tiles: SurfaceGroundTiles = {
      group: new THREE.Group(),
      forEachLoadedModel: (callback) => loaded.forEach(({ mesh, tile }) => callback(mesh, tile)),
    }
    const sampler = createSurfaceGround(tiles)
    const [w, s, e, n] = a.tile.boundingVolume.region
    const at = () => sampler.maxElevation((s + n) / 2, (w + e) / 2, 10)!.metres
    expect(at()).toBe(100)
    loaded[0] = b
    expect(at()).toBe(100)
    sampler.invalidate()
    expect(at()).toBe(700)
  })

  it("reads a lat/lon back from a direction in Earth's frame as the tiles place it", () => {
    for (const [lat, lon] of [[36.1, -112.1], [27.99, 86.93], [-33.9, 151.2], [0, 179.9], [0, -179.9], [80, 0]]) {
      const local = ecefToEarthLocal(surfaceEcef(lat, lon, 0)).normalize()
      const [la, lo] = earthLatLon(local)
      expect(THREE.MathUtils.radToDeg(la)).toBeCloseTo(lat, 9)
      expect(THREE.MathUtils.radToDeg(lo)).toBeCloseTo(lon, 9)
    }
  })
})
