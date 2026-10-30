// Clouds after the latest observation, from forecast cloud cover
// (tides-kzj.4.3). Open-Meteo's hourly total cloud cover on a 10° grid says
// how much cloud there will be where; the latest geostationary image says what
// it looks like now. A forecast frame keeps the observed clouds, thinned where
// cover falls and grown where it rises, and fades towards synthetic cloud as
// the lead time grows. The synthetic cloud is the static clouds' texture,
// ranked and mapped onto the observation's own distribution of cloud alpha
// (so the same amount of cloud, veils and thick cloud alike), shifted up or
// down by the local change in forecast cover. It drifts with the prevailing
// winds for a day and a half (easterly trades, westerlies), then evolves by
// cross-fading to an unrelated part of the same texture and back every two
// days, so a long forecast neither sits still nor shears into streaks.
//
// The grid is one request for all 648 points, hourly from COVER_PAST_DAYS
// back to FORECAST_DAYS ahead, kept for FORECAST_TTL_MS and shared by every tab;
// failures back off from FORECAST_RETRY_MS to FORECAST_RETRY_MAX_MS, while a
// stale grid serves for up to a day. Without a grid that covers the frame the
// latest observation is held, uncredited. Pure logic; the fetching is
// renderers/forecastGrid.ts and the build renderers/cloudPipeline.ts.
//
// The same request carries the cover in three layers (tides-tvr.4.1), low
// (below ~3 km), mid (3-8 km) and high (above 8 km): what kind of cloud the
// cover is (./cloud-types.ts). A response without them still serves the
// cover, untyped.
//
// And the hour's precipitation (tides-bl3.1): rain, showers and snowfall,
// each the total over the preceding hour (so read half an hour on, the
// middle of the hour it describes), here as millimetres of water per
// hour (snowfall's centimetres of snow at 10/7 mm of water each, as
// Open-Meteo's own precipitation total counts it). Where it falls is
// ./cloud-precip.ts. It's optional too: any trouble with it leaves the grid
// dry, with the cover and the layers as they are.
import { boxBlur, FORECAST_DAYS, FORECAST_TTL_MS, HOUR_MS, OUT_H, OUT_W, smoothstep } from './real-clouds'

/** Grid point latitudes, north first, and longitudes, west first: one point
 * per 10° cell centre. Point i is row i / 36, column i % 36. */
export const GRID_LATS = Array.from({ length: 18 }, (_, i) => 85 - 10 * i)
export const GRID_LONS = Array.from({ length: 36 }, (_, i) => -180 + 10 * i)
export const GRID_POINTS = GRID_LATS.length * GRID_LONS.length

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast'
export const OPEN_METEO_SITE = 'https://open-meteo.com/'

/** How fast the frame hands over from evolved observation to synthetic cloud:
 * 1 - 1/e of the way after this lead time. */
export const FORECAST_TAU_MS = 18 * HOUR_MS
/** Synthetic cloud drifts for this long, then stays put... */
export const DRIFT_MAX_MS = 36 * HOUR_MS
/** ...and evolves by cross-fading to another part of the texture and back
 * over this period. */
export const RESAMPLE_PERIOD_MS = 48 * HOUR_MS
/** A grid with more missing or out-of-range values than this is refused. */
export const MAX_INVALID_FRACTION = 0.1
/** After a failed fetch, wait this long before asking again, doubling with
 * each further failure up to FORECAST_RETRY_MAX_MS. */
export const FORECAST_RETRY_MS = 10 * 60_000
export const FORECAST_RETRY_MAX_MS = 3 * HOUR_MS
/** A stored grid claiming to be from further in the future than this is
 * ignored (a clock that was wrong when it was stored). */
const STORED_CLOCK_SLACK_MS = 5 * 60_000
/** A grid older than this isn't used even when a fetch fails. */
export const FORECAST_STALE_MAX_MS = 24 * HOUR_MS
/** Bounds on scaling the model's cover to the satellite's cloud alpha. */
export const CALIBRATION_RANGE = [0.4, 1.2] as const

/** Days of past hours the grid asks for: yesterday for the latest
 * observation (it can be just before midnight), and the day before so the
 * cloud types (tides-tvr.4.1) still cover yesterday's frames through a day of
 * a stale grid. */
export const COVER_PAST_DAYS = 2
/** The hourly variables asked for: instantaneous total cover, then its low,
 * mid and high layers, then the hour's rain, showers and snowfall. */
