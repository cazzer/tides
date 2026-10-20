// Clouds after the latest observation, from forecast cloud cover
// (tides-kzj.4.3). Open-Meteo's hourly total cloud cover on a 10° grid says
// how much cloud there will be where; the latest geostationary image says what
// it looks like now. A forecast frame keeps the observed clouds, thinned where
// cover falls and grown where it rises, and fades towards synthetic cloud as
// the lead time grows. The synthetic cloud is the static clouds' texture
// ranked into a uniform field and thresholded to the forecast cover, so it
// covers the right fraction of each cell; it drifts with the prevailing winds
// (easterly trades, westerlies) so a long forecast doesn't sit still.
//
// The grid is one request for all 648 points, hourly from yesterday to
// FORECAST_DAYS ahead, kept for FORECAST_TTL_MS and shared by every tab;
// failures back off from FORECAST_RETRY_MS to FORECAST_RETRY_MAX_MS, while a
// stale grid serves for up to a day. Without a grid that covers the frame the
// latest observation is held, uncredited. Pure logic; the fetching is
// renderers/forecastGrid.ts and the build renderers/cloudPipeline.ts.
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
/** Half-width of the threshold that turns the ranked field into cloud. */
export const SYNTH_EDGE = 0.04
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

/** Every grid point at once, hourly, from yesterday (the latest observation
 * can be just before midnight) to FORECAST_DAYS ahead, in UTC epoch seconds. */
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
    hourly: 'cloud_cover',
    forecast_days: String(FORECAST_DAYS),
    past_days: '1',
    timeformat: 'unixtime',
  })
}

export interface CoverGrid {
  startMs: number
  hours: number
  /** Hour-major, [hour * GRID_POINTS + point], 0..1. */
  cover: Float32Array
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
 * (with the reason) when the response isn't the grid asked for. */
export function parseCoverGrid(json: unknown): CoverGrid {
  if (isRecord(json) && json.error) {
    throw new Error(`Open-Meteo error: ${typeof json.reason === 'string' ? json.reason : 'unknown'}`)
  }
  if (!Array.isArray(json)) throw new Error('not an array of locations')
  if (json.length !== GRID_POINTS) throw new Error(`${json.length} locations, not ${GRID_POINTS}`)
  let times: number[] | null = null
  const rows: unknown[][] = []
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
  })
  const hours = times!.length
  const cover = new Float32Array(hours * GRID_POINTS)
  const valid = new Uint8Array(hours * GRID_POINTS)
  let invalid = 0
  rows.forEach((values, i) => {
    for (let h = 0; h < hours; h++) {
      const v = values[h]
      if (typeof v === 'number' && v >= 0 && v <= 100) {
        cover[h * GRID_POINTS + i] = v / 100
        valid[h * GRID_POINTS + i] = 1
      } else {
        invalid++
      }
    }
  })
  if (invalid > MAX_INVALID_FRACTION * hours * GRID_POINTS) {
    throw new Error(`${invalid} of ${hours * GRID_POINTS} values missing or out of range`)
  }
  if (invalid > 0) fillInvalid(cover, valid, hours)
  return { startMs: times![0] * 1000, hours, cover }
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

/** The grid at a time, linear between hours; null outside it. */
export function coverAt(grid: CoverGrid, tMs: number): Float32Array | null {
  const f = (tMs - grid.startMs) / HOUR_MS
  if (!(f >= 0 && f <= grid.hours - 1)) return null
  const h0 = Math.floor(f)
  const h1 = Math.min(h0 + 1, grid.hours - 1)
  const w = f - h0
  const out = new Float32Array(GRID_POINTS)
  for (let i = 0; i < GRID_POINTS; i++) {
    out[i] = (1 - w) * grid.cover[h0 * GRID_POINTS + i] + w * grid.cover[h1 * GRID_POINTS + i]
  }
  return out
}

/** How far a frame has handed over to synthetic cloud at a lead time. */
export function leadWeight(leadMs: number): number {
  return 1 - Math.exp(-Math.max(0, leadMs) / FORECAST_TAU_MS)
}

/** Prevailing zonal drift (degrees of longitude per hour, east positive):
 * easterly trades within 25° of the equator, westerlies at 35-65°, smooth in
 * between and fading out towards the poles. */
