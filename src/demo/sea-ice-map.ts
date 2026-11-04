// The seasons readout's polar maps (tides-zec.19, SeaIceMaps.tsx): each pole
// seen from above, out to REACH_DEG from it, as the classroom's maps draw
// them (NSIDC's own way up: 45°W down in the north, 0° up in the south).
// Sea ice is white on blue sea over grey land, and the whole map is dimmed by
// how little of the day the Sun is up at each latitude, so the polar night
// shows as a dark cap and the midnight Sun as a bright one. Pure: the pixels
// are worked out here, the component only puts them on a canvas.
import {
  MASK_PER_DEG,
  MASK_WIDTH,
  dayShare,
  gridPoint,
  maskRow,
  sampleGrid,
  type IceGrid,
  type PolarGrid,
  type SeaIceMask,
} from './sea-ice'

/** How far from the pole each map reaches (deg). */
export const REACH_DEG = 40

// sRGB 0-255. [TUNE]
const OCEAN = [32, 78, 120]
const LAND = [128, 124, 116]
const ICE = [246, 249, 252]
/** The map's brightness under polar night (none of the day lit). */
const NIGHT_SHADE = 0.3

const DEG = Math.PI / 180

/** Where each pixel of a map falls, worked out once per size. */
export interface PolarMapLayout {
  size: number
  grid: PolarGrid
  /** Per pixel: the grid cell position, latitude, the share of sea, and
   * the share of the pixel inside the disc (0 outside). */
  col: Float32Array
  row: Float32Array
  lat: Float32Array
  sea: Float32Array
  inside: Float32Array
}

/** The latitude and longitude (deg) at map pixel (x, y), or null off the disc. */
export function mapPoint(grid: PolarGrid, size: number, x: number, y: number): { lat: number; lon: number; r: number } | null {
  const half = size / 2
  const dx = (x + 0.5 - half) / half
  const down = (y + 0.5 - half) / half
  const r = Math.hypot(dx, down)
  if (r > 1 + 1 / half) return null
  const colat = r * REACH_DEG
  // Down the map is the central meridian in the north; up it, in the south.
  const lon = grid.lon0 + Math.atan2(dx, grid.sign * down) / DEG
  return { lat: grid.sign * (90 - colat), lon: ((((lon + 180) % 360) + 360) % 360) - 180, r }
}

export function polarMapLayout(grid: PolarGrid, mask: SeaIceMask, size: number): PolarMapLayout {
  const n = size * size
  const layout: PolarMapLayout = {
    size,
    grid,
    col: new Float32Array(n),
    row: new Float32Array(n),
    lat: new Float32Array(n),
    sea: new Float32Array(n),
    inside: new Float32Array(n),
  }
  const at = { col: 0, row: 0 }
  const half = size / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = y * size + x
      const point = mapPoint(grid, size, x, y)
      if (!point) continue
      // A pixel's worth of soft edge.
      layout.inside[k] = Math.min(1, Math.max(0, (1 - point.r) * half + 0.5))
      gridPoint(grid, point.lat, point.lon, at)
      layout.col[k] = at.col
      layout.row[k] = at.row
      layout.lat[k] = point.lat
      const row = maskRow(point.lat)
      if (row < 0) continue
      const mx = Math.min(MASK_WIDTH - 1, Math.floor((point.lon + 180) * MASK_PER_DEG))
      const my = Math.min(mask.height - 1, Math.floor(row))
      layout.sea[k] = mask.rg[2 * (my * mask.width + mx)] / 255
    }
  }
  return layout
}

/**
 * The map's RGBA pixels for the frames `a` and `b` of `ice` blended by `mix`,
 * with the Sun at declination `decDeg`, into `out` (size² × 4).
 */
export function drawPolarMap(
  layout: PolarMapLayout,
  ice: IceGrid,
  a: number,
  b: number,
  mix: number,
  decDeg: number,
  out: Uint8ClampedArray
): Uint8ClampedArray {
  const { size } = layout
  const { width, height } = ice
  const cellsA = ice.frames[a]
  const cellsB = ice.frames[b]
  // The shade for a latitude; the map's rows share a handful of them.
  let shadeLat = NaN
  let shade = 1
  for (let k = 0; k < size * size; k++) {
    const inside = layout.inside[k]
    const o = 4 * k
    if (inside <= 0) {
      out[o + 3] = 0
      continue
    }
    const lat = layout.lat[k]
    if (!(Math.abs(lat - shadeLat) <= 0.05)) {
      shadeLat = lat
      shade = NIGHT_SHADE + (1 - NIGHT_SHADE) * dayShare(lat, decDeg)
    }
    const sea = layout.sea[k]
    const col = layout.col[k]
    const row = layout.row[k]
    const cover =
      sea > 0
        ? sea * ((1 - mix) * sampleGrid(cellsA, width, height, col, row) + mix * sampleGrid(cellsB, width, height, col, row))
        : 0
    for (let c = 0; c < 3; c++) {
      const base = LAND[c] + (OCEAN[c] - LAND[c]) * sea
      out[o + c] = (base + (ICE[c] - base) * cover) * shade
    }
    out[o + 3] = 255 * inside
  }
  return out
}
