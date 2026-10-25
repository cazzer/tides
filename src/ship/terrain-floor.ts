// Earth's terrain floor for the flight model (tides-01v.8.3): how high the
// drawn ground stands along a direction, read on the CPU, so the ship can
// follow the terrain instead of a fixed sphere.
//
// The ground mesh (renderers/groundDisplacement.ts, tides-zmw.2) displaces
// each vertex along its normal by TERRAIN_DISPLACEMENT × the ground texture's
// height there: a bilinear read, at the vertex's texture coordinates, of the
// 4k map's 512 × 256 mean level (the 2k map's on the low tier: the same to
// within half a metre), or for a mesh with fewer rows the box mip whose rows
// match its own. So the drawn ground depends on that mean level alone, which
// ships as earth-dem-mean.bin, and the floor models the mesh itself:
//
//   1. buildTerrainFloor: every vertex's height, read as the GPU reads it,
//      and each quad's steeper triangle.
//   2. terrainFloorGrey: the height of the triangle a direction falls in,
//      linear over it as cloudShaders.ts cloudGround() takes it, quads split
//      north-west to south-east as THREE.SphereGeometry splits them. A ray
//      from the centre meets the flat triangle under the barycentric blend
//      of its corners' radii (the triangle inequality), which this tracks to
//      within TERRAIN_GREY_MARGIN (a test checks, densely). Each polar row,
//      a fan whose apexes all meet on the axis, takes its highest vertex.
//
// One floor per mesh: the 128 × 128 sphere's (earthTerrain) and the limb
// sphere's (earthLimbTerrain), for while EarthRenderer draws that one.
// While the limb sphere morphs toward the base sphere's triangles, the ship
// is above both floors (groundDisplacement.ts MORPH_FLOOR).
//
// Heights are in grey levels, the old 8-bit bump map's (255 = the
// displacement's full TERRAIN_DISPLACEMENT), as floats.

import * as THREE from 'three'
import { TERRAIN_DISPLACEMENT } from '../cloud-layer'
import { LIMB_SEGMENTS, type SphereSegments } from './limb-detail'
import { DEM_METRES_PER_UNIT, decodeEarthDem, halveLevel, type DemLevel, type EarthDem } from '../earth-dem'
import terrainUrl from '../assets/earth-dem-mean.bin?url'

/** earth-dem-mean.bin's size (and the cloud ceiling's): texels across
 * (longitude) and down. */
export const TERRAIN_MAP_SIZE: SphereSegments = [512, 256]

/** EarthRenderer's own ground sphere, drawn until the limb sphere swaps in. */
export const EARTH_BASE_SEGMENTS: SphereSegments = [128, 128]

/**
 * Grey levels added to the floor: the ground texture's half floats round by
 * at most an eighth of a level below 2 × TERRAIN_DISPLACEMENT, the mean
 * map's whole metres by a fiftieth, and the flat triangles' blend strays from
 * the floor's by less than the rest (terrain-floor.test).
 */
export const TERRAIN_GREY_MARGIN = 0.5

/** The floor's height where none is loaded: above any ground on Earth (9 km). */
export const TERRAIN_FALLBACK_GREY = (9000 / DEM_METRES_PER_UNIT) * 255

/** A ground mesh's heights (see the header). */
export interface TerrainFloor {
  segments: SphereSegments
  /** Each vertex's grey, rows north first, width + 1 to a row
   * (SphereGeometry's order). */
  grey: Float32Array
  /** Each polar row's highest vertex: north, south. */
  poles: readonly [number, number]
  /** Each quad's steeper triangle, grey per radian of arc, rows north
   * first (0 on the polar rows, which are flat). */
  slope: Float32Array
}

/** A DEM's heights in grey levels (see the header), rows north first. */
export function demGrey({ metres }: EarthDem): Float32Array {
  const grey = new Float32Array(metres.length)
  for (let k = 0; k < metres.length; k++) grey[k] = (metres[k] / DEM_METRES_PER_UNIT) * 255
  return grey
}

/** `level` (rows north first) read at (u, v) as the GPU's bilinear read:
 * repeating east-west, clamped north-south, north at v = 1. */
function readLevel({ width, height, data }: DemLevel, u: number, v: number): number {
  const x = u * width - 0.5
  const y = (1 - v) * height - 0.5
  const i = Math.floor(x)
  const j = Math.floor(y)
  const fx = x - i
  const fy = y - j
  const at = (ii: number, jj: number) =>
    data[THREE.MathUtils.clamp(jj, 0, height - 1) * width + (((ii % width) + width) % width)]
  return (at(i, j) * (1 - fx) + at(i + 1, j) * fx) * (1 - fy) + (at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx) * fy
}

