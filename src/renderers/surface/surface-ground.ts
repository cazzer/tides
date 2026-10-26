// The ship's floor over the streamed tiles (tides-zmw.9.8): how high the
// drawn tile mesh stands across a window around a point, read on the CPU
// from what the GPU draws, so the ship can fly true-scale low over the
// tiles without ever putting its eye or near plane under them.
//
// What the GPU draws (3d-tiles-renderer 0.5.3's terrain plugin, pinned in
// terrain-internals.test.ts): each tile is a 33 x 33 grid of vertices on the
// sphere (ECEF metres, relative to the mesh's position), each displaced
// along the sphere's normal by its elevation grid (material.displacementMap,
// metres; its image keeps the Float32Array) read at the vertex's uv, times
// the live terrain scale (surface-scale.ts). Between vertices the mesh is
// flat triangles, which stand no higher than the cell's highest corner (and
// their chords dip under the sphere), so the highest vertex of every cell a
// window touches bounds the mesh across it, whichever way the cell is split.
//
// Not sampleCartographicElevation or the library's raycast: a point read of
// the finest grid (2.4-10 m texels) sits tens of metres under the mesh's
// triangles on canyon walls (8-16 texels to a segment), and the raycast
// takes the plugin's heightScale (the page's relief, not the live scale)
// and rebuilds a tile's vertices per ray.
//
// Each vertex's height is max(bilinear, nearest texel) at its uv, so it
// holds whether the grid is linear- or nearest-filtered (iOS,
// createSurfaceTiles). Heights are true metres: the caller scales them.
//
// Which tiles count: those drawn (the group's children: visible, and fading
// out, which the fade plugin keeps until it ends) and the loaded ones at the
// deepest level present in the window, which may fade in at any frame.
// Coarser tiles that are loaded but not drawn are left out: a cached parent
// would hold the floor at mid-wall height over the gorge its children draw.
// The deepest loaded set doesn't depend on where the camera looks, so
// looking away (which culls the tiles under the ship from the drawn set)
// doesn't move the floor.

import type * as THREE from 'three'
import type { SurfaceGroundQuery, SurfaceGroundSampler } from '../../surface-ground'
import { SURFACE_MAX_METRES } from '../../terrain-scale'
import { SURFACE_ELLIPSOID_RADIUS } from './surface-frame'

/** Vertices to a tile's side (the library's MESH_SIZE 32, plus one). */
export const TILE_VERTICES = 33
const SEGMENTS = TILE_VERTICES - 1
/** Cells to a block side, for the block maxima wide windows read. */
const BLOCK = 8
const BLOCKS = SEGMENTS / BLOCK
const TWO_PI = 2 * Math.PI
/** Radians tiles are widened by for coverage: neighbours' float32 edges don't quite meet. */
const EDGE_EPS = 1e-7
/** Above this many tiles in a window, coverage is checked on a grid of points. */
const EXACT_COVER_MAX = 16
const COVER_GRID = 16

/** A tile mesh's vertex heights and where they stand. */
export interface TileGround {
  /** Each vertex row's latitude, radians, as the library orders them. */
  rowLat: Float64Array
  /** Each vertex column's longitude, radians, increasing (unwrapped). */
  colLon: Float64Array
  /** Each vertex's height, true metres, row-major as the geometry. */
  heights: Float32Array
  /** The highest vertex in each BLOCK x BLOCK block of cells, row-major. */
  blocks: Float32Array
  max: number
}

/** The mesh in a tile's scene carrying the elevation grid. */
function terrainMesh(scene: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null
  scene.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (found || !mesh.isMesh) return
    const map = (mesh.material as THREE.MeshStandardMaterial | undefined)?.displacementMap
    if ((map?.image as { data?: unknown } | undefined)?.data) found = mesh
  })
  return found
}

interface GridImage {
  data: ArrayLike<number>
  width: number
  height: number
}