export const COVER_VARIABLES = [
  'cloud_cover',
  'cloud_cover_low',
  'cloud_cover_mid',
  'cloud_cover_high',
  'rain',
  'showers',
  'snowfall',
] as const
const LAYER_VARIABLES = { low: 'cloud_cover_low', mid: 'cloud_cover_mid', high: 'cloud_cover_high' } as const
const PRECIP_VARIABLES = { rain: 'rain', showers: 'showers', snow: 'snowfall' } as const
/** Millimetres of water in a centimetre of snowfall, as Open-Meteo counts it
 * (its precipitation is rain + showers + snowfall * 10/7). */
export const SNOW_CM_TO_MM = 10 / 7
/** Rain and showers (mm) and snowfall (cm) in an hour above this, or below
 * zero, are gaps. */
export const PRECIP_VALID_MAX = 500

/** Every grid point at once, hourly, from COVER_PAST_DAYS back to
 * FORECAST_DAYS ahead, in UTC epoch seconds: total cover, its layers, and the
 * hour's rain, showers and snowfall. */
export function coverRequestBody(): URLSearchParams {
  const lats: number[] = []
  const lons: number[] = []
  for (const lat of GRID_LATS) {
    for (const lon of GRID_LONS) {
      lats.push(lat)
      lons.push(lon)
    }
  }
  return new URLSearchParams({
    latitude: lats.join(','),
    longitude: lons.join(','),
    hourly: COVER_VARIABLES.join(','),
    forecast_days: String(FORECAST_DAYS),
    past_days: String(COVER_PAST_DAYS),
    timeformat: 'unixtime',
  })
}

/** Cloud cover by layer, each laid out like CoverGrid.cover. */
export interface CoverLayers {
  low: Float32Array
  mid: Float32Array
  high: Float32Array
}

/** The hour's precipitation by kind, each laid out like CoverGrid.cover but
 * in mm of water per hour (snow as its water). */
export interface CoverPrecip {
  rain: Float32Array
  showers: Float32Array
  snow: Float32Array
}

/** Precipitation at a point, mm of water per hour. */
export interface PrecipRate {
  rain: number
  showers: number
  snow: number
}

export interface CoverGrid {
  startMs: number
  hours: number
  /** Hour-major, [hour * GRID_POINTS + point], 0..1. */
  cover: Float32Array
  /** The cover's low, mid and high layers; null when the response lacks any
   * of them or has too many gaps in one (the grid is then untyped). */
  layers: CoverLayers | null
  /** The hour's rain, showers and snow; null when the response lacks any of
   * them or has too many gaps in one (the grid is then dry). */
  precip: CoverPrecip | null
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Degrees between two longitudes, the short way round. */
function lonGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return Math.min(d, 360 - d)
}

/** Validates Open-Meteo's multi-location response into a grid. Missing or
 * out-of-range values are filled with their row's mean at that hour; throws
 * (with the reason) when the response isn't the grid asked for. The layers
 * and the precipitation are optional: any trouble with the layers leaves the
 * grid untyped instead, with the precipitation dry, each apart. */
