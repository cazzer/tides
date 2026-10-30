// Live wave directions (tides-nh8.4): which way the sea runs now, from
// Open-Meteo's Marine API (Météo-France MFWAM, as the baked climate), so the
// drawn waves (renderers/water.ts aimWaves()) follow today's swell rather
// than the year's. One request for the baked climate's own grid
// (renderers/waterClimateLayout.ts: 7.5 deg texel centres, south to 80 S
// where MFWAM stops), the current dominant, wind-wave and swell directions,
// in two requests (the API takes up to LIVE_WAVES_MAX_LOCATIONS at once),
// kept for LIVE_WAVES_TTL_MS and shared by every tab; failures back off from
// LIVE_WAVES_RETRY_MS to LIVE_WAVES_RETRY_MAX_MS. The live headings replace
// the climate's texel by texel where the API answers (land answers null), and
// only while the real weather is shown and the clock is within
// LIVE_WAVES_WINDOW_MS of the directions' time: otherwise, and offline, the
// baked climate. Pure logic; the fetching is renderers/liveWaveGrid.ts.
import { CLIMATE_COLS, CLIMATE_ROWS, texelLat, texelLon, type ClimateCell } from './renderers/waterClimateLayout'

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
/** MFWAM's grid stops short of the South Pole (the bake's SOUTHMOST_LAT). */
const SOUTHMOST_LAT = -80
/** A response with fewer sea points than this is refused (the grid has 655). */
export const LIVE_WAVES_MIN_SEA = 300

/** The texels asked for, as indices into the climate grid. */
export const LIVE_WAVE_TEXELS = Array.from({ length: CLIMATE_COLS * CLIMATE_ROWS }, (_, k) => k).filter(
  (k) => texelLat(Math.floor(k / CLIMATE_COLS)) > SOUTHMOST_LAT
)

/** The most locations the API answers in one request. */
export const LIVE_WAVES_MAX_LOCATIONS = 1000

/** The texels' current directions, in UTC epoch seconds, in as few even
 * requests as the API allows; their answers, concatenated in order, are
 * what parseWaveGrid() reads. */
export function waveRequestBodies(): URLSearchParams[] {
  const count = Math.ceil(LIVE_WAVE_TEXELS.length / LIVE_WAVES_MAX_LOCATIONS)
  const size = Math.ceil(LIVE_WAVE_TEXELS.length / count)
  return Array.from({ length: count }, (_, n) => {
    const texels = LIVE_WAVE_TEXELS.slice(n * size, (n + 1) * size)
    return new URLSearchParams({
      latitude: texels.map((k) => texelLat(Math.floor(k / CLIMATE_COLS))).join(','),
      longitude: texels.map((k) => texelLon(k % CLIMATE_COLS)).join(','),
      current: LIVE_WAVE_VARIABLES.join(','),
      models: MARINE_MODEL,
      timeformat: 'unixtime',
    })
  })
}

/** The live directions on the climate's grid (NaN where unknown: land, ice,
 * or not asked), and their time. */
export interface LiveWaveGrid {
  timeMs: number
  wave: Float32Array
  wind: Float32Array
  swell: Float32Array
}

/** The Marine API's answers to waveRequestBodies(), concatenated, as a
 * grid; throws on any that doesn't answer them. */
export function parseWaveGrid(json: unknown): LiveWaveGrid {
  if (!Array.isArray(json) || json.length !== LIVE_WAVE_TEXELS.length) {
    throw new Error(`live waves: expected ${LIVE_WAVE_TEXELS.length} locations`)
  }
  const blank = () => new Float32Array(CLIMATE_COLS * CLIMATE_ROWS).fill(NaN)
  const grid = { wave: blank(), wind: blank(), swell: blank() }
  const times: number[] = []
  let sea = 0
  json.forEach((location: unknown, n) => {
    const current = (location as { current?: Record<string, unknown> } | null)?.current
    if (!current) return
    const k = LIVE_WAVE_TEXELS[n]
    const read = (name: string) => {
      const v = current[name]
      return typeof v === 'number' && Number.isFinite(v) ? v : NaN
    }
    grid.wave[k] = read('wave_direction')
    grid.wind[k] = read('wind_wave_direction')
    grid.swell[k] = read('swell_wave_direction')
    if (Number.isFinite(grid.wave[k])) sea++
    if (typeof current.time === 'number') times.push(current.time)
  })
  if (sea < LIVE_WAVES_MIN_SEA) throw new Error(`live waves: only ${sea} sea points`)
  if (times.length === 0) throw new Error('live waves: no time')
  return { timeMs: Math.max(...times) * 1000, ...grid }
}

/** The climate with each texel's headings live where the grid knows them:
 * the directions turned round (where the waves go), settled (length 1). */
export function liveClimate(baked: readonly ClimateCell[], grid: LiveWaveGrid): ClimateCell[] {
  const toward = (from: number) => ((from + 180) * Math.PI) / 180
  return baked.map((cell, k) => {
    const out = { ...cell }
    if (Number.isFinite(grid.wave[k])) [out.waveCos, out.waveSin] = [Math.cos(toward(grid.wave[k])), Math.sin(toward(grid.wave[k]))]
    if (Number.isFinite(grid.wind[k])) [out.windCos, out.windSin] = [Math.cos(toward(grid.wind[k])), Math.sin(toward(grid.wind[k]))]
    if (Number.isFinite(grid.swell[k])) [out.swellCos, out.swellSin] = [Math.cos(toward(grid.swell[k])), Math.sin(toward(grid.swell[k]))]
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

  async function adoptStored() {
    const stored = await readStored().catch(() => null)
    if (!stored || !Number.isFinite(stored.fetchedAt) || stored.fetchedAt > now() + STORED_CLOCK_SLACK_MS) return
    if (current && stored.fetchedAt <= current.fetchedAt) return
    try {
      current = { grid: parseWaveGrid(stored.body), fetchedAt: stored.fetchedAt }
    } catch (err) {
      console.warn('[waves] ignoring the stored wave directions', err)
    }
  }

  async function refresh() {
    await adoptStored()
    if (age() < LIVE_WAVES_TTL_MS) return
    const failed = await readBackoff().catch(() => null)
    if (failed && now() < Math.min(failed.retryAt, now() + LIVE_WAVES_RETRY_MAX_MS)) {
      nextCheckAt = Math.min(failed.retryAt, now() + LIVE_WAVES_RETRY_MAX_MS)
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
