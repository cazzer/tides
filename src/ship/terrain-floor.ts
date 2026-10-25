// Earth's terrain floor for the flight model (tides-01v.8.3): how high the
// drawn ground can stand along a direction, read on the CPU from a small
// heightmap, so the ship can follow the terrain instead of a fixed sphere.
//
// The ground mesh displaces each vertex along its normal by
// TERRAIN_DISPLACEMENT × the elevation map's height there (bilinear at the
// vertex; earth-dem.ts),
// and a ray from the centre meets a flat triangle between vertices, never
// above the highest of its corners. So a point sample under the ship is not
// enough: the floor takes the max over every texel a mesh cell's vertices
// can read. Built in three steps:
//
//   1. earth-dem-max.bin (scripts/build-earth-dem.mjs): the 4k elevation
//      map max-pooled to 512 × 256, so every texel of it and of the 2k map
//      (its 2 × 2 means) is at or below its block.
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
// so one floor covers both. While the limb sphere is the one drawn, the same
// build over its own cells (earthLimbTerrain) covers it alone, much nearer
// the ground: the coarse floor stands above the cloud base over nearly all
// land (tides-42p).
//
// Heights are in grey levels, the old 8-bit bump map's (255 = the
// displacement's full TERRAIN_DISPLACEMENT), as floats: the 16-bit map's
// (tides-zmw.1) fall between levels, and nothing caps them at 255.
// TERRAIN_GREY_MARGIN covers the GPU's half-float rounding of the map.

import * as THREE from 'three'
import { TERRAIN_DISPLACEMENT } from '../cloud-layer'
import { LIMB_SEGMENTS, type SphereSegments } from './limb-detail'
import { DEM_METRES_PER_UNIT, decodeEarthDem, type EarthDem } from '../earth-dem'
import terrainUrl from '../assets/earth-dem-max.bin?url'

/** earth-dem-max.bin's size: blocks across (longitude) and down. */
export const TERRAIN_MAP_SIZE: SphereSegments = [512, 256]

/**
 * The coarsest Earth ground mesh's cells (EarthRenderer's 128 × 128 sphere);
 * finer meshes must divide each of these evenly.
 */
export const FLOOR_CELLS: SphereSegments = [128, 128]

/**
 * Grey levels added to every cell: the elevation texture's half floats round
 * by at most an eighth of a level below 2 × TERRAIN_DISPLACEMENT.
 */
export const TERRAIN_GREY_MARGIN = 0.5

/** The floor's height where none is loaded: above any ground on Earth (9 km). */
export const TERRAIN_FALLBACK_GREY = (9000 / DEM_METRES_PER_UNIT) * 255

/** Highest grey per FLOOR_CELLS cell, dilated (see the header); rows north first. */
export interface TerrainFloor {
  width: number
  height: number
  grey: Float32Array
}

/** A DEM's heights in grey levels (see the header), rows north first. */
export function demGrey({ metres }: EarthDem): Float32Array {
  const grey = new Float32Array(metres.length)
  for (let k = 0; k < metres.length; k++) grey[k] = (metres[k] / DEM_METRES_PER_UNIT) * 255
  return grey
}

/**
 * The floor's cell maxima from a max-pooled heightmap `pooled` of
 * `pooledWidth` × `pooledHeight` (rows north first, columns from −180° east),
 * whose size must be a multiple of `cells`.
 */
export function buildTerrainFloor(
  pooled: ArrayLike<number>,
  [pooledWidth, pooledHeight]: SphereSegments = TERRAIN_MAP_SIZE,
  [width, height]: SphereSegments = FLOOR_CELLS
): TerrainFloor {
  if (
    pooled.length !== pooledWidth * pooledHeight ||
    pooledWidth % width !== 0 ||
    pooledHeight % height !== 0
  ) {
    throw new Error(
      `Terrain map ${pooledWidth}×${pooledHeight} (${pooled.length} heights) does not tile ${width}×${height} cells`
    )
  }
  const bx = pooledWidth / width
  const by = pooledHeight / height
  const cell = new Float32Array(width * height)
  for (let y = 0; y < pooledHeight; y++) {
    const row = Math.floor(y / by) * width
    for (let x = 0; x < pooledWidth; x++) {
      const i = row + Math.floor(x / bx)
      const g = pooled[y * pooledWidth + x]
      if (g > cell[i]) cell[i] = g
    }
  }
  // Longitude wraps; the poles' rows only reach toward the equator.
  const grey = new Float32Array(width * height)
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
      grey[j * width + i] = max + TERRAIN_GREY_MARGIN
    }
  }
  for (const j of [0, height - 1]) {
    const row = grey.subarray(j * width, (j + 1) * width)
    row.fill(row.reduce((a, b) => Math.max(a, b), 0))
  }
  return { width, height, grey }
}

/**
 * The floor's grey along the unit `local` direction in Earth's own
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
 * TERRAIN_FALLBACK_GREY's, over any ground.
 */