/**
 * The floor of a mesh of `segments` displaced from `mean` (earth-dem-mean.bin
 * in grey levels, rows north first), read at the box mip whose rows match the
 * mesh's (groundDisplacement.ts groundLod).
 */
export function buildTerrainFloor(mean: DemLevel, [width, height]: SphereSegments): TerrainFloor {
  const ratio = mean.height / height
  if (mean.data.length !== mean.width * mean.height || !(ratio >= 1) || !Number.isInteger(Math.log2(ratio))) {
    throw new Error(`Terrain map ${mean.width}×${mean.height} has no level with a ${width}×${height} mesh's rows`)
  }
  let level = mean
  while (level.height > height) level = halveLevel(level)
  const row = width + 1
  const grey = new Float32Array(row * (height + 1))
  for (let j = 0; j <= height; j++) {
    // SphereGeometry's pole vertices sit half a column east (north) or west.
    const shift = j === 0 ? 0.5 : j === height ? -0.5 : 0
    for (let i = 0; i <= width; i++) grey[j * row + i] = readLevel(level, (i + shift) / width, 1 - j / height)
  }
  const rowsMax = (from: number, to: number) => grey.subarray(from * row, (to + 1) * row).reduce((a, b) => Math.max(a, b), 0)
  // Arc per quad: across at the quad's poleward edge, the narrower.
  const slope = new Float32Array(width * height)
  const down = Math.PI / height
  for (let j = 1; j < height - 1; j++) {
    const across = (2 * Math.PI * Math.min(Math.sin(j * down), Math.sin((j + 1) * down))) / width
    for (let i = 0; i < width; i++) {
      const nw = grey[j * row + i]
      const ne = grey[j * row + i + 1]
      const sw = grey[(j + 1) * row + i]
      const se = grey[(j + 1) * row + i + 1]
      slope[j * width + i] = Math.max(
        Math.hypot((ne - nw) / across, (se - ne) / down),
        Math.hypot((se - sw) / across, (sw - nw) / down)
      )
    }
  }
  return { segments: [width, height], grey, poles: [rowsMax(0, 1), rowsMax(height - 1, height)], slope }
}

/**
 * The floor's grey along the unit `local` direction in Earth's own
 * frame (lon 0 on +X, east toward −Z, north +Y, as THREE.SphereGeometry's
 * texture coordinates): never below the mesh's ground there.
 */
export function terrainFloorGrey({ segments: [width, height], grey, poles }: TerrainFloor, local: THREE.Vector3): number {
  // directionToUv (cloud-layer.ts), inlined: this runs per body per frame.
  const u = Math.atan2(local.z, -local.x) / (2 * Math.PI)
  const y = (0.5 - Math.asin(THREE.MathUtils.clamp(local.y, -1, 1)) / Math.PI) * height
  const j = Math.min(height - 1, Math.floor(y))
  if (j <= 0) return poles[0] + TERRAIN_GREY_MARGIN
  if (j >= height - 1) return poles[1] + TERRAIN_GREY_MARGIN
  const x = (u - Math.floor(u)) * width
  const i = Math.min(width - 1, Math.floor(x))
  const tx = x - i
  const ty = y - j
  const row = width + 1
  const nw = grey[j * row + i]
  const se = grey[(j + 1) * row + i + 1]
  const ground =
    ty <= tx
      ? nw + tx * (grey[j * row + i + 1] - nw) + ty * (se - grey[j * row + i + 1])
      : nw + ty * (grey[(j + 1) * row + i] - nw) + tx * (se - grey[(j + 1) * row + i])
  return ground + TERRAIN_GREY_MARGIN
}

/**
 * How far out from the centre the ground of a sphere of `radius` can stand
 * along `local` (see terrainFloorGrey), scene units, drawn at `displacement`
 * (the ground's displacementScale: the live terrain scale's,
 * ../terrain-scale.ts, tides-zmw.9.5). With no floor loaded,
 * TERRAIN_FALLBACK_GREY's at the full relief, over any ground at any scale.
 */
export function terrainFloorRadius(
  floor: TerrainFloor | null,
  radius: number,
  local: THREE.Vector3,
  displacement: number = TERRAIN_DISPLACEMENT
): number {
  if (!floor) return radius + (TERRAIN_DISPLACEMENT * TERRAIN_FALLBACK_GREY) / 255
  return radius + (displacement * terrainFloorGrey(floor, local)) / 255
}