/** The GPU's linear read of a padded grid at texture coordinates (the library's sampleGrid). */
export function gridLinear({ data, width, height }: GridImage, tu: number, tv: number): number {
  const fx = Math.min(Math.max(tu * width - 0.5, 0), width - 1)
  const fy = Math.min(Math.max(tv * height - 0.5, 0), height - 1)
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(x0 + 1, width - 1)
  const y1 = Math.min(y0 + 1, height - 1)
  const tx = fx - x0
  const ty = fy - y0
  const h0 = data[y0 * width + x0] * (1 - tx) + data[y0 * width + x1] * tx
  const h1 = data[y1 * width + x0] * (1 - tx) + data[y1 * width + x1] * tx
  return h0 * (1 - ty) + h1 * ty
}

/** The GPU's nearest read of a grid at texture coordinates (clamped to the edge). */
export function gridNearest({ data, width, height }: GridImage, tu: number, tv: number): number {
  const x = Math.min(Math.max(Math.floor(tu * width), 0), width - 1)
  const y = Math.min(Math.max(Math.floor(tv * height), 0), height - 1)
  return data[y * width + x]
}

/** A tile scene's ground (see the header), or null when it carries no grid. */
export function buildTileGround(scene: THREE.Object3D): TileGround | null {
  const mesh = terrainMesh(scene)
  if (!mesh) return null
  const image = (mesh.material as THREE.MeshStandardMaterial).displacementMap!.image as GridImage
  const { position, uv } = mesh.geometry.attributes
  if (!position || !uv || position.count < TILE_VERTICES * TILE_VERTICES) return null
  const { x: ox, y: oy, z: oz } = mesh.position
  const count = TILE_VERTICES * TILE_VERTICES
  const heights = new Float32Array(count)
  let max = -Infinity
  for (let i = 0; i < count; i++) {
    const tu = uv.getX(i)
    const tv = uv.getY(i)
    const h = Math.max(gridLinear(image, tu, tv), gridNearest(image, tu, tv))
    heights[i] = h
    if (h > max) max = h
  }
  const rowLat = new Float64Array(TILE_VERTICES)
  const colLon = new Float64Array(TILE_VERTICES)
  const mid = SEGMENTS / 2
  for (let k = 0; k < TILE_VERTICES; k++) {
    // A row shares its latitude, a column its longitude.
    const r = k * TILE_VERTICES + mid
    const x = position.getX(r) + ox
    const y = position.getY(r) + oy
    const z = position.getZ(r) + oz
    rowLat[k] = Math.atan2(z, Math.hypot(x, y))
    const c = mid * TILE_VERTICES + k
    colLon[k] = Math.atan2(position.getY(c) + oy, position.getX(c) + ox)
    // Unwrapped across the antimeridian.
    while (k > 0 && colLon[k] < colLon[k - 1] - Math.PI) colLon[k] += TWO_PI
  }
  const blocks = new Float32Array(BLOCKS * BLOCKS)
  for (let bi = 0; bi < BLOCKS; bi++) {
    for (let bj = 0; bj < BLOCKS; bj++) {
      let top = -Infinity
      for (let r = bi * BLOCK; r <= (bi + 1) * BLOCK; r++) {
        for (let c = bj * BLOCK; c <= (bj + 1) * BLOCK; c++) top = Math.max(top, heights[r * TILE_VERTICES + c])
      }
      blocks[bi * BLOCKS + bj] = top
    }
  }
  return { rowLat, colLon, heights, blocks, max }
}

/** The window a query reads, latitude and (unwrapped) longitude, radians. */
interface Window {
  south: number
  north: number
  west: number
  east: number
}

// The vertex range [first, last] of the cells whose span [a[k], a[k + 1]]
// (either order) meets [lo, hi]; first > last when none does.
function vertexRange(a: Float64Array, shift: number, lo: number, hi: number, out: [number, number]): [number, number] {
  let first = TILE_VERTICES
  let last = -1
  for (let k = 0; k < SEGMENTS; k++) {
    const p = a[k] + shift
    const q = a[k + 1] + shift
    if (Math.min(p, q) <= hi && Math.max(p, q) >= lo) {
      if (k < first) first = k
      last = k + 1
    }
  }
  out[0] = first
  out[1] = last
  return out
}

