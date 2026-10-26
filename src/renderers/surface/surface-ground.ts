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
// their chords dip under the sphere), so the highest corner of every cell a
// window touches bounds the mesh across it, whichever way the cell is split.
// (Tighter, the triangles under the window alone, read lower over a coarse
// tile's kilometre cells, but a finer tile fading in then rises further past
// the clearance's give: headless arrival at the gorge snapped the ship 520 m
// against 0.2 m with the corners.)
//
// Not sampleCartographicElevation or the library's raycast: a point read of
// the finest grid (2.4-10 m texels) sits tens of metres under the mesh's
// triangles on canyon walls (8-16 texels to a segment), and the raycast
// takes the plugin's heightScale (the page's relief, not the live scale)
// and rebuilds a tile's vertices per ray.
//
// Each vertex's height is the GPU's read at its uv: bilinear on a linear-
// filtered grid, and on a nearest-filtered one (iOS, createSurfaceTiles) the
// highest of the 2 x 2 texels its uv falls between (a vertex lands on texel
// boundaries, where the GPU may pick either). Heights are true metres: the
// caller scales them. A tile's grid can change after it is read: the grid
// cache stitches a neighbour's edge into its border (GridCache.stitchNeighbors,
// needsUpdate on the shared source), which the edge vertices read, so a
// tile's heights are rebuilt when its grid's source version moves.
//
// Anticipating finer tiles: a tile above the tree's deepest level will be
// replaced by children whose finer meshes read the same grid (or a finer
// one), and stand higher than its own mesh on narrow ridges. For windows up
// to ANTICIPATE_MAX_M the floor also takes the highest grid texel under the
// window, which no finer mesh read from that grid can exceed: such
// a child fading in then no longer pushes the ship up past the clearance's
// give (a snap), the floor lowering smoothly once it has instead.
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
/** The widest window (metres) that also takes the grid's texels under it (see the header). */
export const ANTICIPATE_MAX_M = 50
/** The terrain tree's deepest level (createSurfaceTiles: Mapterhorn's z16 grids, a level past them). */
export const SURFACE_TREE_DEEPEST = 17
const NEAREST_FILTER = 1003 // THREE.NearestFilter

function wrapPi(a: number): number {
  return a - TWO_PI * Math.round(a / TWO_PI)
}

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
  /** The grid, and its source's version when read (stitching bumps it). */
  image: GridImage
  version: number
  /** Each column's and row's texture coordinate into the grid. */
  colU: Float64Array
  rowV: Float64Array
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

/** The highest of the 2 x 2 texels around texture coordinates: any nearest read there, on either side of a boundary. */
export function gridFootprintMax({ data, width, height }: GridImage, tu: number, tv: number): number {
  const x0 = Math.min(Math.max(Math.floor(tu * width - 0.5), 0), width - 1)
  const y0 = Math.min(Math.max(Math.floor(tv * height - 0.5), 0), height - 1)
  const x1 = Math.min(x0 + 1, width - 1)
  const y1 = Math.min(y0 + 1, height - 1)
  return Math.max(data[y0 * width + x0], data[y0 * width + x1], data[y1 * width + x0], data[y1 * width + x1])
}

/** The highest texel any read between texture coordinates [u0, u1] x [v0, v1] takes. */
function gridSpanMax({ data, width, height }: GridImage, u0: number, u1: number, v0: number, v1: number): number {
  const x0 = Math.min(Math.max(Math.floor(Math.min(u0, u1) * width - 0.5), 0), width - 1)
  const x1 = Math.min(Math.max(Math.floor(Math.max(u0, u1) * width - 0.5) + 1, 0), width - 1)
  const y0 = Math.min(Math.max(Math.floor(Math.min(v0, v1) * height - 0.5), 0), height - 1)
  const y1 = Math.min(Math.max(Math.floor(Math.max(v0, v1) * height - 0.5) + 1, 0), height - 1)
  let top = -Infinity
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) top = Math.max(top, data[y * width + x])
  return top
}

const sourceVersion = (map: THREE.Texture) => (map.source as { version?: number } | undefined)?.version ?? map.version