export function parseCoverGrid(json: unknown): CoverGrid {
  if (isRecord(json) && json.error) {
    throw new Error(`Open-Meteo error: ${typeof json.reason === 'string' ? json.reason : 'unknown'}`)
  }
  if (!Array.isArray(json)) throw new Error('not an array of locations')
  if (json.length !== GRID_POINTS) throw new Error(`${json.length} locations, not ${GRID_POINTS}`)
  let times: number[] | null = null
  const rows: unknown[][] = []
  // Per optional variable, the values of every point that has them whole: a
  // group is usable when each of its variables has every point's.
  const optionalRows: Record<string, unknown[][]> = {}
  for (const name of [...Object.values(LAYER_VARIABLES), ...Object.values(PRECIP_VARIABLES)]) {
    optionalRows[name] = []
  }
  json.forEach((point: unknown, i) => {
    if (!isRecord(point)) throw new Error(`location ${i} is not an object`)
    const lat = GRID_LATS[Math.floor(i / GRID_LONS.length)]
    const lon = GRID_LONS[i % GRID_LONS.length]
    // Open-Meteo snaps to its model's grid, so near rather than equal; this
    // also checks the order.
    if (
      typeof point.latitude !== 'number' ||
      typeof point.longitude !== 'number' ||
      !(Math.abs(point.latitude - lat) <= 2) ||
      !(lonGap(point.longitude, lon) <= 2)
    ) {
      throw new Error(`location ${i} is not near ${lat},${lon}`)
    }
    const hourly = point.hourly
    if (!isRecord(hourly) || !Array.isArray(hourly.time) || !Array.isArray(hourly.cloud_cover)) {
      throw new Error(`location ${i} has no hourly cloud_cover`)
    }
    const time = hourly.time as unknown[]
    if (times === null) {
      if (time.length < 24) throw new Error(`only ${time.length} hours`)
      if (!time.every((t): t is number => typeof t === 'number' && Number.isFinite(t))) {
        throw new Error('non-numeric times')
      }
      for (let h = 1; h < time.length; h++) {
        if (time[h] - time[h - 1] !== 3600) throw new Error('times are not hourly')
      }
      times = time
    } else if (time.length !== times.length || time[0] !== times[0]) {
      throw new Error(`location ${i} has different times`)
    }
    if (hourly.cloud_cover.length !== time.length) {
      throw new Error(`location ${i} has ${hourly.cloud_cover.length} values for ${time.length} hours`)
    }
    rows.push(hourly.cloud_cover as unknown[])
    for (const name of Object.keys(optionalRows)) {
      const values = hourly[name]
      if (Array.isArray(values) && values.length === time.length) optionalRows[name].push(values as unknown[])
    }
  })
  const hours = times!.length
  const cover = valueGrid(rows, hours, 100, 1 / 100)
  if (typeof cover === 'string') throw new Error(cover)
  const group = (names: string[], max: number, scales: number[]): Float32Array[] | string => {
    const missing = names.find((name) => optionalRows[name].length !== GRID_POINTS)
    if (missing) return `${missing} missing at ${GRID_POINTS - optionalRows[missing].length} locations`
    const grids = names.map((name, k) => valueGrid(optionalRows[name], hours, max, scales[k]))
    return grids.find((g): g is string => typeof g === 'string') ?? (grids as Float32Array[])
  }
  let layers: CoverLayers | null = null
  const layerGrids = group(Object.values(LAYER_VARIABLES), 100, [1 / 100, 1 / 100, 1 / 100])
  if (typeof layerGrids === 'string') console.warn('[clouds] cloud cover layers unusable; untyped', layerGrids)
  else layers = { low: layerGrids[0], mid: layerGrids[1], high: layerGrids[2] }
  let precip: CoverPrecip | null = null
  const precipGrids = group(Object.values(PRECIP_VARIABLES), PRECIP_VALID_MAX, [1, 1, SNOW_CM_TO_MM])
  if (typeof precipGrids === 'string') console.warn('[clouds] precipitation unusable; dry', precipGrids)
  else precip = { rain: precipGrids[0], showers: precipGrids[1], snow: precipGrids[2] }
  return { startMs: times![0] * 1000, hours, cover, layers, precip }
}

/** Values, one row per point, valid from 0 to max, as an hour-major grid
 * times scale with the gaps filled; the reason instead when there are too
 * many gaps. */
function valueGrid(rows: unknown[][], hours: number, max: number, scale: number): Float32Array | string {
  const grid = new Float32Array(hours * GRID_POINTS)
  const valid = new Uint8Array(hours * GRID_POINTS)
  let invalid = 0
  rows.forEach((values, i) => {
    for (let h = 0; h < hours; h++) {
      const v = values[h]
      if (typeof v === 'number' && v >= 0 && v <= max) {
        grid[h * GRID_POINTS + i] = v * scale
        valid[h * GRID_POINTS + i] = 1
      } else {
        invalid++
      }
    }
  })
  if (invalid > MAX_INVALID_FRACTION * hours * GRID_POINTS) {
    return `${invalid} of ${hours * GRID_POINTS} values missing or out of range`
  }
  if (invalid > 0) fillInvalid(grid, valid, hours)
  return grid
}

/** Each invalid value becomes its row's mean at that hour, or the hour's
 * global mean where the whole row is missing. */