const _rows: [number, number] = [0, 0]
const _cols: [number, number] = [0, 0]

/**
 * The highest vertex of `ground`'s cells that meet `win`, whose longitudes
 * are `ground`'s plus `shift`; -Infinity when none does.
 */
export function tileGroundMax(ground: TileGround, win: Window, shift = 0): number {
  const [r0, r1] = vertexRange(ground.rowLat, 0, win.south, win.north, _rows)
  if (r0 > r1) return -Infinity
  const [c0, c1] = vertexRange(ground.colLon, shift, win.west, win.east, _cols)
  if (c0 > c1) return -Infinity
  if (r0 === 0 && c0 === 0 && r1 === SEGMENTS && c1 === SEGMENTS) return ground.max
  const { heights, blocks } = ground
  let top = -Infinity
  for (let bi = Math.floor(r0 / BLOCK); bi < BLOCKS && bi * BLOCK <= r1; bi++) {
    const br0 = Math.max(r0, bi * BLOCK)
    const br1 = Math.min(r1, (bi + 1) * BLOCK)
    for (let bj = Math.floor(c0 / BLOCK); bj < BLOCKS && bj * BLOCK <= c1; bj++) {
      const bc0 = Math.max(c0, bj * BLOCK)
      const bc1 = Math.min(c1, (bj + 1) * BLOCK)
      if (br0 === bi * BLOCK && br1 === (bi + 1) * BLOCK && bc0 === bj * BLOCK && bc1 === (bj + 1) * BLOCK) {
        top = Math.max(top, blocks[bi * BLOCKS + bj])
        continue
      }
      for (let r = br0; r <= br1; r++) {
        for (let c = bc0; c <= bc1; c++) top = Math.max(top, heights[r * TILE_VERTICES + c])
      }
    }
  }
  return top
}

/** A loaded tile, as one frame's candidate list holds it. */
interface Candidate {
  scene: THREE.Object3D
  drawn: boolean
  level: number
  /** From its bounding region, radians: west, south, east, north. */
  west: number
  south: number
  east: number
  north: number
}

/** The tile-renderer surface the sampler reads. */
export interface SurfaceGroundTiles {
  group: THREE.Object3D
  forEachLoadedModel(callback: (scene: THREE.Object3D, tile: unknown) => void): void
}

export interface SurfaceGround extends SurfaceGroundSampler {
  /** After each tiles.update(): the drawn and loaded sets may have changed. */
  invalidate(): void
}

const wrapPi = (a: number) => a - TWO_PI * Math.round(a / TWO_PI)

/** Whether `rects` (each [west, south, east, north]) cover `win` whole. */
export function coversWindow(win: Window, rects: readonly (readonly [number, number, number, number])[]): boolean {
  if (rects.length === 0) return false
  for (const [w, s, e, n] of rects) {
    if (w - EDGE_EPS <= win.west && e + EDGE_EPS >= win.east && s - EDGE_EPS <= win.south && n + EDGE_EPS >= win.north) return true
  }
  const inside = (x: number, y: number) =>
    rects.some(([w, s, e, n]) => x >= w - EDGE_EPS && x <= e + EDGE_EPS && y >= s - EDGE_EPS && y <= n + EDGE_EPS)
  if (rects.length > EXACT_COVER_MAX) {
    for (let i = 0; i <= COVER_GRID; i++) {
      for (let j = 0; j <= COVER_GRID; j++) {
        const x = win.west + ((win.east - win.west) * i) / COVER_GRID
        const y = win.south + ((win.north - win.south) * j) / COVER_GRID
        if (!inside(x, y)) return false
      }
    }
    return true
  }
  // Exact: every cell of the grid the rectangles' edges cut the window into.
  const clip = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
  const xs = [win.west, win.east]
  const ys = [win.south, win.north]
  for (const [w, s, e, n] of rects) {
    xs.push(clip(w - EDGE_EPS, win.west, win.east), clip(e + EDGE_EPS, win.west, win.east))
    ys.push(clip(s - EDGE_EPS, win.south, win.north), clip(n + EDGE_EPS, win.south, win.north))
  }
  xs.sort((a, b) => a - b)
  ys.sort((a, b) => a - b)
  for (let i = 0; i + 1 < xs.length; i++) {
    if (xs[i + 1] - xs[i] <= 0) continue
    const x = (xs[i] + xs[i + 1]) / 2
    for (let j = 0; j + 1 < ys.length; j++) {
      if (ys[j + 1] - ys[j] <= 0) continue
      if (!inside(x, (ys[j] + ys[j + 1]) / 2)) return false
    }
  }
  return true
}

