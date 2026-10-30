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
// surface edges at FLAT_TILE_CHORD_METRES a segment or less: a 4 km chord
// sags 4000^2 / (8 R) ~ 0.31 m under the ellipsoid, no more than the
// library's own 32 segments sag on a z8 tile (~4.6 km segments, 0.4 m), so no
// flat tile draws further from the sea surface than the library's own tiles
// already do. A tile that would need all 32 is left alone.
//
// Unaffected: land, and any tile with any vertex off 0 m (coasts, islands,
// lakes, the Dead Sea), which keep the library's mesh; the water's bump and
// glint, which read the grid per fragment; the vertices themselves (only
// the index changes, before anything uploads the geometry: processTileModel
// runs at parse, before the first draw), so the ship's floor, which reads
// vertex heights from the position and uv attributes and never the index
// (surface-ground.ts buildTileGround), is as it was, at 0 m, the drawn chord
// at most 0.31 m under it. An index keys no program (tileProbe.ts's warm-up
// is the same). The skirt triangles are kept as the library made them: they
// hang from every one of the fine perimeter vertices, and close the
// sub-metre crack where a coarse edge meets a finer neighbour's.
//
// Known limit: stitching writes a land neighbour's edge texels into a flat
// tile's border once that neighbour loads, displacing the fine edge
// vertices the coarse surface skips (the range was measured before);
// the skirts cover the step.
import * as THREE from 'three'
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

/**
 * A 3d-tiles-renderer plugin that gives each tile flat at sea level its
 * coarser index as the tile parses (see the header).
 */
export function createFlatTilePlugin() {
  return {
    name: 'SURFACE_FLAT_TILES',
    processTileModel(scene: THREE.Object3D, tile: object) {
      const range = tileHeightRange(tile ?? {})
      if (range?.min !== 0 || range.max !== 0) return
      scene.traverse((object) => {
        const geometry = libraryGeometry(object)
        if (!geometry) return
        const n = flatTileSegments(geometry.attributes.position)
        if (n === SEGMENTS) return
        geometry.setIndex(new THREE.BufferAttribute(coarseTileIndex(geometry.index!.array as Uint32Array, n), 1))
      })
    },
  }
}
