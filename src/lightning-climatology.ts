// The lightning climatology (tides-ufyr.14): where and when storms flash on
// average, which simulated lightning (./lightning-sim.ts) seeds its storms
// from. Pure; the asset is fetched in renderers/lightningFeed.ts.
//
// The asset, src/assets/earth-lightning.bin (tides-ufyr.14.1, made by
// scripts/build-lightning-climatology.py from NASA's LIS Very High
// Resolution Monthly Lightning Climatology, the GIBS layer
// LIS_Very_High_Resolution_Lightning_Monthly_Climatology_LIS_Mean_Flash_Rate:
// TRMM LIS, about 38° S to 38° N), is LIGHTNING_BYTES bytes, no header, 15
// planes back to back, each bottom (southernmost) row first, columns from
// 180° W eastward:
//   planes 1-12: the months' mean flash density, CLIM_W x CLIM_H (2.5°),
//     byte = round(255 · ln(1 + F / F0) / ln(1 + FMAX / F0)), F in
//     flashes / km² / day, clamped to FMAX;
//   plane 13: the land fraction, CLIM_W x CLIM_H, byte = round(255 · land);
//   plane 14: LIS's coverage, CLIM_W x CLIM_H: 255 observed, 0 no data,
//     between a blend at the edge (byte = round(255 · coverage));
//   plane 15: the static clouds' cover (the alpha the static cloud map
//     shows), COVER_W x COVER_H (1°), byte = round(255 · alpha).
//
// Where LIS has no data (poleward of its orbit, or a gap) the density is
// guessed (guessedDensity): a prior tied to no place, only the season, the
// latitude's hemisphere and land or sea, which the simulation's cloud
// cover gate and forecast showers then put under the storms' clouds.

export const CLIM_W = 144
export const CLIM_H = 72
export const CLIM_CELLS = CLIM_W * CLIM_H
export const COVER_W = 360
export const COVER_H = 180
export const MONTHS = 12
/** Flash density's encoding: log-like below F0, saturating at FMAX (fl/km²/day). */
export const DENSITY_F0 = 0.001
export const DENSITY_FMAX = 2
/** The planes before the static cover: 12 months, land, coverage. */
const CLIM_PLANES = MONTHS + 2
export const LIGHTNING_BYTES = CLIM_PLANES * CLIM_CELLS + COVER_W * COVER_H
/** [TUNE] The guess's density (fl/km²/day) over sea at the year's mean,
 * matched by eye to LIS at 30-38° (land in its summer ~0.04, ~15 fl/km²/yr). */
export const GUESS_BASE = 0.0075
/** [TUNE] The guess's seasonal swing: x(1 ± SEASON_AMP), peaking mid-July in
 * the north and mid-January in the south. */
export const SEASON_AMP = 0.8
/** [TUNE] Land flashes this many times as often as the sea in the guess. */
export const GUESS_LAND_RATIO = 3
/** The guess's season is full by this latitude, none at the equator. */
const SEASON_FULL_LAT = 20

const CELL_DEG = 360 / CLIM_W
const EARTH_RADIUS_KM = 6371.0088
const DEG = Math.PI / 180
const LOG_SPAN = Math.log1p(DENSITY_FMAX / DENSITY_F0)

export interface LightningClimatology {
  /** Each month's flash density, fl/km²/day, by cell (cellOf). */
  monthly: readonly Float32Array[]
  /** Land fraction 0..1, by cell. */
  land: Float32Array
  /** LIS's coverage 0..1, by cell: where below 1, the density blends to the guess. */
  coverage: Float32Array
  /** The static clouds' alpha, a byte per 1° texel, bottom row first. */
  cover: Uint8Array
}

/** A density (fl/km²/day) as its byte. */
export function encodeFlashDensity(f: number): number {
  const clamped = Math.min(DENSITY_FMAX, Math.max(0, f))
  return Math.round((255 * Math.log1p(clamped / DENSITY_F0)) / LOG_SPAN)
}

/** A byte back to fl/km²/day. */
export function decodeFlashDensity(byte: number): number {
  return DENSITY_F0 * Math.expm1((byte / 255) * LOG_SPAN)
}

/** The climatology isn't there, or isn't this layout: trying again won't help. */
export class ClimatologyUnusable extends Error {
  override name = 'ClimatologyUnusable'
}