/** The bounding region a loaded tile carries: [west, south, east, north, min, max], radians. */
function tileRegion(tile: unknown): readonly number[] | null {
  const region = (tile as { boundingVolume?: { region?: readonly number[] } } | null)?.boundingVolume?.region
  return region && region.length >= 4 ? region : null
}

/**
 * The sampler over `tiles` (see the header). SurfaceTiles registers it
 * (../../surface-ground.ts) and calls invalidate() after every update.
 */
export function createSurfaceGround(tiles: SurfaceGroundTiles): SurfaceGround {
  // Tile content never changes once parsed; a reloaded tile is a new scene.
  const grounds = new WeakMap<THREE.Object3D, TileGround | null>()
  let candidates: Candidate[] | null = null
  const hit: Candidate[] = []
  const shifts: number[] = []
  const rects: [number, number, number, number][] = []
  const win: Window = { south: 0, north: 0, west: 0, east: 0 }

  const groundOf = (scene: THREE.Object3D) => {
    let ground = grounds.get(scene)
    if (ground === undefined) {
      ground = buildTileGround(scene)
      grounds.set(scene, ground)
    }
    return ground
  }

  const collect = (): Candidate[] => {
    const drawn = new Set(tiles.group.children)
    const list: Candidate[] = []
    tiles.forEachLoadedModel((scene, tile) => {
      const region = tileRegion(tile)
      if (!scene || !region) return
      const [west, south, east, north] = region
      const span = east - west
      if (!(span > 0)) return
      list.push({ scene, drawn: drawn.has(scene), level: Math.round(Math.log2(TWO_PI / span)), west, south, east, north })
    })
    return list
  }

  return {
    invalidate() {
      candidates = null
    },
    maxElevation(lat, lon, radiusM): SurfaceGroundQuery | null {
      candidates ??= collect()
      const reach = Math.max(0, radiusM) / SURFACE_ELLIPSOID_RADIUS
      win.south = lat - reach
      win.north = lat + reach
      const poleward = Math.abs(lat) + reach
      const lonReach = poleward >= Math.PI / 2 - 1e-6 ? Math.PI : Math.min(Math.PI, reach / Math.cos(poleward))
      win.west = lon - lonReach
      win.east = lon + lonReach
      // The tiles the window's box meets, and the deepest level among them.
      hit.length = 0
      shifts.length = 0
      let deepest = -Infinity
      for (const c of candidates) {
        if (c.south > win.north || c.north < win.south) continue
        // The tile's longitudes moved by whole turns to the window's.
        const shift = lon - wrapPi(lon - (c.west + c.east) / 2) - (c.west + c.east) / 2
        if (c.west + shift > win.east || c.east + shift < win.west) continue
        hit.push(c)
        shifts.push(shift)
        if (c.level > deepest) deepest = c.level
      }
      let metres = -Infinity
      rects.length = 0
      for (let k = 0; k < hit.length; k++) {
        const c = hit[k]
        if (!c.drawn && c.level !== deepest) continue
        const ground = groundOf(c.scene)
        if (!ground) continue
        metres = Math.max(metres, tileGroundMax(ground, win, shifts[k]))
        rects.push([c.west + shifts[k], c.south, c.east + shifts[k], c.north])
      }
      // (No cell at all: boxes that met the window only at an edge.)
      if (rects.length === 0 || !(metres > -Infinity)) return null
      return { metres: Math.min(metres, SURFACE_MAX_METRES), covered: coversWindow(win, rects) }
    },
  }
}
