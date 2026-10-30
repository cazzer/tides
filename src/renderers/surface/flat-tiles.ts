// Open-water tiles drawn with fewer, larger triangles (tides-zmw.9.33).
//
// At sea the tiles' water cost 1.5-2.1 ms more than the globe's (GPU timer
// queries, 960x600, ship at 20N 150W, 5 km and 300 m). Not overdraw:
// removing the dissolve's discard, or hiding the globe under the tiles,
// changed nothing. The same water GLSL costs ~0.15-0.2 ms on the globe and
// ~1.5 ms on the tiles, which draw ~100 tiles of 2304 triangles each (the
// library's 32x32 SkirtedPlaneGeometry and its skirts) over ~300k water
// pixels: 1-2 pixels a triangle, where the GPU shades whole 2x2 quads along
// every triangle's edges, so much of the water's expensive fragment shader
// ran for pixels it then threw away. The same vertices drawn through a
// coarser index cut the tiles' water to ~0.5 ms and the frame by ~2 ms.
//
// A tile flat at sea level is the only one that can take it: the library
// places every vertex on the ellipsoid at height 0 and the GPU displaces it
// by the grid, which over open water is 0 m throughout (Mapterhorn's sea is
// exactly 0, and SurfaceGridCache makes an ocean grid flat sea level). So a
// tile whose measured range (the grid at every surface vertex,
// tileHeightRange, terrain-internals.ts) is exactly { 0, 0 } is a piece of
// the ellipsoid, and a coarser triangulation of it is the same surface but
// for its chords' sag. Each side gets the fewest segments (a power of two
// dividing the library's 32) that keep the longest of the tile's four
// surface edges at FLAT_TILE_CHORD_METRES a segment or less: a 4 km edge
// sags 4000^2 / (8 R) ~ 0.31 m under the ellipsoid, and a cell's 5.7 km
// diagonal ~0.63 m at its middle, no more than the library's own 32
// segments sag on a z8 tile (~4.6 km segments: 0.4 m, 0.83 m), so no flat
// tile draws further from the sea surface than the library's own tiles
// already do. A tile that would need all 32 is left alone.
//
// Unaffected: land, and any tile with any vertex off 0 m (coasts, islands,
// lakes, the Dead Sea), which keep the library's mesh; the water's bump and
// glint, which read the grid per fragment; the vertices themselves (only
// the index changes, before anything uploads the geometry: processTileModel
// runs at parse, before the first draw), so the ship's floor, which reads
// vertex heights from the position and uv attributes and never the index
// (surface-ground.ts buildTileGround), is as it was, at 0 m, the drawn
// surface at most ~0.63 m under it. An index keys no program (tileProbe.ts's
// warm-up is the same). What the tile's features shade per vertex (the
// terrain shadow's horizon, tile-shadow.ts; the clouds' light,
// tile-clouds.ts vSurfaceCloudLit) is interpolated across up to 4 km
// instead: both budget for fields of 39 km or more, so widening
// FLAT_TILE_CHORD_METRES means checking them. The skirt triangles are kept
// as the library made them: they hang from every one of the fine perimeter
// vertices, and close the sub-metre crack where a coarse edge meets a finer
// neighbour's.
//
// Stitching (review): a land neighbour that loads after the tile writes its
// edge texels into the tile's grid border, which raises the fine vertices
// along that edge (and, on a tile finer than its grid, rows further in)
// after the range was measured. The coarse surface would skip them and the
// skirts, a flat tile's only geometricError deep, wouldn't close the step.
// So each coarse tile watches its grid's source version (the stitch's
// needsUpdate moves it) as it draws, and when it moves, looks at the grid
// under every surface vertex again: off 0 anywhere, the library's index goes
// back. The index is rewritten in place, its draw range cut to the coarse
// part, never swapped for another BufferAttribute: three frees only a
// geometry's current index, and can't resize one.
import * as THREE from 'three'
import { SkirtedPlaneGeometry } from '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/SkirtedPlaneGeometry.js'
import { TILE_VERTICES } from './surface-ground'
import { tileHeightRange } from './terrain-internals'

/** The longest a flat tile's coarse surface segment may be, metres (the sag bound above). */
export const FLAT_TILE_CHORD_METRES = 4000

/** The library's surface segments a side (MESH_SIZE, pinned by terrain-internals.test.ts). */
const SEGMENTS = TILE_VERTICES - 1
/** Index entries of the library's surface triangles, laid out before the skirts' (SkirtedPlaneGeometry). */
const SURFACE_INDICES = 6 * SEGMENTS * SEGMENTS
/** The skirts' index entries: a quad on each perimeter edge. */
const SKIRT_INDICES = 6 * 4 * SEGMENTS

const corner = new THREE.Vector3()
const other = new THREE.Vector3()

/**
 * The surface segments a side a flat tile needs (see the header): 1, 2, 4,
 * ... 32, from the longest corner-to-corner edge of its surface, in the
 * position attribute's metres (the tile's local frame is ECEF).
 */
export function flatTileSegments(position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): number {
  const corners = [0, SEGMENTS, TILE_VERTICES * TILE_VERTICES - 1, SEGMENTS * TILE_VERTICES]
  let longest = 0
  for (let i = 0; i < 4; i++) {
    corner.fromBufferAttribute(position, corners[i])
    other.fromBufferAttribute(position, corners[(i + 1) % 4])
    longest = Math.max(longest, corner.distanceTo(other))
  }
  let n = 1
  while (n < SEGMENTS && longest / n > FLAT_TILE_CHORD_METRES) n *= 2
  return n
}