function fillInvalid(cover: Float32Array, valid: Uint8Array, hours: number) {
  const cols = GRID_LONS.length
  for (let h = 0; h < hours; h++) {
    const o = h * GRID_POINTS
    let globalSum = 0
    let globalCount = 0
    for (let i = 0; i < GRID_POINTS; i++) {
      if (!valid[o + i]) continue
      globalSum += cover[o + i]
      globalCount++
    }
    const globalMean = globalCount ? globalSum / globalCount : 0.5
    for (let row = 0; row < GRID_LATS.length; row++) {
      let sum = 0
      let count = 0
      for (let c = 0; c < cols; c++) {
        if (!valid[o + row * cols + c]) continue
        sum += cover[o + row * cols + c]
        count++
      }
      const mean = count ? sum / count : globalMean
      for (let c = 0; c < cols; c++) if (!valid[o + row * cols + c]) cover[o + row * cols + c] = mean
    }
  }
}

/** Whether a time is within the grid's hours. */
export function gridCovers(grid: CoverGrid, tMs: number): boolean {
  const f = (tMs - grid.startMs) / HOUR_MS
  return f >= 0 && f <= grid.hours - 1
}

/** One of the grid's hour-major arrays at a time, linear between hours. */
function valuesAt(grid: CoverGrid, values: Float32Array, tMs: number): Float32Array | null {
  if (!gridCovers(grid, tMs)) return null
  const f = (tMs - grid.startMs) / HOUR_MS
  const h0 = Math.floor(f)
  const h1 = Math.min(h0 + 1, grid.hours - 1)
  const w = f - h0
  const out = new Float32Array(GRID_POINTS)
  for (let i = 0; i < GRID_POINTS; i++) {
    out[i] = (1 - w) * values[h0 * GRID_POINTS + i] + w * values[h1 * GRID_POINTS + i]
  }
  return out
}

/** The grid at a time, linear between hours; null outside it. */
export function coverAt(grid: CoverGrid, tMs: number): Float32Array | null {
  return valuesAt(grid, grid.cover, tMs)
}

/** The layers at a time, linear between hours; null outside the grid or
 * without layers. */
export function layersAt(grid: CoverGrid, tMs: number): CoverLayers | null {
  if (!grid.layers || !gridCovers(grid, tMs)) return null
  return {
    low: valuesAt(grid, grid.layers.low, tMs)!,
    mid: valuesAt(grid, grid.layers.mid, tMs)!,
    high: valuesAt(grid, grid.layers.high, tMs)!,
  }
}

/** The precipitation at a time, linear between hours. Each hour's value is
 * the total over the hour before it, so it is read half an hour on, in the
 * middle of the hour it describes: null where that is outside the grid (its
 * first half hour and its last hour), or without precipitation. */
export function precipitationAt(grid: CoverGrid, tMs: number): CoverPrecip | null {
  const at = tMs + HOUR_MS / 2
  if (!grid.precip || !gridCovers(grid, at)) return null
  return {
    rain: valuesAt(grid, grid.precip.rain, at)!,
    showers: valuesAt(grid, grid.precip.showers, at)!,
    snow: valuesAt(grid, grid.precip.snow, at)!,
  }
}

/** The precipitation at a point and time (sampleCoverSmooth between cell
 * centres); null outside the grid or without it. */
export function precipAt(grid: CoverGrid, latDeg: number, lonDeg: number, tMs: number): PrecipRate | null {
  const p = precipitationAt(grid, tMs)
  if (!p) return null
  return {
    rain: sampleCoverSmooth(p.rain, latDeg, lonDeg),
    showers: sampleCoverSmooth(p.showers, latDeg, lonDeg),
    snow: sampleCoverSmooth(p.snow, latDeg, lonDeg),
  }
}

/** How far a frame has handed over to synthetic cloud at a lead time. */
export function leadWeight(leadMs: number): number {
  return 1 - Math.exp(-Math.max(0, leadMs) / FORECAST_TAU_MS)
}

/** Prevailing zonal drift (degrees of longitude per hour, east positive):
 * easterly trades near the equator turning gently into westerlies by 45°,
 * fading out towards the poles. Gentle, so neighbouring latitudes don't
 * shear apart. */
export function zonalDriftDegPerHour(latDeg: number): number {
  const a = Math.abs(latDeg)
  const speed = (-4 + 11 * smoothstep(5, 45, a)) * (1 - smoothstep(45, 80, a))
  const kmPerDeg = 111.32 * Math.max(Math.cos((latDeg * Math.PI) / 180), 0.2)
  return (speed * 3.6) / kmPerDeg
}

