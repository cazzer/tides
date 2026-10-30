// Live wave directions (tides-nh8.4): which way the sea runs now, from
// Open-Meteo's Marine API (Météo-France MFWAM, as the baked climate), so the
// drawn waves (renderers/water.ts aimWaves()) follow today's swell rather
// than the year's. One request for the current dominant, wind-wave and swell
// directions on a 15 deg grid (LIVE_ROWS x LIVE_COLS cell centres, south to
// 80 S where MFWAM stops: the API counts each location as a call, and a
// swell's direction holds over a thousand kilometres), kept for
// LIVE_WAVES_TTL_MS and shared by every tab; failures back off from
// LIVE_WAVES_RETRY_MS to LIVE_WAVES_RETRY_MAX_MS. Each of the baked climate's
// 7.5 deg texels takes its headings' angles from the live points round it
// (bilinear, the land's nulls left out), keeping its own length (how settled
// it runs, which one moment's direction can't say), and only while the real
// weather is shown and the clock is within LIVE_WAVES_WINDOW_MS of the
// directions' time: otherwise, and offline, the baked climate. Pure logic;
// the fetching is renderers/liveWaveGrid.ts.
import { CLIMATE_COLS, texelLat, texelLon, type ClimateCell } from './renderers/waterClimateLayout'

const HOUR_MS = 3_600_000

export const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine'
export const MARINE_MODEL = 'meteofrance_wave'
/** The current variables asked for: where the dominant waves, the wind
 * waves and the swell come from (compass degrees). */
export const LIVE_WAVE_VARIABLES = ['wave_direction', 'wind_wave_direction', 'swell_wave_direction'] as const
export const LIVE_WAVES_TTL_MS = 3 * HOUR_MS
export const LIVE_WAVES_RETRY_MS = 10 * 60_000
export const LIVE_WAVES_RETRY_MAX_MS = 3 * HOUR_MS
/** How far the clock may be from the directions' time for them to serve. */
export const LIVE_WAVES_WINDOW_MS = 3 * HOUR_MS
/** A stored grid claiming a fetch further in the future than this is ignored. */
const STORED_CLOCK_SLACK_MS = 5 * 60_000

/** The live grid: 15 deg cell centres, rows from 82.5 N to 67.5 S (the next,
 * 82.5 S, is past MFWAM's grid), columns from 172.5 W east. Point i is row
 * i / LIVE_COLS, column i % LIVE_COLS. */
export const LIVE_STEP = 15
export const LIVE_ROWS = 11
export const LIVE_COLS = 24
export const LIVE_POINTS = LIVE_ROWS * LIVE_COLS
export const liveLat = (row: number) => 90 - LIVE_STEP * (row + 0.5)
export const liveLon = (col: number) => -180 + LIVE_STEP * (col + 0.5)
/** A response with fewer sea points than this is refused (about 150 are). */
export const LIVE_WAVES_MIN_SEA = 80

/** Every live point's current directions, in UTC epoch seconds. */
export function waveRequestBody(): URLSearchParams {
  const points = Array.from({ length: LIVE_POINTS }, (_, i) => i)
  return new URLSearchParams({
    latitude: points.map((i) => liveLat(Math.floor(i / LIVE_COLS))).join(','),
    longitude: points.map((i) => liveLon(i % LIVE_COLS)).join(','),
    current: LIVE_WAVE_VARIABLES.join(','),
    models: MARINE_MODEL,
    timeformat: 'unixtime',
  })
}

/** The live directions by point (NaN where unknown: land, ice), and their
 * time. */
export interface LiveWaveGrid {
  timeMs: number
  wave: Float32Array
  wind: Float32Array
  swell: Float32Array
}

/** The Marine API's answer to waveRequestBody() as a grid; throws on one
 * that doesn't answer it (the wrong count, a location off its point, too
 * little sea, no time). */
