// Earth's terrain floor for the flight model (tides-01v.8.3): how high the
// drawn ground can stand along a direction, read on the CPU from a small
// heightmap, so the ship can follow the terrain instead of a fixed sphere.
//
// The ground mesh displaces each vertex along its normal by
// TERRAIN_DISPLACEMENT × the bump map's grey there (bilinear at the vertex),
// and a ray from the centre meets a flat triangle between vertices, never
// above the highest of its corners. So a point sample under the ship is not
// enough: the floor takes the max over every texel a mesh cell's vertices
// can read. Built in three steps:
//
//   1. earth-terrain-max.bin (scripts/build-terrain-floor.mjs): the bump
//      maps max-pooled to 512 × 256, so every texel of either map is at or
//      below its block.
//   2. buildTerrainFloor: the max over each of FLOOR_CELLS' cells, then over
//      each cell's 3 × 3 neighbourhood. The neighbours cover the texels a
//      corner vertex's bilinear sample reaches across the cell's edge, and
//      the triangles' chords, which bow a little past their cell's rows.
//   3. terrainFloorGrey: bilinear between cell centres. A point s of the way
//      across its cell c (s ≥ ½ in the quadrant it blends toward) puts weight
//      1.5 − s on c's own column of centres, whose neighbourhoods hold every
//      texel any corner of c reads, even across c's far edge. The column it
//      blends toward holds the near corners' texels; the far corners carry at
//      most 1 − s of the hit, whose radius is a weighted harmonic mean of the
//      corner heights, rising in each. So the blend never dips below the
//      triangle the point sees. The polar rows take their whole row's max: on
//      the axis a ray meets every fan's apex at once.
//
// The limb mesh (LIMB_SEGMENTS, 512 × 256) nests inside FLOOR_CELLS' cells,
// so one floor covers both. TERRAIN_GREY_MARGIN absorbs JPEG decoders
// disagreeing by a level or two.

import * as THREE from 'three'
import { TERRAIN_DISPLACEMENT } from '../cloud-layer'
import type { SphereSegments } from './limb-detail'
import terrainUrl from '../assets/earth-terrain-max.bin?url'

/** earth-terrain-max.bin's size: blocks across (longitude) and down. */
export const TERRAIN_MAP_SIZE: SphereSegments = [512, 256]

/**
 * The coarsest Earth ground mesh's cells (EarthRenderer's 128 × 128 sphere);
 * finer meshes must divide each of these evenly.
 */
export const FLOOR_CELLS: SphereSegments = [128, 128]

/** Grey levels added to every cell, for decoders that round differently. */
export const TERRAIN_GREY_MARGIN = 4

/** Highest grey per FLOOR_CELLS cell, dilated (see the header); rows north first. */
export interface TerrainFloor {
  width: number
  height: number
  grey: Uint8Array
}

/**
 * The floor's cell maxima from a max-pooled heightmap `pooled` of
 * `pooledWidth` × `pooledHeight` (rows north first, columns from −180° east),
 * whose size must be a multiple of `cells`.
 */
export function buildTerrainFloor(
  pooled: Uint8Array,
  [pooledWidth, pooledHeight]: SphereSegments = TERRAIN_MAP_SIZE,
  [width, height]: SphereSegments = FLOOR_CELLS
): TerrainFloor {
  if (
    pooled.length !== pooledWidth * pooledHeight ||
    pooledWidth % width !== 0 ||
    pooledHeight % height !== 0
  ) {
    throw new Error(
      `Terrain map ${pooledWidth}×${pooledHeight} (${pooled.length} bytes) does not tile ${width}×${height} cells`
    )
  }
  const bx = pooledWidth / width
  const by = pooledHeight / height
  const cell = new Uint8Array(width * height)
  for (let y = 0; y < pooledHeight; y++) {
    const row = Math.floor(y / by) * width
    for (let x = 0; x < pooledWidth; x++) {
      const i = row + Math.floor(x / bx)
      const g = pooled[y * pooledWidth + x]
      if (g > cell[i]) cell[i] = g
    }
  }
  // Longitude wraps; the poles' rows only reach toward the equator.
  const grey = new Uint8Array(width * height)
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      let max = 0
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj
        if (jj < 0 || jj >= height) continue
        for (let di = -1; di <= 1; di++) {
          max = Math.max(max, cell[jj * width + ((i + di + width) % width)])
        }
      }
      grey[j * width + i] = Math.min(255, max + TERRAIN_GREY_MARGIN)
    }
  }
  for (const j of [0, height - 1]) {
    const row = grey.subarray(j * width, (j + 1) * width)
    row.fill(row.reduce((a, b) => Math.max(a, b), 0))
  }
  return { width, height, grey }
}

/**
 * The floor's grey, 0–255, along the unit `local` direction in Earth's own
 * frame (lon 0 on +X, east toward −Z, north +Y, as THREE.SphereGeometry's
 * texture coordinates). Never below the grey any ground-mesh vertex
 * interpolates to there.
 */
export function terrainFloorGrey({ width, height, grey }: TerrainFloor, local: THREE.Vector3): number {
  // directionToUv (cloud-layer.ts), inlined: this runs per body per frame.
  const u = Math.atan2(local.z, -local.x) / (2 * Math.PI)
  const fromNorth = 0.5 - Math.asin(THREE.MathUtils.clamp(local.y, -1, 1)) / Math.PI
  const x = (u - Math.floor(u)) * width - 0.5
  const y = THREE.MathUtils.clamp(fromNorth * height - 0.5, 0, height - 1)
  const i0 = Math.floor(x)
  const j0 = Math.floor(y)
  const fx = x - i0
  const fy = y - j0
  const a = (i0 + width) % width
  const b = (i0 + 1) % width
  const j1 = Math.min(j0 + 1, height - 1)
  const top = grey[j0 * width + a] * (1 - fx) + grey[j0 * width + b] * fx
  const bottom = grey[j1 * width + a] * (1 - fx) + grey[j1 * width + b] * fx
  return top * (1 - fy) + bottom * fy
}

/**
 * How far out from the centre the ground of a sphere of `radius` can stand
 * along `local` (see terrainFloorGrey), scene units. With no floor loaded,
 * the highest the displacement reaches anywhere (bump-map white).
 */
export function terrainFloorRadius(
  floor: TerrainFloor | null,
  radius: number,
  local: THREE.Vector3
): number {
  const grey = floor ? terrainFloorGrey(floor, local) : 255
  return radius + (TERRAIN_DISPLACEMENT * grey) / 255
}

// Earth's floor, once loaded. Shared by every set of ship bodies.
let earthFloor: TerrainFloor | null = null
let loading = false

/** Earth's terrain floor, or null until loadEarthTerrain has finished. */
export function earthTerrain(): TerrainFloor | null {
  return earthFloor
}

/** Replace Earth's floor (null drops back to the fallback); for tests. */
export function setEarthTerrain(floor: TerrainFloor | null): void {
  earthFloor = floor
}

/**
 * Fetch and build Earth's floor in the background, once. Until it lands (or
 * if it fails) terrainFloorRadius falls back to its fixed sphere. Outside a
 * browser there is no asset server, so it does nothing.
 */
export function loadEarthTerrain(): void {
  if (loading || earthFloor || typeof window === 'undefined') return
  loading = true
  fetch(terrainUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      return response.arrayBuffer()
    })
    .then((buffer) => {
      earthFloor = buildTerrainFloor(new Uint8Array(buffer))
    })
    .catch((error: unknown) => {
      loading = false
      console.warn('Earth terrain floor failed to load; keeping the fixed sphere.', error)
    })
}
