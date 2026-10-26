import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { TilesRenderer } from '3d-tiles-renderer/three'
import { TerrariumMeshPlugin } from '3d-tiles-renderer/three/plugins'
import { SURFACE_MAX_METRES } from '../../terrain-scale'
import { earthLatLon } from '../../surface-ground'
import {
  TILE_VERTICES,
  buildTileGround,
  coversWindow,
  createSurfaceGround,
  gridLinear,
  gridNearest,
  type SurfaceGroundTiles,
} from './surface-ground'
import { SURFACE_ELLIPSOID_RADIUS, ecefToEarthLocal, surfaceEcef } from './surface-frame'

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
  tile(x: number, y: number, level: number, height: (i: number, j: number) => number): Promise<LibraryTile>
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
    async tile(x, y, level, height) {
      const data = new Float32Array(PADDED * PADDED)
      for (let j = 0; j < PADDED; j++) for (let i = 0; i < PADDED; i++) data[j * PADDED + i] = height(i, j)
      const grid = new THREE.DataTexture(data, PADDED, PADDED, THREE.RedFormat, THREE.FloatType)
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

  it('reads each vertex as the higher of the linear and nearest reads at its uv, and places its rows and columns', async () => {
    const rand = random(7)
    const { tile, mesh } = await lib.tile(1205, 3232, 13, () => 3000 * rand())
    const ground = buildTileGround(mesh)!
    const image = (mesh.material as THREE.MeshStandardMaterial).displacementMap!.image as {
      data: Float32Array
      width: number
      height: number
    }
    const { uv } = mesh.geometry.attributes
    for (let i = 0; i < TILE_VERTICES * TILE_VERTICES; i++) {
      const [tu, tv] = [uv.getX(i), uv.getY(i)]
      expect(ground.heights[i]).toBeCloseTo(Math.max(gridLinear(image, tu, tv), gridNearest(image, tu, tv)), 3)
      expect(ground.heights[i]).toBeGreaterThanOrEqual(gridLinear(image, tu, tv) - 1e-3)
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
    expect(coversWindow(win, [[-1, -1, 2, 2]])).toBe(true)
    expect(coversWindow(win, [[-1, -1, 0.5, 2], [0.5 + 5e-8, -1, 2, 2]])).toBe(true)
    expect(coversWindow(win, [[-1, -1, 0.5, 2], [0.5 + 1e-5, -1, 2, 2]])).toBe(false)
    expect(coversWindow(win, [[-1, -1, 2, 0.5], [-1, 0.5, 0.5, 2]])).toBe(false)
    expect(coversWindow(win, [])).toBe(false)
    // Many tiles: the point grid.
    const many: [number, number, number, number][] = []
    for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) many.push([i / 5, j / 5, (i + 1) / 5, (j + 1) / 5])
    expect(coversWindow(win, many)).toBe(true)
    expect(coversWindow(win, many.filter((_, k) => k !== 12))).toBe(false)
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