/** A tile scene's ground (see the header), or null when it carries no grid. */
export function buildTileGround(scene: THREE.Object3D): TileGround | null {
  const mesh = terrainMesh(scene)
  if (!mesh) return null
  const map = (mesh.material as THREE.MeshStandardMaterial).displacementMap!
  const image = map.image as GridImage
  const nearest = map.magFilter === NEAREST_FILTER
  const { position, uv } = mesh.geometry.attributes
  if (!position || !uv || position.count < TILE_VERTICES * TILE_VERTICES) return null
  const { x: ox, y: oy, z: oz } = mesh.position
  const count = TILE_VERTICES * TILE_VERTICES
  const heights = new Float32Array(count)
  let max = -Infinity
  for (let i = 0; i < count; i++) {
    const tu = uv.getX(i)
    const tv = uv.getY(i)
    const h = nearest ? gridFootprintMax(image, tu, tv) : gridLinear(image, tu, tv)
    heights[i] = h
    if (heights[i] > max) max = heights[i]
  }
  const rowLat = new Float64Array(TILE_VERTICES)
  const colLon = new Float64Array(TILE_VERTICES)
  const colU = new Float64Array(TILE_VERTICES)
  const rowV = new Float64Array(TILE_VERTICES)
  const mid = SEGMENTS / 2
  // Longitudes unwrapped around the middle column's, which never sits on
  // the antimeridian (tiles' edges do: float32 can put an edge at either +pi
  // or -pi).
  const midLon = Math.atan2(position.getY(mid * TILE_VERTICES + mid) + oy, position.getX(mid * TILE_VERTICES + mid) + ox)
  for (let k = 0; k < TILE_VERTICES; k++) {
    // A row shares its latitude and v, a column its longitude and u.
    const r = k * TILE_VERTICES + mid
    const x = position.getX(r) + ox
    const y = position.getY(r) + oy
    const z = position.getZ(r) + oz
    rowLat[k] = Math.atan2(z, Math.hypot(x, y))
    rowV[k] = uv.getY(r)
    const c = mid * TILE_VERTICES + k
    colLon[k] = midLon + wrapPi(Math.atan2(position.getY(c) + oy, position.getX(c) + ox) - midLon)
    colU[k] = uv.getX(c)
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
  return { rowLat, colLon, heights, blocks, max, image, version: sourceVersion(map), colU, rowV }
}

/** Whether `scene`'s grid has changed since `ground` read it (stitching). */
function stale(ground: TileGround, scene: THREE.Object3D): boolean {
  const map = (terrainMesh(scene)?.material as THREE.MeshStandardMaterial | undefined)?.displacementMap
  return !map || sourceVersion(map) !== ground.version
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

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * The highest corner of `ground`'s cells that meet `win` (its longitudes
 * plus `shift`; blocks of cells inside it by the block maxima), which bounds
 * the mesh there whichever way the cells are split. With `anticipate`, also
 * the highest grid texel under the window (see the header). -Infinity when
 * no cell meets it.
 */
export function tileGroundMax(ground: TileGround, win: Window, shift = 0, anticipate = false): number {
  const [r0, r1] = vertexRange(ground.rowLat, 0, win.south, win.north, _rows)
  if (r0 > r1) return -Infinity
  const [c0, c1] = vertexRange(ground.colLon, shift, win.west, win.east, _cols)
  if (c0 > c1) return -Infinity
  if (r0 === 0 && c0 === 0 && r1 === SEGMENTS && c1 === SEGMENTS && !anticipate) {
    // The window may still cut the edge cells; their corners bound them.
    const { rowLat, colLon } = ground
    const inside =
      Math.min(rowLat[0], rowLat[SEGMENTS]) >= win.south &&
      Math.max(rowLat[0], rowLat[SEGMENTS]) <= win.north &&
      colLon[0] + shift >= win.west &&
      colLon[SEGMENTS] + shift <= win.east
    if (inside) return ground.max
  }
  const { heights, blocks, rowLat, colLon, image, colU, rowV } = ground
  let top = -Infinity
  const rowIn = (r: number) => Math.min(rowLat[r], rowLat[r + 1]) >= win.south && Math.max(rowLat[r], rowLat[r + 1]) <= win.north
  const colIn = (c: number) => colLon[c] + shift >= win.west && colLon[c + 1] + shift <= win.east
  for (let bi = Math.floor(r0 / BLOCK); bi < BLOCKS && bi * BLOCK < r1; bi++) {
    const br0 = Math.max(r0, bi * BLOCK)
    const br1 = Math.min(r1, (bi + 1) * BLOCK) // cells br0 .. br1 - 1
    for (let bj = Math.floor(c0 / BLOCK); bj < BLOCKS && bj * BLOCK < c1; bj++) {
      const bc0 = Math.max(c0, bj * BLOCK)
      const bc1 = Math.min(c1, (bj + 1) * BLOCK)
      // A whole block inside the window: its maximum.
      if (
        !anticipate &&
        br0 === bi * BLOCK &&
        br1 === (bi + 1) * BLOCK &&
        bc0 === bj * BLOCK &&
        bc1 === (bj + 1) * BLOCK &&
        rowIn(br0) &&
        rowIn(br1 - 1) &&
        colIn(bc0) &&
        colIn(bc1 - 1)
      ) {
        top = Math.max(top, blocks[bi * BLOCKS + bj])
        continue
      }
      for (let r = br0; r < br1; r++) {
        const ya = clamp01((win.south - rowLat[r]) / (rowLat[r + 1] - rowLat[r]))
        const yb = clamp01((win.north - rowLat[r]) / (rowLat[r + 1] - rowLat[r]))
        const y0 = Math.min(ya, yb)
        const y1 = Math.max(ya, yb)
        for (let c = bc0; c < bc1; c++) {
          const span = colLon[c + 1] - colLon[c]
          const x0 = clamp01((win.west - (colLon[c] + shift)) / span)
          const x1 = clamp01((win.east - (colLon[c] + shift)) / span)
          const h00 = heights[r * TILE_VERTICES + c]
          const h01 = heights[r * TILE_VERTICES + c + 1]
          const h10 = heights[(r + 1) * TILE_VERTICES + c]
          const h11 = heights[(r + 1) * TILE_VERTICES + c + 1]
          top = Math.max(top, h00, h01, h10, h11)
          if (anticipate) {
            const du = colU[c + 1] - colU[c]
            const dv = rowV[r + 1] - rowV[r]
            top = Math.max(top, gridSpanMax(image, colU[c] + x0 * du, colU[c] + x1 * du, rowV[r] + y0 * dv, rowV[r] + y1 * dv))
          }
        }
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


// Scratch for coversWindow's exact pass.
const xs: number[] = []
const ys: number[] = []

/**
 * Whether the first `count` rectangles of `rects` (flat: west, south, east,
 * north each) cover `win` whole.
 */
export function coversWindow(win: Window, rects: ArrayLike<number>, count = rects.length / 4): boolean {
  if (count === 0) return false
  for (let k = 0; k < count; k++) {
    if (
      rects[4 * k] - EDGE_EPS <= win.west &&
      rects[4 * k + 2] + EDGE_EPS >= win.east &&
      rects[4 * k + 1] - EDGE_EPS <= win.south &&
      rects[4 * k + 3] + EDGE_EPS >= win.north
    )
      return true
  }
  const inside = (x: number, y: number) => {
    for (let k = 0; k < count; k++) {
      if (
        x >= rects[4 * k] - EDGE_EPS &&
        x <= rects[4 * k + 2] + EDGE_EPS &&
        y >= rects[4 * k + 1] - EDGE_EPS &&
        y <= rects[4 * k + 3] + EDGE_EPS
      )
        return true
    }
    return false
  }
  if (count > EXACT_COVER_MAX) {
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
  xs.length = 0
  ys.length = 0
  xs.push(win.west, win.east)
  ys.push(win.south, win.north)
  for (let k = 0; k < count; k++) {
    xs.push(clip(rects[4 * k] - EDGE_EPS, win.west, win.east), clip(rects[4 * k + 2] + EDGE_EPS, win.west, win.east))
    ys.push(clip(rects[4 * k + 1] - EDGE_EPS, win.south, win.north), clip(rects[4 * k + 3] + EDGE_EPS, win.south, win.north))
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

export interface SurfaceGroundOptions {
  /** The tree's deepest level: tiles above it anticipate their children (see the header). */
  deepest?: number
}

/**
 * The sampler over `tiles` (see the header). SurfaceTiles registers it
 * (../../surface-ground.ts) and calls invalidate() after every update.
 */
export function createSurfaceGround(tiles: SurfaceGroundTiles, { deepest = SURFACE_TREE_DEEPEST }: SurfaceGroundOptions = {}): SurfaceGround {
  // A reloaded tile is a new scene; a stitched grid bumps its version (stale()).
  const grounds = new WeakMap<THREE.Object3D, TileGround | null>()
  // One frame's candidates, pooled: `count` of them are live.
  const pool: Candidate[] = []
  let count = 0
  let fresh = false
  const drawnSet = new Set<THREE.Object3D>()
  const hit: Candidate[] = []
  const rects: number[] = []
  const win: Window = { south: 0, north: 0, west: 0, east: 0 }

  const groundOf = (scene: THREE.Object3D) => {
    let ground = grounds.get(scene)
    if (ground === undefined || (ground && stale(ground, scene))) {
      ground = buildTileGround(scene)
      grounds.set(scene, ground)
    }
    return ground
  }

  const add = (scene: THREE.Object3D, tile: unknown) => {
    const region = tileRegion(tile)
    if (!scene || !region) return
    const [west, south, east, north] = region
    const span = east - west
    if (!(span > 0)) return
    const c = (pool[count] ??= { scene, drawn: false, level: 0, west: 0, south: 0, east: 0, north: 0 })
    count++
    c.scene = scene
    c.drawn = drawnSet.has(scene)
    c.level = Math.round(Math.log2(TWO_PI / span))
    c.west = west
    c.south = south
    c.east = east
    c.north = north
  }

  const collect = () => {
    drawnSet.clear()
    for (const child of tiles.group.children) drawnSet.add(child)
    count = 0
    tiles.forEachLoadedModel(add)
    // Let go of scenes a shrunken list no longer holds.
    for (let k = count; k < pool.length && pool[k].scene; k++) pool[k].scene = null as unknown as THREE.Object3D
    fresh = true
  }

  return {
    invalidate() {
      fresh = false
    },
    maxElevation(lat, lon, radiusM): SurfaceGroundQuery | null {
      if (!fresh) collect()
      const reach = Math.max(0, radiusM) / SURFACE_ELLIPSOID_RADIUS
      win.south = lat - reach
      win.north = lat + reach
      const poleward = Math.abs(lat) + reach
      const lonReach = poleward >= Math.PI / 2 - 1e-6 ? Math.PI : Math.min(Math.PI, reach / Math.cos(poleward))
      win.west = lon - lonReach
      win.east = lon + lonReach
      const anticipating = radiusM <= ANTICIPATE_MAX_M
      // The tiles the window's box meets, and the deepest level among them.
      hit.length = 0
      let level = -Infinity
      for (let k = 0; k < count; k++) {
        const c = pool[k]
        if (c.south > win.north || c.north < win.south) continue
        // The tile's longitudes moved by whole turns to the window's.
        const mid = (c.west + c.east) / 2
        const shift = lon - wrapPi(lon - mid) - mid
        if (c.west + shift > win.east || c.east + shift < win.west) continue
        hit.push(c)
        if (c.level > level) level = c.level
      }
      let metres = -Infinity
      rects.length = 0
      for (const c of hit) {
        if (!c.drawn && c.level !== level) continue
        const ground = groundOf(c.scene)
        if (!ground) continue
        // Shifted by the tile's own unwrapped longitudes.
        const first = ground.colLon[0]
        const last = ground.colLon[SEGMENTS]
        const mid = (first + last) / 2
        const shift = lon - wrapPi(lon - mid) - mid
        const top = tileGroundMax(ground, win, shift, anticipating && c.level < deepest)
        // A tile that adds no cell covers nothing: the globe stays in the floor there.
        if (!(top > -Infinity)) continue
        metres = Math.max(metres, top)
        const r0 = ground.rowLat[0]
        const r1 = ground.rowLat[SEGMENTS]
        rects.push(first + shift, Math.min(r0, r1), last + shift, Math.max(r0, r1))
      }
      if (rects.length === 0) return null
      return { metres: Math.min(metres, SURFACE_MAX_METRES), covered: coversWindow(win, rects, rects.length / 4) }
    },
  }
}