/** How far (output pixels, east positive) the synthetic cloud has drifted
 * at a latitude after a lead time: never more than DRIFT_MAX_MS's worth. */
export function driftPx(latDeg: number, leadMs: number): number {
  const hours = Math.min(Math.max(0, leadMs), DRIFT_MAX_MS) / HOUR_MS
  return (zonalDriftDegPerHour(latDeg) * hours * OUT_W) / 360
}

/** 0..1: how far the synthetic cloud has cross-faded to its second sampling. */
export function resampleWeight(leadMs: number): number {
  if (leadMs <= DRIFT_MAX_MS) return 0
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * (leadMs - DRIFT_MAX_MS)) / RESAMPLE_PERIOD_MS)
}

/** (1 - b) u1 + b u2 for independent uniform u1, u2, made uniform again (its
 * CDF), so a cross-faded rank is still a rank. */
export function mixUniform(u1: number, u2: number, b: number): number {
  const t = (1 - b) * u1 + b * u2
  const lo = Math.min(b, 1 - b)
  const hi = 1 - lo
  if (lo < 1e-6) return t
  if (t <= lo) return (t * t) / (2 * lo * hi)
  if (t >= hi) return 1 - ((1 - t) * (1 - t)) / (2 * lo * hi)
  return (t - lo / 2) / hi
}

interface Lerp {
  i0: number
  i1: number
  w: number
}

/** Grid rows either side of a latitude, clamped beyond the outer rows. */
function rowLerp(latDeg: number): Lerp {
  const last = GRID_LATS.length - 1
  const f = Math.min(last, Math.max(0, (GRID_LATS[0] - latDeg) / 10))
  const i0 = Math.min(last - 1, Math.floor(f))
  return { i0, i1: i0 + 1, w: f - i0 }
}

/** Grid columns either side of a longitude, wrapping across 180°. */
function colLerp(lonDeg: number): Lerp {
  const cols = GRID_LONS.length
  const f = (((lonDeg - GRID_LONS[0]) / 10) % cols + cols) % cols
  const i0 = Math.floor(f)
  return { i0, i1: (i0 + 1) % cols, w: f - i0 }
}

function bilinear(values: ArrayLike<number>, row: Lerp, col: Lerp): number {
  const cols = GRID_LONS.length
  const top = values[row.i0 * cols + col.i0] * (1 - col.w) + values[row.i0 * cols + col.i1] * col.w
  const bottom = values[row.i1 * cols + col.i0] * (1 - col.w) + values[row.i1 * cols + col.i1] * col.w
  return top * (1 - row.w) + bottom * row.w
}

/** A grid's value at a point, bilinear between cell centres. */
export function sampleCover(values: ArrayLike<number>, latDeg: number, lonDeg: number): number {
  return bilinear(values, rowLerp(latDeg), colLerp(lonDeg))
}

const smoothLerp = ({ i0, i1, w }: Lerp): Lerp => ({ i0, i1, w: smoothstep(0, 1, w) })

/** sampleCover with smoothstep weights: still continuous and through the
 * cell centres, but flat at them, so a 10° grid resampled finely shows no
 * creases along its rows and columns (the cloud types, tides-tvr.4.1). */
export function sampleCoverSmooth(values: ArrayLike<number>, latDeg: number, lonDeg: number): number {
  return bilinear(values, smoothLerp(rowLerp(latDeg)), smoothLerp(colLerp(lonDeg)))
}

const pixelLat = (y: number) => 90 - ((y + 0.5) / OUT_H) * 180
const pixelLon = (x: number) => -180 + ((x + 0.5) / OUT_W) * 360