export function parseWaveGrid(json: unknown): LiveWaveGrid {
  if (!Array.isArray(json) || json.length !== LIVE_POINTS) throw new Error(`live waves: expected ${LIVE_POINTS} locations`)
  const blank = () => new Float32Array(LIVE_POINTS).fill(NaN)
  const grid = { wave: blank(), wind: blank(), swell: blank() }
  const times: number[] = []
  let sea = 0
  json.forEach((location: unknown, i) => {
    const { latitude, longitude, current } = (location ?? {}) as { latitude?: unknown; longitude?: unknown; current?: Record<string, unknown> }
    const lat = liveLat(Math.floor(i / LIVE_COLS))
    const lon = liveLon(i % LIVE_COLS)
    if (typeof latitude !== 'number' || typeof longitude !== 'number') throw new Error(`live waves: location ${i} has no place`)
    if (Math.abs(latitude - lat) > 1 || Math.abs(((longitude - lon + 540) % 360) - 180) > 1) {
      throw new Error(`live waves: location ${i} answered for ${latitude},${longitude}, asked ${lat},${lon}`)
    }
    if (!current) return
    const read = (name: string) => {
      const v = current[name]
      return typeof v === 'number' && Number.isFinite(v) ? v : NaN
    }
    grid.wave[i] = read('wave_direction')
    grid.wind[i] = read('wind_wave_direction')
    grid.swell[i] = read('swell_wave_direction')
    if (Number.isFinite(grid.wave[i])) sea++
    if (typeof current.time === 'number' && Number.isFinite(current.time)) times.push(current.time)
  })
  if (sea < LIVE_WAVES_MIN_SEA) throw new Error(`live waves: only ${sea} sea points`)
  if (times.length === 0) throw new Error('live waves: no time')
  return { timeMs: Math.max(...times) * 1000, ...grid }
}

/** The unit heading (cos, sin; where the waves go) of `from`'s live
 * directions bilinear at a lat/lon, the unknown points left out; null where
 * all four are. */
function liveHeading(from: Float32Array, lat: number, lon: number): [number, number] | null {
  const x = (lon + 180) / LIVE_STEP - 0.5
  const y = Math.min(Math.max((90 - lat) / LIVE_STEP - 0.5, 0), LIVE_ROWS - 1)
  const i = Math.floor(x)
  const j = Math.min(Math.floor(y), LIVE_ROWS - 2)
  const fx = x - i
  const fy = y - j
  let c = 0
  let s = 0
  for (const [col, row, weight] of [[i, j, (1 - fx) * (1 - fy)], [i + 1, j, fx * (1 - fy)], [i, j + 1, (1 - fx) * fy], [i + 1, j + 1, fx * fy]]) {
    const deg = from[row * LIVE_COLS + (((col % LIVE_COLS) + LIVE_COLS) % LIVE_COLS)]
    if (!Number.isFinite(deg) || weight === 0) continue
    const toward = ((deg + 180) * Math.PI) / 180
    c += weight * Math.cos(toward)
    s += weight * Math.sin(toward)
  }
  const length = Math.hypot(c, s)
  return length > 1e-6 ? [c / length, s / length] : null
}

/** The climate with each texel's headings turned the live way where the
 * points round it know it, each keeping its baked length. */
export function liveClimate(baked: readonly ClimateCell[], grid: LiveWaveGrid): ClimateCell[] {
  return baked.map((cell, k) => {
    const lat = texelLat(Math.floor(k / CLIMATE_COLS))
    const lon = texelLon(k % CLIMATE_COLS)
    const out = { ...cell }
    const turn = (cos: number, sin: number, from: Float32Array): [number, number] => {
      const live = liveHeading(from, lat, lon)
      const length = Math.hypot(cos, sin)
      return live ? [live[0] * length, live[1] * length] : [cos, sin]
    }
    ;[out.waveCos, out.waveSin] = turn(cell.waveCos, cell.waveSin, grid.wave)
    ;[out.windCos, out.windSin] = turn(cell.windCos, cell.windSin, grid.wind)
    ;[out.swellCos, out.swellSin] = turn(cell.swellCos, cell.swellSin, grid.swell)
    return out
  })
}

/** Whether `grid`'s directions serve at clock time `tMs`. */
export function liveServes(grid: LiveWaveGrid | null, tMs: number | null): grid is LiveWaveGrid {
  return grid !== null && tMs !== null && Math.abs(tMs - grid.timeMs) <= LIVE_WAVES_WINDOW_MS
}