export function decodeLightningClimatology(bytes: Uint8Array): LightningClimatology {
  if (bytes.length !== LIGHTNING_BYTES) {
    throw new ClimatologyUnusable(`lightning climatology: ${bytes.length} bytes, expected ${LIGHTNING_BYTES}`)
  }
  const table = new Float32Array(256)
  for (let b = 0; b < 256; b++) table[b] = decodeFlashDensity(b)
  const monthly: Float32Array[] = []
  for (let m = 0; m < MONTHS; m++) {
    const plane = new Float32Array(CLIM_CELLS)
    const base = m * CLIM_CELLS
    for (let i = 0; i < CLIM_CELLS; i++) plane[i] = table[bytes[base + i]]
    monthly.push(plane)
  }
  const land = new Float32Array(CLIM_CELLS)
  const landBase = MONTHS * CLIM_CELLS
  for (let i = 0; i < CLIM_CELLS; i++) land[i] = bytes[landBase + i] / 255
  const coverage = new Float32Array(CLIM_CELLS)
  const coverageBase = landBase + CLIM_CELLS
  for (let i = 0; i < CLIM_CELLS; i++) coverage[i] = bytes[coverageBase + i] / 255
  const cover = bytes.slice(CLIM_PLANES * CLIM_CELLS)
  return { monthly, land, coverage, cover }
}

const wrapLon = (lonDeg: number) => (((lonDeg + 180) % 360) + 360) % 360

/** The cell holding (lat, lon), degrees. */
export function cellOf(latDeg: number, lonDeg: number): number {
  const x = Math.min(CLIM_W - 1, Math.floor(wrapLon(lonDeg) / CELL_DEG))
  const y = Math.min(CLIM_H - 1, Math.max(0, Math.floor((latDeg + 90) / CELL_DEG)))
  return y * CLIM_W + x
}

/** A cell's centre, degrees: [lat, lon]. */
export function cellCentre(cell: number): [number, number] {
  const y = Math.floor(cell / CLIM_W)
  const x = cell - y * CLIM_W
  return [-90 + (y + 0.5) * CELL_DEG, -180 + (x + 0.5) * CELL_DEG]
}

/** The area of a cell in row `row` (0 the southernmost), km². */
export function cellAreaKm2(row: number): number {
  const s = Math.sin((-90 + (row + 1) * CELL_DEG) * DEG) - Math.sin((-90 + row * CELL_DEG) * DEG)
  return EARTH_RADIUS_KM * EARTH_RADIUS_KM * CELL_DEG * DEG * s
}

/** Which two months' planes to mix for a time, and how much of the second:
 * linear between mid-months, so the density has no step at a month's end. */
export interface MonthBlend {
  m0: number
  m1: number
  f: number
}

export function monthBlend(tMs: number, out: MonthBlend = { m0: 0, m1: 0, f: 0 }): MonthBlend {
  const d = new Date(tMs)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth()
  const start = Date.UTC(year, month, 1)
  const days = (Date.UTC(year, month + 1, 1) - start) / 86_400_000
  const p = month + (tMs - start) / 86_400_000 / days - 0.5
  const lo = Math.floor(p)
  out.m0 = ((lo % MONTHS) + MONTHS) % MONTHS
  out.m1 = (out.m0 + 1) % MONTHS
  out.f = p - lo
  return out
}

/** The guess's seasonal factor at a latitude: high in its hemisphere's
 * summer, low in its winter, flat at the equator. */
export function seasonFactor(latDeg: number, blend: MonthBlend): number {
  // Months from mid-January (0) as a float, mid-July 6.
  const months = blend.m0 + blend.f
  const hemisphere = Math.min(1, Math.max(-1, latDeg / SEASON_FULL_LAT))
  return 1 - SEASON_AMP * hemisphere * Math.cos((2 * Math.PI * months) / MONTHS)
}

/** The guessed density (fl/km²/day) where LIS has no data. */
export function guessedDensity(latDeg: number, land: number, blend: MonthBlend): number {
  return GUESS_BASE * seasonFactor(latDeg, blend) * (1 + (GUESS_LAND_RATIO - 1) * land)
}

/** A cell's flash density at a month blend, fl/km²/day: LIS's, blended
 * toward the guess where its coverage is below 1. */