/**
 * The library's index with its surface triangles redrawn at `n` segments a
 * side over the same vertex grid (every (32 / n)th vertex, in the
 * library's winding: per cell (a, b, d), (b, c, d)), its skirt triangles
 * after them as they were. At n = 32, the library's own.
 */
export function coarseTileIndex(index: Uint32Array, n: number): Uint32Array {
  const step = SEGMENTS / n
  const coarse = new Uint32Array(6 * n * n + (index.length - SURFACE_INDICES))
  let offset = 0
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const a = y * step * TILE_VERTICES + x * step
      const b = (y + 1) * step * TILE_VERTICES + x * step
      const c = (y + 1) * step * TILE_VERTICES + (x + 1) * step
      const d = y * step * TILE_VERTICES + (x + 1) * step
      coarse[offset++] = a
      coarse[offset++] = b
      coarse[offset++] = d
      coarse[offset++] = b
      coarse[offset++] = c
      coarse[offset++] = d
    }
  }
  coarse.set(index.subarray(SURFACE_INDICES), offset)
  return coarse
}

/** The tile's terrain geometry as the library makes it (a 32x32 SkirtedPlaneGeometry), or null. */
function libraryGeometry(object: THREE.Object3D): THREE.BufferGeometry | null {
  const geometry = (object as THREE.Mesh).isMesh ? (object as THREE.Mesh).geometry : null
  const index = geometry?.index?.array
  const surface = (geometry as { surfaceVertexCount?: number } | null)?.surfaceVertexCount
  return index instanceof Uint32Array && index.length === SURFACE_INDICES + SKIRT_INDICES && surface === TILE_VERTICES * TILE_VERTICES
    ? geometry
    : null
}

/** The library's index (the same for every tile), and its coarse layouts by segments a side. */
let libraryIndex: Uint32Array | null = null
const layouts = new Map<number, Uint32Array>()

function layout(n: number): Uint32Array {
  libraryIndex ??= new SkirtedPlaneGeometry(1, 1, SEGMENTS, SEGMENTS).index!.array as Uint32Array
  let coarse = layouts.get(n)
  if (!coarse) layouts.set(n, (coarse = coarseTileIndex(libraryIndex, n)))
  return coarse
}

/** Writes `entries` at the start of the geometry's index and draws only them (all of it: Infinity). */
function drawIndex(geometry: THREE.BufferGeometry, entries: Uint32Array, count: number) {
  const index = geometry.index!
  ;(index.array as Uint32Array).set(entries)
  index.needsUpdate = true
  geometry.setDrawRange(0, count)
}

interface GridImage {
  data: ArrayLike<number>
  width: number
  height: number
}

const sourceVersion = (map: THREE.Texture) => (map.source as { version?: number } | undefined)?.version ?? map.version

/** Whether every texel any read of `image` at a surface vertex's uv could take (linear or nearest) is 0. */
export function flatUnderVertices(uv: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, { data, width, height }: GridImage): boolean {
  for (let i = 0; i < TILE_VERTICES * TILE_VERTICES; i++) {
    const x0 = Math.min(Math.max(Math.floor(uv.getX(i) * width - 0.5), 0), width - 1)
    const y0 = Math.min(Math.max(Math.floor(uv.getY(i) * height - 0.5), 0), height - 1)
    const x1 = Math.min(x0 + 1, width - 1)
    const y1 = Math.min(y0 + 1, height - 1)
    if (data[y0 * width + x0] !== 0 || data[y0 * width + x1] !== 0 || data[y1 * width + x0] !== 0 || data[y1 * width + x1] !== 0) {
      return false
    }
  }
  return true
}

/** Puts the library's index back on `mesh` once its grid, restitched, holds anything off 0 under a vertex (see the header). */
function watchStitching(mesh: THREE.Mesh, geometry: THREE.BufferGeometry) {
  const grid = () => (mesh.material as THREE.MeshPhongMaterial).displacementMap
  const first = grid()
  if (!first) return
  let version = sourceVersion(first)
  let coarse = true
  const previous = mesh.onBeforeRender
  mesh.onBeforeRender = function (...args) {
    previous.apply(this, args)
    const map = grid()
    if (!coarse || !map || sourceVersion(map) === version) return
    version = sourceVersion(map)
    if (flatUnderVertices(geometry.attributes.uv, map.image as GridImage)) return
    coarse = false
    drawIndex(geometry, libraryIndex!, Infinity)
  }
}

/**
 * A 3d-tiles-renderer plugin that gives each tile flat at sea level its
 * coarser index as the tile parses (see the header).
 */
export function createFlatTilePlugin() {
  return {
    name: 'SURFACE_FLAT_TILES',
    processTileModel(scene: THREE.Object3D, tile: object) {
      const range = tileHeightRange(tile)
      if (range?.min !== 0 || range.max !== 0) return
      scene.traverse((object) => {
        const geometry = libraryGeometry(object)
        if (!geometry) return
        const n = flatTileSegments(geometry.attributes.position)
        if (n === SEGMENTS) return
        const coarse = layout(n)
        drawIndex(geometry, coarse, coarse.length)
        watchStitching(object as THREE.Mesh, geometry)
      })
    },
  }
}
