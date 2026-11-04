// The seasons tour's sea ice (tides-zec.19): the format of
// src/assets/sea-ice-2025.bin, which scripts/build-sea-ice.py writes, and the
// sums the globe's ice layer (SeaIceGlobe.tsx) and the polar maps
// (SeaIceMaps.tsx) share. Pure, so tests can run it.
//
// The data: NSIDC's Sea Ice Index, Version 4 (G02135), daily concentration on
// its 25 km polar stereographic grids, every 7 days of 2025, and that year's
// daily extents. One year stands in for every year: the tour's dates (2026-27)
// show the ice on the same day of the year in 2025 (seaIceDay), the weekly
// grids blended between (seaIceFrames).
//
// The file is gzip over: the magic "SIC1"; then uint16 little endian: the
// year, the days between frames, the frame count, the north grid's width and
// height, the south's, and the days of extents; then the extents, north's
// year then south's, uint16 thousandths of a million km²; then each frame,
// the north grid then the south's, rows top first, a byte a cell (0-255 for
// 0-100% of the cell covered).

const MAGIC = 'SIC1'
const HEADER_BYTES = 4 + 2 * 8

export interface IceGrid {
  width: number
  height: number
  /** One per frame, rows top first. */
  frames: Uint8Array[]
}

export interface SeaIce {
  year: number
  stepDays: number
  north: IceGrid
  south: IceGrid
  /** Million km², one per day of `year`. */
  extentNorth: Float32Array
  extentSouth: Float32Array
}

/** The decompressed file's contents. Throws on a body that isn't one. */
export function unpackSeaIce(body: Uint8Array): SeaIce {
  const magic = String.fromCharCode(...body.subarray(0, 4))
  if (body.length < HEADER_BYTES || magic !== MAGIC) throw new Error('Not a sea ice file')
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const u16 = (i: number) => view.getUint16(4 + 2 * i, true)
  const [year, stepDays, count, nw, nh, sw, sh, days] = [0, 1, 2, 3, 4, 5, 6, 7].map(u16)
  const cells = nw * nh + sw * sh
  const extentsAt = HEADER_BYTES
  const framesAt = extentsAt + 4 * days
  if (body.length !== framesAt + count * cells) {
    throw new Error(`Sea ice: ${body.length} bytes, expected ${framesAt + count * cells}`)
  }
  const extent = (from: number) => {
    const out = new Float32Array(days)
    for (let d = 0; d < days; d++) out[d] = view.getUint16(from + 2 * d, true) / 1000
    return out
  }
  const north: IceGrid = { width: nw, height: nh, frames: [] }
  const south: IceGrid = { width: sw, height: sh, frames: [] }
  for (let f = 0; f < count; f++) {
    const at = framesAt + f * cells
    north.frames.push(body.subarray(at, at + nw * nh))
    south.frames.push(body.subarray(at + nw * nh, at + cells))
  }
  return {
    year,
    stepDays,
    north,
    south,
    extentNorth: extent(extentsAt),
    extentSouth: extent(extentsAt + 2 * days),
  }
}

// --- Where on the grids -----------------------------------------------------

/** The grids' projection: NSIDC polar stereographic (EPSG:3411 / 3412). */
export interface PolarGrid {
  /** +1 north, −1 south. */
  sign: 1 | -1
  /** The central meridian (deg). */
  lon0: number
  /** The top-left corner (m) and the cell size (m). */
  x0: number
  y0: number
  cell: number
  width: number
  height: number
}

export const NORTH_GRID: PolarGrid = { sign: 1, lon0: -45, x0: -3_850_000, y0: 5_850_000, cell: 25_000, width: 304, height: 448 }
export const SOUTH_GRID: PolarGrid = { sign: -1, lon0: 0, x0: -3_950_000, y0: 4_350_000, cell: 25_000, width: 316, height: 332 }

// The Hughes 1980 ellipsoid, true scale at 70°.
export const HUGHES_A = 6_378_273
export const HUGHES_E = 0.081816153
export const TRUE_SCALE_LAT = 70

const DEG = Math.PI / 180

function tsfn(phi: number): number {
  const s = HUGHES_E * Math.sin(phi)
  return Math.tan(Math.PI / 4 - phi / 2) / Math.pow((1 - s) / (1 + s), HUGHES_E / 2)
}

/** a·m_c / t_c: ρ = RHO_SCALE · t(φ) (Snyder, Map Projections, 21-33/34). */
export const RHO_SCALE = (() => {
  const phiC = TRUE_SCALE_LAT * DEG
  const s = HUGHES_E * Math.sin(phiC)
  return (HUGHES_A * Math.cos(phiC)) / Math.sqrt(1 - s * s) / tsfn(phiC)
})()

/**
 * Where (lat, lon) in degrees falls on `grid`, in cells from its top-left
 * corner (a cell's centre is at +0.5); outside 0..width × 0..height is off it.
 * Matches NSIDC's published corners to 0.03 cells (sea-ice.test.ts).
 */