export function terrainFloorRadius(
  floor: TerrainFloor | null,
  radius: number,
  local: THREE.Vector3
): number {
  const grey = floor ? terrainFloorGrey(floor, local) : TERRAIN_FALLBACK_GREY
  return radius + (TERRAIN_DISPLACEMENT * grey) / 255
}

const AROUND = 8
/** Grey levels terrainFloorGreyAround adds for its octagon's sides. */
const AROUND_SLACK = 0.5
const _t1 = new THREE.Vector3()
const _t2 = new THREE.Vector3()
const _at = new THREE.Vector3()

/**
 * terrainFloorGrey's highest within `angle` radians of `local`, for a floor
 * the ship must clear across its near plane, not only under it (tides-42p):
 * a fine floor's slopes come within a near plane's reach. Between cell
 * centres the floor is bilinear, a saddle with no peak inside a cell, so over
 * the disc it peaks on the rim or at a centre within it: this takes the
 * corners of an octagon around the rim and any centre inside, plus
 * AROUND_SLACK for the bilinear's bow along a side (a cell is ~10 reaches
 * across, so it bows by hundredths of a level).
 */
export function terrainFloorGreyAround(floor: TerrainFloor, local: THREE.Vector3, angle: number): number {
  const { width, height, grey } = floor
  let top = terrainFloorGrey(floor, local)
  const rim = angle / Math.cos(Math.PI / AROUND)
  _t1.set(0, 1, 0)
  if (Math.abs(local.y) > 0.9) _t1.set(1, 0, 0)
  _t1.cross(local).normalize()
  _t2.copy(local).cross(_t1)
  const c = Math.cos(rim)
  const s = Math.sin(rim)
  for (let k = 0; k < AROUND; k++) {
    const phi = (2 * Math.PI * k) / AROUND
    _at.copy(local).multiplyScalar(c).addScaledVector(_t1, s * Math.cos(phi)).addScaledVector(_t2, s * Math.sin(phi))
    top = Math.max(top, terrainFloorGrey(floor, _at))
  }
  // The cell centres around `local` (terrainFloorGrey's grid), if inside.
  const u = Math.atan2(local.z, -local.x) / (2 * Math.PI)
  const x0 = Math.floor((u - Math.floor(u)) * width - 0.5)
  const y0 = Math.floor((0.5 - Math.asin(THREE.MathUtils.clamp(local.y, -1, 1)) / Math.PI) * height - 0.5)
  for (let j = y0; j <= y0 + 1; j++) {
    if (j < 0 || j >= height) continue
    const lat = Math.PI / 2 - ((j + 0.5) / height) * Math.PI
    for (let i = x0; i <= x0 + 1; i++) {
      const lon = ((i + 0.5) / width) * 2 * Math.PI
      _at.set(-Math.cos(lon) * Math.cos(lat), Math.sin(lat), Math.sin(lon) * Math.cos(lat))
      if (_at.dot(local) >= c) top = Math.max(top, grey[j * width + ((i + width) % width)])
    }
  }
  return top + AROUND_SLACK
}

// Earth's floors, once loaded. Shared by every set of ship bodies.
let earthFloor: TerrainFloor | null = null
let earthLimbFloor: TerrainFloor | null = null
let loading = false

/** Earth's terrain floor, or null until loadEarthTerrain has finished. */
export function earthTerrain(): TerrainFloor | null {
  return earthFloor
}

/**
 * Earth's floor over the limb sphere alone (tides-42p): the same build with
 * LIMB_SEGMENTS' cells, so a peak holds the floor up over ~2° rather than
 * the 128 × 128 sphere's ~8°. Under it the drawn ground must be the limb
 * sphere; null until loaded, or when set without one.
 */
export function earthLimbTerrain(): TerrainFloor | null {
  return earthLimbFloor
}

/** Replace Earth's floors (null drops back to the fallback); for tests. */
export function setEarthTerrain(floor: TerrainFloor | null, limbFloor: TerrainFloor | null = null): void {
  earthFloor = floor
  earthLimbFloor = limbFloor
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
    .then((buffer) => decodeEarthDem(buffer))
    .then((dem) => {
      if (dem.width !== TERRAIN_MAP_SIZE[0] || dem.height !== TERRAIN_MAP_SIZE[1]) {
        throw new Error(`Terrain map is ${dem.width}×${dem.height}, expected ${TERRAIN_MAP_SIZE.join('×')}`)
      }
      const pooled = demGrey(dem)
      earthFloor = buildTerrainFloor(pooled)
      earthLimbFloor = buildTerrainFloor(pooled, TERRAIN_MAP_SIZE, LIMB_SEGMENTS)
    })
    .catch((error: unknown) => {
      loading = false
      console.warn('Earth terrain floor failed to load; keeping the fixed sphere.', error)
    })
}