const AROUND = 16
const _t1 = new THREE.Vector3()
const _t2 = new THREE.Vector3()
const _at = new THREE.Vector3()

/**
 * terrainFloorGrey's highest within `angle` radians of `local`, for a floor
 * the ship must clear across its near plane, not only under it (tides-42p).
 * The floor is linear over each triangle, so over a polygon of AROUND sides
 * around the disc it peaks at a mesh vertex inside or on the rim, and a
 * point of the rim is within half a side of a corner: this takes the
 * corners, every vertex within the polygon's circumcircle, and the steepest
 * slope of the quads under it times half a side (a few levels at the ship's
 * reach). A polar row in reach adds its height.
 */
export function terrainFloorGreyAround(floor: TerrainFloor, local: THREE.Vector3, angle: number): number {
  const {
    segments: [width, height],
    grey,
    poles,
    slope,
  } = floor
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
  // The rows of quads the disc spans.
  const lat = Math.asin(THREE.MathUtils.clamp(local.y, -1, 1))
  const rowOf = (at: number) => THREE.MathUtils.clamp(Math.floor((0.5 - at / Math.PI) * height), 0, height - 1)
  const first = rowOf(lat + rim)
  const last = rowOf(lat - rim)
  if (first === 0) top = Math.max(top, poles[0] + TERRAIN_GREY_MARGIN)
  if (last === height - 1) top = Math.max(top, poles[1] + TERRAIN_GREY_MARGIN)
  const u = Math.atan2(local.z, -local.x) / (2 * Math.PI)
  const x = (u - Math.floor(u)) * width
  // Columns within `rim` of `local` at colatitude `theta`, as a range.
  const columns = (theta: number) => {
    const span = (rim / Math.max(Math.sin(theta), 1e-9) / (2 * Math.PI)) * width
    return span >= width / 2 ? [0, width - 1] : [Math.floor(x - span), Math.ceil(x + span)]
  }
  const wrap = (k: number) => ((k % width) + width) % width
  // The steepest quad under the circumcircle, between the polar rows.
  let steepest = 0
  for (let j = Math.max(first, 1); j <= Math.min(last, height - 2); j++) {
    const poleward = Math.abs(j - height / 2) > Math.abs(j + 1 - height / 2) ? j : j + 1
    const [from, to] = columns((poleward / height) * Math.PI)
    for (let k = from - 1; k <= to; k++) steepest = Math.max(steepest, slope[j * width + wrap(k)])
  }
  // The vertices between the polar rows within the circumcircle.
  const row = width + 1
  for (let j = Math.max(first, 1); j <= Math.min(last + 1, height - 1); j++) {
    const theta = (j / height) * Math.PI
    const [from, to] = columns(theta)
    for (let k = from; k <= to; k++) {
      const i = wrap(k)
      const phi = (i / width) * 2 * Math.PI
      _at.set(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta))
      if (_at.dot(local) >= c) top = Math.max(top, grey[j * row + i] + TERRAIN_GREY_MARGIN)
    }
  }
  return top + steepest * rim * Math.sin(Math.PI / AROUND)
}

// Earth's floors, once loaded. Shared by every set of ship bodies.
let earthFloor: TerrainFloor | null = null
let earthLimbFloor: TerrainFloor | null = null
let loading = false

/** The 128 × 128 sphere's floor, or null until loadEarthTerrain has finished. */
export function earthTerrain(): TerrainFloor | null {
  return earthFloor
}

/**
 * The limb sphere's floor (tides-42p): its quads are 0.7° across, the
 * 128 × 128 sphere's 2.8° by 1.4°. Under it the drawn ground must be the limb
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

/** earth-dem-mean.bin in grey levels, the floors' source. */
export function meanGrey(dem: EarthDem): DemLevel {
  return { width: dem.width, height: dem.height, data: demGrey(dem) }
}

/**
 * Fetch and build Earth's floors in the background, once. Until they land
 * (or if it fails) terrainFloorRadius falls back to its fixed sphere. Outside
 * a browser there is no asset server, so it does nothing.
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
      const mean = meanGrey(dem)
      earthFloor = buildTerrainFloor(mean, EARTH_BASE_SEGMENTS)
      earthLimbFloor = buildTerrainFloor(mean, LIMB_SEGMENTS)
    })
    .catch((error: unknown) => {
      loading = false
      console.warn('Earth terrain floor failed to load; keeping the fixed sphere.', error)
    })
}