export function gridPoint(grid: PolarGrid, latDeg: number, lonDeg: number, out = { col: 0, row: 0 }) {
  // The south's is the north's turned over: φ, λ and λ0 negated, then x and y.
  const phi = grid.sign * latDeg * DEG
  const lam = (grid.sign * lonDeg - grid.sign * grid.lon0) * DEG
  const rho = RHO_SCALE * tsfn(phi)
  const x = grid.sign * rho * Math.sin(lam)
  const y = -grid.sign * rho * Math.cos(lam)
  out.col = (x - grid.x0) / grid.cell
  out.row = (grid.y0 - y) / grid.cell
  return out
}

/** A grid's cover (0..1) at a cell position, blended between its four nearest cells; 0 off the grid. */
export function sampleGrid(cells: Uint8Array, width: number, height: number, col: number, row: number): number {
  const x = col - 0.5
  const y = row - 0.5
  if (!(x > -1 && y > -1 && x < width && y < height)) return 0
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const at = (cx: number, cy: number) =>
    cx < 0 || cy < 0 || cx >= width || cy >= height ? 0 : cells[cy * width + cx]
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx
  return (top * (1 - fy) + bottom * fy) / 255
}

// --- The mask (src/assets/sea-ice-mask.png) --------------------------------

/** The mask's bands (deg, north first) and texels per degree, as built. */
export const MASK_PER_DEG = 10
export const MASK_NORTH = { top: 90, bottom: 35 }
export const MASK_SOUTH = { top: -45, bottom: -90 }
export const MASK_WIDTH = 360 * MASK_PER_DEG
export const MASK_NORTH_ROWS = (MASK_NORTH.top - MASK_NORTH.bottom) * MASK_PER_DEG
export const MASK_HEIGHT = MASK_NORTH_ROWS + (MASK_SOUTH.top - MASK_SOUTH.bottom) * MASK_PER_DEG

export interface SeaIceMask {
  /** RG, 0-255, a texel each, rows top first: red sea, green the day map's all-year ice. */
  rg: Uint8Array<ArrayBuffer>
  width: number
  height: number
}

/**
 * The mask row (fractional, from the top) for latitude `lat` (deg), or -1
 * between the bands, where the layer never draws.
 */
export function maskRow(lat: number): number {
  if (lat >= MASK_NORTH.bottom) return ((MASK_NORTH.top - lat) / (MASK_NORTH.top - MASK_NORTH.bottom)) * MASK_NORTH_ROWS
  if (lat <= MASK_SOUTH.top) return MASK_NORTH_ROWS + (MASK_SOUTH.top - lat) * MASK_PER_DEG
  return -1
}

// --- When -------------------------------------------------------------------

/**
 * The day of the year at `t` (epoch ms, UTC), 0 at 1 January 00:00 and the
 * year's length scaled to 365 days, so it reads the data year's same date.
 */
export function seaIceDay(t: number): number {
  const year = new Date(t).getUTCFullYear()
  const start = Date.UTC(year, 0, 1)
  const end = Date.UTC(year + 1, 0, 1)
  return ((t - start) / (end - start)) * 365
}

/**
 * The two frames either side of day `day` (seaIceDay) and how far from the
 * first to the second (0..1). Past the last frame (31 December) it blends
 * into the first (1 January): the same year's, a step that small.
 */
export function seaIceFrames(day: number, stepDays: number, count: number): { a: number; b: number; mix: number } {
  const position = Math.min(Math.max(day, 0), 365) / stepDays
  const a = Math.min(Math.floor(position), count - 1)
  if (a === count - 1) {
    const last = (count - 1) * stepDays
    return { a, b: 0, mix: Math.min(1, Math.max(0, (day - last) / (365 - last))) }
  }
  return { a, b: a + 1, mix: position - a }
}

/** The extent (million km²) on day `day`, between the daily values. */
export function extentOn(extents: Float32Array, day: number): number {
  const n = extents.length
  const d = Math.min(Math.max(day, 0), n - 1)
  const i = Math.min(Math.floor(d), n - 2)
  const f = d - i
  return extents[i] * (1 - f) + extents[i + 1] * f
}

const dataDateFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })

/** The data's date for sim time `t`: the same day of the year in the data's year, "20 Mar 2025". */
export function seaIceDataDate(t: number, year: number): string {
  const day = Math.floor(seaIceDay(t))
  return dataDateFormat.format(Date.UTC(year, 0, 1 + day))
}

// --- The polar maps ---------------------------------------------------------

/**
 * The share of the day the Sun is up at latitude `latDeg` when its
 * declination is `decDeg`, 0..1, from its centre's rising (no refraction):
 * 0 in polar night, 1 under the midnight Sun.
 */
export function dayShare(latDeg: number, decDeg: number): number {
  const x = -Math.tan(latDeg * DEG) * Math.tan(decDeg * DEG)
  if (x >= 1) return 0
  if (x <= -1) return 1
  return Math.acos(x) / Math.PI
}