export function zonalDriftDegPerHour(latDeg: number): number {
  const a = Math.abs(latDeg)
  const speed =
    a <= 25 ? -5 : a < 35 ? -5 + 15 * smoothstep(25, 35, a) : 10 * (1 - smoothstep(65, 90, a))
  const kmPerDeg = 111.32 * Math.max(Math.cos((latDeg * Math.PI) / 180), 0.2)
  return (speed * 3.6) / kmPerDeg
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

// Weight of the noise in the rank, against the blurred alpha's 0..255 per
// term: enough to order the cloudless areas (the Sahara, inland Australia)
// into cloud-like patches instead of one tie, which would fill as a sheet,
// while barely reordering the clouds themselves.
const RANK_NOISE = 24

/**
 * The static clouds' texture (one alpha byte per output pixel) as a uniform
 * rank, 0..65535: the order of a blur that keeps its cloud shapes, plus a wide
 * one and a little fixed noise to order the clear areas too. Thresholding it
 * at 1 - c covers a fraction c of the globe in cloud-shaped areas.
 */
export function structureRank(staticAlpha: ArrayLike<number>): Uint16Array {
  const fine = boxBlur(staticAlpha, OUT_W, OUT_H, 4)
  const coarse = boxBlur(staticAlpha, OUT_W, OUT_H, 32)
  const broad = valueNoise(48, 1)
  const detail = valueNoise(192, 2)
  const bins = 16384
  const max = 255 * 1.25 + RANK_NOISE
  const bin = new Uint16Array(fine.length)
  const counts = new Float64Array(bins)
  for (let p = 0; p < fine.length; p++) {
    const v = fine[p] + 0.25 * coarse[p] + RANK_NOISE * (0.6 * broad[p] + 0.4 * detail[p])
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

/** Scale from the model's cover to the satellite's cloud alpha, so synthetic
 * cloud doesn't brighten the globe: area-weighted mean alpha over mean cover,
 * clamped to CALIBRATION_RANGE. observed is RGBA (alpha in green). Worked out
 * once per observation, not per frame. */
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
 * in green), c0 and ct the grid's cover then and at the frame's time, rank
 * from structureRank, leadMs the time between them, calibration from
 * coverCalibration.
 */
export function synthesiseForecast(
  {
    observed,
    c0,
    ct,
    rank,
    leadMs,
    calibration: k,
  }: {
    observed: ArrayLike<number>
    c0: ArrayLike<number>
    ct: ArrayLike<number>
    rank: ArrayLike<number>
    leadMs: number
    calibration: number
  },
  out: Uint8ClampedArray
): void {
  const w = leadWeight(leadMs)
  const cols = Array.from({ length: OUT_W }, (_, x) => colLerp(pixelLon(x)))
  const hours = leadMs / HOUR_MS
  for (let y = 0; y < OUT_H; y++) {
    const lat = pixelLat(y)
    const row = rowLerp(lat)
    const shift = Math.round(((zonalDriftDegPerHour(lat) * hours) / 360) * OUT_W)
    const shiftMod = ((shift % OUT_W) + OUT_W) % OUT_W
    for (let x = 0, p = y * OUT_W; x < OUT_W; x++, p++) {
      const cover0 = Math.min(1, k * bilinear(c0, row, cols[x]))
      const coverT = Math.min(1, k * bilinear(ct, row, cols[x]))
      // The field moves east by shift: what's here came from shift to the west.
      const r = rank[y * OUT_W + ((x - shiftMod + OUT_W) % OUT_W)] / 65535
      const s = smoothstep(1 - coverT - SYNTH_EDGE, 1 - coverT + SYNTH_EDGE, r)
      const a = forecastAlpha(observed[p * 4 + 1] / 255, cover0, coverT, s, w)
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
 * resolves null when no usable grid covers the times asked for.
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

  return {
    async get(fromMs: number, toMs: number): Promise<CoverGrid | null> {
      if (age() >= FORECAST_TTL_MS && now() >= nextCheckAt) {
        refreshing ??= exclusive(refresh).finally(() => {
          refreshing = null
        })
        await refreshing
      }
      if (!current || age() >= FORECAST_STALE_MAX_MS) return null
      return covers(current.grid, fromMs, toMs) ? current.grid : null
    },
  }
}