/** Consecutive failed fetches and when the next may be tried. */
export interface WaveBackoff {
  failures: number
  retryAt: number
}

export interface WaveGridDeps {
  fetchJson: () => Promise<unknown>
  readStored: () => Promise<{ fetchedAt: number; body: unknown } | null>
  writeStored: (fetchedAt: number, body: unknown) => Promise<void>
  readBackoff: () => Promise<WaveBackoff | null>
  writeBackoff: (backoff: WaveBackoff | null) => Promise<void>
  /** Runs fn holding a lock shared by every tab, so they take turns. */
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>
  now: () => number
}

/** How long to wait after the nth failure in a row. */
export function waveRetryDelayMs(failures: number): number {
  return Math.min(LIVE_WAVES_RETRY_MAX_MS, LIVE_WAVES_RETRY_MS * 2 ** Math.max(0, failures - 1))
}

/**
 * The live directions, fetched at most once per LIVE_WAVES_TTL_MS across
 * tabs: from memory, else storage, else one fetch, storage re-read under the
 * shared lock first. peek never waits on the network: whatever grid is to
 * hand, with any refresh due started in the background.
 */
export function createWaveGridSource(deps: WaveGridDeps) {
  const { fetchJson, readStored, writeStored, readBackoff, writeBackoff, exclusive, now } = deps
  let current: { grid: LiveWaveGrid; fetchedAt: number } | null = null
  let refreshing: Promise<void> | null = null
  let nextCheckAt = -Infinity
  const age = () => (current ? now() - current.fetchedAt : Infinity)

  // A stored grid that wouldn't parse, so it isn't parsed again.
  let rejectedAt = NaN

  async function adoptStored() {
    const stored = await readStored().catch(() => null)
    if (!stored || !Number.isFinite(stored.fetchedAt) || stored.fetchedAt > now() + STORED_CLOCK_SLACK_MS) return
    if (stored.fetchedAt === rejectedAt || (current && stored.fetchedAt <= current.fetchedAt)) return
    try {
      current = { grid: parseWaveGrid(stored.body), fetchedAt: stored.fetchedAt }
    } catch (err) {
      rejectedAt = stored.fetchedAt
      console.warn('[waves] ignoring the stored wave directions', err)
    }
  }

  async function refresh() {
    await adoptStored()
    if (age() < LIVE_WAVES_TTL_MS) return
    const failed = await readBackoff().catch(() => null)
    if (failed && failed.retryAt > now() + LIVE_WAVES_RETRY_MAX_MS) {
      // Stored by a clock that was wrong: bounded, and stored so, or the
      // bound would move along with the clock.
      failed.retryAt = now() + LIVE_WAVES_RETRY_MAX_MS
      await writeBackoff(failed).catch(() => {})
    }
    if (failed && now() < failed.retryAt) {
      nextCheckAt = failed.retryAt
      return
    }
    try {
      const body = await fetchJson()
      const grid = parseWaveGrid(body)
      const fetchedAt = now()
      current = { grid, fetchedAt }
      await Promise.all([writeStored(fetchedAt, body), failed && writeBackoff(null)]).catch((err: unknown) =>
        console.warn('[waves] could not store the wave directions', err)
      )
    } catch (err) {
      const failures = (failed?.failures ?? 0) + 1
      nextCheckAt = now() + waveRetryDelayMs(failures)
      console.warn('[waves] fetching the live wave directions failed', err)
      await writeBackoff({ failures, retryAt: nextCheckAt }).catch(() => {})
    }
  }

  return {
    async peek(): Promise<LiveWaveGrid | null> {
      if (!current) await adoptStored()
      if (age() >= LIVE_WAVES_TTL_MS && now() >= nextCheckAt) {
        refreshing ??= exclusive(refresh).finally(() => {
          refreshing = null
        })
      }
      return current?.grid ?? null
    },
    /** The refresh under way, if any (for tests). */
    settled: () => refreshing ?? Promise.resolve(),
  }
}