export function densityOf(clim: LightningClimatology, cell: number, blend: MonthBlend): number {
  const observed = (1 - blend.f) * clim.monthly[blend.m0][cell] + blend.f * clim.monthly[blend.m1][cell]
  const coverage = clim.coverage[cell]
  if (coverage >= 1) return observed
  const lat = -90 + (Math.floor(cell / CLIM_W) + 0.5) * CELL_DEG
  return coverage * observed + (1 - coverage) * guessedDensity(lat, clim.land[cell], blend)
}

/** The flash density at (lat, lon) at a time, fl/km²/day. */
export function flashDensityAt(clim: LightningClimatology, latDeg: number, lonDeg: number, tMs: number): number {
  return densityOf(clim, cellOf(latDeg, lonDeg), monthBlend(tMs))
}

export function landAt(clim: LightningClimatology, latDeg: number, lonDeg: number): number {
  return clim.land[cellOf(latDeg, lonDeg)]
}

/** The static clouds' alpha at (lat, lon), 0..1: the texel holding it. */
export function staticCover(clim: LightningClimatology, latDeg: number, lonDeg: number): number {
  const x = Math.min(COVER_W - 1, Math.floor((wrapLon(lonDeg) / 360) * COVER_W))
  const y = Math.min(COVER_H - 1, Math.max(0, Math.floor(((latDeg + 90) / 180) * COVER_H)))
  return clim.cover[y * COVER_W + x] / 255
}

/** The whole Earth's flash rate, fl/s, guess included: at month `month`'s
 * middle (0-11), or the year's mean when it's left out. */
export function globalFlashRate(clim: LightningClimatology, month?: number): number {
  const months = month === undefined ? [...Array(MONTHS).keys()] : [month]
  let sum = 0
  for (const m of months) {
    const blend: MonthBlend = { m0: m, m1: (m + 1) % MONTHS, f: 0 }
    for (let y = 0; y < CLIM_H; y++) {
      const area = cellAreaKm2(y)
      for (let x = 0; x < CLIM_W; x++) sum += densityOf(clim, y * CLIM_W + x, blend) * area
    }
  }
  return sum / months.length / 86_400
}

type Field = number | ((latDeg: number, lonDeg: number) => number)

export interface SyntheticClimatologyOptions {
  /** fl/km²/day at a cell's centre in a month (0-11), or one value for all. */
  density?: number | ((latDeg: number, lonDeg: number, month: number) => number)
  land?: Field
  /** LIS's coverage 0..1 at a cell's centre. */
  coverage?: Field
  /** The static clouds' alpha 0..1 at a texel's centre. */
  cover?: Field
}

/** The asset's bytes for made-up fields (tests). */
export function syntheticClimatologyBytes({ density = 0.05, land = 0.5, coverage = 1, cover = 1 }: SyntheticClimatologyOptions = {}): Uint8Array {
  const bytes = new Uint8Array(LIGHTNING_BYTES)
  const at = <T extends unknown[]>(field: number | ((...a: T) => number), ...args: T) =>
    typeof field === 'number' ? field : field(...args)
  for (let m = 0; m < MONTHS; m++) {
    for (let i = 0; i < CLIM_CELLS; i++) {
      const [lat, lon] = cellCentre(i)
      bytes[m * CLIM_CELLS + i] = encodeFlashDensity(at(density, lat, lon, m))
    }
  }
  for (let i = 0; i < CLIM_CELLS; i++) {
    const [lat, lon] = cellCentre(i)
    bytes[MONTHS * CLIM_CELLS + i] = Math.round(255 * Math.min(1, Math.max(0, at(land, lat, lon))))
    bytes[(MONTHS + 1) * CLIM_CELLS + i] = Math.round(255 * Math.min(1, Math.max(0, at(coverage, lat, lon))))
  }
  const coverBase = CLIM_PLANES * CLIM_CELLS
  for (let y = 0; y < COVER_H; y++) {
    for (let x = 0; x < COVER_W; x++) {
      const alpha = at(cover, -90 + y + 0.5, -180 + x + 0.5)
      bytes[coverBase + y * COVER_W + x] = Math.round(255 * Math.min(1, Math.max(0, alpha)))
    }
  }
  return bytes
}

/** A climatology of made-up fields, through the asset's own encoding (tests). */
export function syntheticClimatology(opts: SyntheticClimatologyOptions = {}): LightningClimatology {
  return decodeLightningClimatology(syntheticClimatologyBytes(opts))
}