/** Deterministic lattice value in 0..1. */
function latticeValue(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

/** Smooth value noise over the output image, cells x cells / 2 lattice
 * squares, wrapping in longitude; 0..1. */
function valueNoise(cells: number, seed: number): Float32Array {
  const rows = cells / 2
  const out = new Float32Array(OUT_W * OUT_H)
  for (let y = 0; y < OUT_H; y++) {
    const fy = (y / OUT_H) * rows
    const iy = Math.floor(fy)
    const ty = smoothstep(0, 1, fy - iy)
    for (let x = 0; x < OUT_W; x++) {
      const fx = (x / OUT_W) * cells
      const ix = Math.floor(fx)
      const tx = smoothstep(0, 1, fx - ix)
      const ix1 = (ix + 1) % cells
      const top = latticeValue(ix, iy, seed) * (1 - tx) + latticeValue(ix1, iy, seed) * tx
      const bottom = latticeValue(ix, iy + 1, seed) * (1 - tx) + latticeValue(ix1, iy + 1, seed) * tx
      out[y * OUT_W + x] = top * (1 - ty) + bottom * ty
    }
  }
  return out
}

// Weight of the noise in the rank, in alpha levels: a tie-break. It orders
// the static texture's flat, cloudless areas (the Sahara, inland Australia)
// into cloud-like patches instead of one tie, which would fill as a sheet,
// and barely reorders anything with texture.
const RANK_NOISE = 3

/**
 * The static clouds' texture (one alpha byte per output pixel) as a uniform
 * rank, 0..65535: its own order, lightly smoothed so it keeps its fine
 * texture, with fixed noise to break ties.
 */
export function structureRank(staticAlpha: ArrayLike<number>): Uint16Array {
  const fine = boxBlur(staticAlpha, OUT_W, OUT_H, 1)
  const noise = [valueNoise(48, 1), valueNoise(192, 2), valueNoise(768, 3)]
  const bins = 65536
  const max = 255 + RANK_NOISE
  const bin = new Uint16Array(fine.length)
  const counts = new Float64Array(bins)
  for (let p = 0; p < fine.length; p++) {
    const n = 0.5 * noise[0][p] + 0.3 * noise[1][p] + 0.2 * noise[2][p]
    const v = fine[p] + RANK_NOISE * n
    bin[p] = Math.min(bins - 1, Math.floor((v / max) * bins))
    counts[bin[p]]++
  }
  // Each bin maps to the middle of its share of the pixels.
  const level = new Uint16Array(bins)
  for (let b = 0, below = 0; b < bins; b++) {
    level[b] = Math.round((65535 * (below + counts[b] / 2)) / fine.length)
    below += counts[b]
  }
  const rank = new Uint16Array(fine.length)
  for (let p = 0; p < rank.length; p++) rank[p] = level[bin[p]]
  return rank
}

/** Entries in alphaQuantiles' table. */
const QUANTILES = 1024

/**
 * The observation's cloud alpha by quantile, area-weighted: entry i is the
 * alpha (0..255) that a fraction i / (QUANTILES - 1) of the globe is below.
 * Mapping a uniform rank through it gives cloud with the observation's mean
 * and its mix of clear sky, veils and thick cloud. observed is RGBA (alpha in
 * green).
 */
export function alphaQuantiles(observed: ArrayLike<number>): Float32Array {
  const hist = new Float64Array(256)
  for (let y = 0; y < OUT_H; y++) {
    const weight = Math.cos((pixelLat(y) * Math.PI) / 180)
    for (let x = 0, i = y * OUT_W * 4 + 1; x < OUT_W; x++, i += 4) hist[observed[i]] += weight
  }
  const total = hist.reduce((a, b) => a + b, 0)
  const table = new Float32Array(QUANTILES)
  // Each level's share spreads evenly over [level - 0.5, level + 0.5].
  let g = 0
  let below = 0
  for (let i = 0; i < QUANTILES; i++) {
    const u = (i / (QUANTILES - 1)) * total
    while (g < 255 && (hist[g] === 0 || below + hist[g] < u)) below += hist[g++]
    const within = hist[g] > 0 ? (u - below) / hist[g] : 0.5
    table[i] = Math.min(255, Math.max(0, g - 0.5 + within))
  }
  return table
}

function quantileAt(table: Float32Array, u: number): number {
  const f = Math.min(1, Math.max(0, u)) * (QUANTILES - 1)
  const i = Math.min(QUANTILES - 2, Math.floor(f))
  return table[i] + (table[i + 1] - table[i]) * (f - i)
}

/**
 * Forecast cloud alpha (0..1) for a pixel: observed alpha a0 under cover c0,
 * scaled down where the forecast cover ct is less, and grown into the
 * synthetic cloud s where it's more; then w of the way to s alone.
 */
export function forecastAlpha(a0: number, c0: number, ct: number, s: number, w: number): number {
  let observed: number
  if (ct <= c0) observed = c0 < 0.01 ? a0 : (a0 * ct) / c0
  else observed = a0 + ((1 - a0) * s * (ct - c0)) / (1 - c0)
  return (1 - w) * observed + w * s
}

/** Scale from the model's cover to the satellite's cloud alpha (how much a
 * change in cover changes the cloud): area-weighted mean alpha over mean
 * cover, clamped to CALIBRATION_RANGE. observed is RGBA (alpha in green).
 * Worked out once per observation, not per frame. */
export function coverCalibration(observed: ArrayLike<number>, c0: ArrayLike<number>): number {
  let alpha = 0
  let cover = 0
  for (let y = 0; y < OUT_H; y++) {
    const lat = pixelLat(y)
    const weight = Math.cos((lat * Math.PI) / 180)
    const row = rowLerp(lat)
    let rowAlpha = 0
    let rowCover = 0
    // Every 8th column is plenty for a global mean.
    for (let x = 0; x < OUT_W; x += 8) {
      rowAlpha += observed[(y * OUT_W + x) * 4 + 1] / 255
      rowCover += bilinear(c0, row, colLerp(pixelLon(x)))
    }
    alpha += weight * rowAlpha
    cover += weight * rowCover
  }
  if (cover < 1e-6) return 1
  return Math.min(CALIBRATION_RANGE[1], Math.max(CALIBRATION_RANGE[0], alpha / cover))
}

/**
 * Writes a forecast frame into out (RGBA, top row first, alpha in green, no
 * heights). observed is the latest observation's RGBA (top row first, alpha
 * in green), quantiles its alphaQuantiles, c0 and ct the grid's cover then
 * and at the frame's time, rank from structureRank, leadMs the time between
 * them, calibration from coverCalibration.
 */
export function synthesiseForecast(
  {
    observed,
    quantiles,
    c0,
    ct,
    rank,
    leadMs,
    calibration: k,
  }: {
    observed: ArrayLike<number>
    quantiles: Float32Array
    c0: ArrayLike<number>
    ct: ArrayLike<number>
    rank: ArrayLike<number>
    leadMs: number
    calibration: number
  },
  out: Uint8ClampedArray
): void {
  const w = leadWeight(leadMs)
  const b = resampleWeight(leadMs)
  const cols = Array.from({ length: OUT_W }, (_, x) => colLerp(pixelLon(x)))
  for (let y = 0; y < OUT_H; y++) {
    const lat = pixelLat(y)
    const row = rowLerp(lat)
    const shift = Math.round(driftPx(lat, leadMs))
    const shiftMod = ((shift % OUT_W) + OUT_W) % OUT_W
    // The second sampling: half way round the globe and mirrored north-south.
    const rowB = (OUT_H - 1 - y) * OUT_W
    for (let x = 0, p = y * OUT_W; x < OUT_W; x++, p++) {
      const c0k = k * bilinear(c0, row, cols[x])
      const ctk = k * bilinear(ct, row, cols[x])
      // The field moves east by shift: what's here came from shift to the west.
      const from = (x - shiftMod + OUT_W) % OUT_W
      const ra = rank[y * OUT_W + from] / 65535
      const q = b > 0 ? mixUniform(ra, rank[rowB + ((from + OUT_W / 2) % OUT_W)] / 65535, b) : ra
      const s = quantileAt(quantiles, q + ctk - c0k) / 255
      const a = forecastAlpha(observed[p * 4 + 1] / 255, Math.min(1, c0k), Math.min(1, ctk), s, w)
      const i = p * 4
      out[i] = 0
      out[i + 1] = Math.round(255 * a)
      out[i + 2] = 0
      out[i + 3] = 255
    }
  }
}

/** Consecutive failed fetches and when the next may be tried. */
export interface FetchBackoff {
  failures: number
  retryAt: number
}

export interface CoverGridDeps {
  fetchJson: () => Promise<unknown>
  readStored: () => Promise<{ fetchedAt: number; body: unknown } | null>
  writeStored: (fetchedAt: number, body: unknown) => Promise<void>
  /** Backoff is stored too, so a reload doesn't retry a failing fetch at once. */
  readBackoff: () => Promise<FetchBackoff | null>
  writeBackoff: (backoff: FetchBackoff | null) => Promise<void>
  /** Runs fn holding a lock shared by every tab, so they take turns. */
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>
  now: () => number
}

/** How long to wait after the nth failure in a row. */
export function retryDelayMs(failures: number): number {
  return Math.min(FORECAST_RETRY_MAX_MS, FORECAST_RETRY_MS * 2 ** Math.max(0, failures - 1))
}

/**
 * The cover grid, fetched at most once per FORECAST_TTL_MS across tabs: from
 * memory, else from storage, else one fetch. Storage is re-read under a lock
 * shared by every tab right before fetching, so a grid another tab just
 * fetched is used instead. Failures back off exponentially (stored);
 * meanwhile a stale grid serves if it is under FORECAST_STALE_MAX_MS old. get
 * resolves null when no usable grid covers the times asked for. peek never
 * waits on the network: whatever grid is to hand (in memory, else stored),
 * with any refresh due started in the background.
 */
export function createCoverGridSource(deps: CoverGridDeps) {
  const { fetchJson, readStored, writeStored, readBackoff, writeBackoff, exclusive, now } = deps
  let current: { grid: CoverGrid; fetchedAt: number } | null = null
  let refreshing: Promise<void> | null = null
  // Not before this (wall clock): a failed fetch is backing off.
  let nextCheckAt = -Infinity

  const covers = (grid: CoverGrid, fromMs: number, toMs: number) =>
    grid.startMs <= fromMs && toMs <= grid.startMs + (grid.hours - 1) * HOUR_MS
  const age = () => (current ? now() - current.fetchedAt : Infinity)

  async function adoptStored() {
    let stored: { fetchedAt: number; body: unknown } | null
    try {
      stored = await readStored()
    } catch (err) {
      console.warn('[clouds] no stored cloud cover forecast', err)
      return
    }
    if (!stored || !Number.isFinite(stored.fetchedAt)) return
    if (stored.fetchedAt > now() + STORED_CLOCK_SLACK_MS) return
    if (current && stored.fetchedAt <= current.fetchedAt) return
    try {
      current = { grid: parseCoverGrid(stored.body), fetchedAt: stored.fetchedAt }
    } catch (err) {
      console.warn('[clouds] ignoring the stored cloud cover forecast', err)
    }
  }

  async function backoff(): Promise<FetchBackoff | null> {
    try {
      return await readBackoff()
    } catch {
      return null
    }
  }

  async function refresh() {
    await adoptStored()
    if (age() < FORECAST_TTL_MS) return
    const failed = await backoff()
    if (failed && failed.retryAt > now() + FORECAST_RETRY_MAX_MS) {
      // Stored by a clock that was wrong: bounded, and stored so, or the
      // bound would move along with the clock.
      failed.retryAt = now() + FORECAST_RETRY_MAX_MS
      await writeBackoff(failed).catch(() => {})
    }
    if (failed && now() < failed.retryAt) {
      nextCheckAt = failed.retryAt
      return
    }
    try {
      const body = await fetchJson()
      const grid = parseCoverGrid(body)
      const fetchedAt = now()
      current = { grid, fetchedAt }
      await Promise.all([writeStored(fetchedAt, body), failed && writeBackoff(null)]).catch(
        (err: unknown) => console.warn('[clouds] could not store the cloud cover forecast', err)
      )
    } catch (err) {
      const failures = (failed?.failures ?? 0) + 1
      nextCheckAt = now() + retryDelayMs(failures)
      console.warn('[clouds] fetching the cloud cover forecast failed', err)
      await writeBackoff({ failures, retryAt: nextCheckAt }).catch(() => {})
    }
  }

  /** The refresh under way, or a new one if one is due; null if neither. */
  function startRefresh(): Promise<void> | null {
    if (age() >= FORECAST_TTL_MS && now() >= nextCheckAt) {
      refreshing ??= exclusive(refresh).finally(() => {
        refreshing = null
      })
    }
    return refreshing
  }

  const usable = (fromMs: number, toMs: number) =>
    current && age() < FORECAST_STALE_MAX_MS && covers(current.grid, fromMs, toMs) ? current.grid : null

  return {
    async get(fromMs: number, toMs: number): Promise<CoverGrid | null> {
      if (age() >= FORECAST_TTL_MS && now() >= nextCheckAt) await startRefresh()
      return usable(fromMs, toMs)
    },
    async peek(fromMs: number, toMs: number): Promise<CoverGrid | null> {
      // Storage is local, so worth the wait when there's nothing in memory;
      // the lock (another tab's fetch may hold it) and the network aren't.
      if (!current) await adoptStored()
      startRefresh()?.catch(() => {})
      return usable(fromMs, toMs)
    },
  }
}
