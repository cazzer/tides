// Live wave directions (tides-nh8.4): the request, the response's checks,
// the live headings over the baked climate, the window they serve in, and
// the fetching's cache and fallback.
import { describe, expect, it, vi } from 'vitest'
import {
  createWaveGridSource,
  LIVE_COLS,
  LIVE_POINTS,
  LIVE_WAVES_MIN_SEA,
  LIVE_WAVES_RETRY_MAX_MS,
  LIVE_WAVES_RETRY_MS,
  LIVE_WAVES_TTL_MS,
  LIVE_WAVES_WINDOW_MS,
  liveClimate,
  liveLat,
  liveLon,
  liveServes,
  parseWaveGrid,
  waveRequestBody,
  type WaveBackoff,
} from './forecast-waves'
import { bearing, CLIMATE_COLS, climateBytes, decode, texelLat, texelLon } from './renderers/waterClimate'

const TIME_S = 1_793_332_800
/** A response: every point at sea but those `land` picks, the swell from 281. */
function response(land: (i: number) => boolean = () => false, time = TIME_S) {
  return Array.from({ length: LIVE_POINTS }, (_, i) => ({
    latitude: liveLat(Math.floor(i / LIVE_COLS)) + 0.04,
    longitude: liveLon(i % LIVE_COLS) - 0.04,
    current: land(i)
      ? { time, wave_direction: null, wind_wave_direction: null, swell_wave_direction: null }
      : { time, wave_direction: 290, wind_wave_direction: 60, swell_wave_direction: 281 },
  }))
}

describe('the request', () => {
  it('asks a 15 deg grid north of 80 S for its current directions, in one request', () => {
    const body = waveRequestBody()
    const lats = body.get('latitude')!.split(',').map(Number)
    const lons = body.get('longitude')!.split(',').map(Number)
    expect(lats).toHaveLength(264)
    expect(lons).toHaveLength(264)
    expect(Math.max(...lats)).toBe(82.5)
    expect(Math.min(...lats)).toBe(-67.5)
    expect(Math.min(...lons)).toBe(-172.5)
    expect(Math.max(...lons)).toBe(172.5)
    expect(body.get('current')).toBe('wave_direction,wind_wave_direction,swell_wave_direction')
    expect(body.get('models')).toBe('meteofrance_wave')
  })
})

describe('parseWaveGrid', () => {
  it('reads each point\'s directions and their time, NaN over land', () => {
    const grid = parseWaveGrid(response((i) => i < 10))
    expect(grid.timeMs).toBe(TIME_S * 1000)
    expect(grid.swell[0]).toBeNaN()
    expect(grid.swell[20]).toBe(281)
    expect(grid.wind[20]).toBe(60)
  })

  it('refuses a response that doesn\'t answer the request', () => {
    expect(() => parseWaveGrid({})).toThrow()
    expect(() => parseWaveGrid(response().slice(1))).toThrow()
    expect(() => parseWaveGrid(response((i) => i > LIVE_WAVES_MIN_SEA - 2))).toThrow()
    // A location answered for somewhere else.
    const moved = response()
    moved[5].latitude += 3
    expect(() => parseWaveGrid(moved)).toThrow()
    // Across the antimeridian is the same place.
    const wrapped = response()
    wrapped[0].longitude += 360
    expect(() => parseWaveGrid(wrapped)).not.toThrow()
  })
})

describe('liveClimate', () => {
  const baked = decode(climateBytes())
  const texel = (lat: number, lon: number) =>
    Math.floor((90 - lat) / 7.5) * CLIMATE_COLS + Math.floor((lon + 180) / 7.5)

  it('turns each texel\'s headings the live way, where the waves go, keeping how settled it ran', () => {
    const cells = liveClimate(baked, parseWaveGrid(response()))
    const k = texel(39.5, -11)
    expect(bearing(cells[k].swellCos, cells[k].swellSin)).toBeCloseTo(101, 4)
    expect(bearing(cells[k].windCos, cells[k].windSin)).toBeCloseTo(240, 4)
    expect(bearing(cells[k].waveCos, cells[k].waveSin)).toBeCloseTo(110, 4)
    expect(Math.hypot(cells[k].swellCos, cells[k].swellSin)).toBeCloseTo(Math.hypot(baked[k].swellCos, baked[k].swellSin), 9)
    expect(cells[k].swell).toBe(baked[k].swell)
  })

  it('leaves the land\'s points out, and a texel with none round it baked', () => {
    // Live points of one column of land: texels between it and sea take the sea's alone.
    const landCol = 12
    const cells = liveClimate(baked, parseWaveGrid(response((i) => i % LIVE_COLS === landCol)))
    const between = texel(texelLat(4), texelLon(2 * landCol + 1))
    expect(bearing(cells[between].swellCos, cells[between].swellSin)).toBeCloseTo(101, 4)
    // A whole row band of land round row 5: the texels under it stay baked.
    const banded = liveClimate(baked, parseWaveGrid(response((i) => [4, 5].includes(Math.floor(i / LIVE_COLS)))))
    const k = texel(liveLat(4) - 7.5, 0)
    expect(banded[k]).toEqual(baked[k])
  })
})

describe('liveServes', () => {
  it('serves within the window of the directions\' time, and not without a grid or a clock', () => {
    const grid = parseWaveGrid(response())
    expect(liveServes(grid, grid.timeMs)).toBe(true)
    expect(liveServes(grid, grid.timeMs - LIVE_WAVES_WINDOW_MS)).toBe(true)
    expect(liveServes(grid, grid.timeMs + LIVE_WAVES_WINDOW_MS + 1)).toBe(false)
    expect(liveServes(null, grid.timeMs)).toBe(false)
    expect(liveServes(grid, null)).toBe(false)
  })
})

describe('createWaveGridSource', () => {
  function deps(fetchJson: () => Promise<unknown>) {
    let stored: { fetchedAt: number; body: unknown } | null = null
    let backoff: WaveBackoff | null = null
    const clock = { t: 1_000_000 }
    const d = {
      fetchJson: vi.fn(fetchJson),
      readStored: async () => stored,
      writeStored: async (fetchedAt: number, body: unknown) => void (stored = { fetchedAt, body }),
      readBackoff: async () => backoff,
      writeBackoff: async (b: WaveBackoff | null) => void (backoff = b),
      exclusive: <T,>(fn: () => Promise<T>) => fn(),
      now: () => clock.t,
    }
    return { d, clock, stored: () => stored, backoff: () => backoff }
  }

  it('fetches once a TTL, never waiting on the network, and shares what it stored', async () => {
    const { d, clock } = deps(async () => response())
    const source = createWaveGridSource(d)
    expect(await source.peek()).toBeNull()
    await source.settled()
    expect((await source.peek())?.timeMs).toBe(TIME_S * 1000)
    clock.t += LIVE_WAVES_TTL_MS / 2
    await source.peek()
    await source.settled()
    expect(d.fetchJson).toHaveBeenCalledTimes(1)
    clock.t += LIVE_WAVES_TTL_MS
    await source.peek()
    await source.settled()
    expect(d.fetchJson).toHaveBeenCalledTimes(2)
    // A second source (another tab) adopts the stored grid without fetching.
    const other = createWaveGridSource({ ...d, fetchJson: vi.fn(async () => response()) })
    expect((await other.peek())?.timeMs).toBe(TIME_S * 1000)
    await other.settled()
  })

  it('bounds a backoff a wrong clock stored far ahead, and stores the bound', async () => {
    const { d, clock, backoff } = deps(async () => response())
    await d.writeBackoff({ failures: 3, retryAt: clock.t + 365 * 24 * 3_600_000 })
    const source = createWaveGridSource(d)
    await source.peek()
    await source.settled()
    expect(d.fetchJson).not.toHaveBeenCalled()
    expect(backoff()!.retryAt).toBe(clock.t + LIVE_WAVES_RETRY_MAX_MS)
    clock.t += LIVE_WAVES_RETRY_MAX_MS + 1
    expect(await source.peek()).toBeNull()
    await source.settled()
    expect(d.fetchJson).toHaveBeenCalledTimes(1)
    expect(await source.peek()).not.toBeNull()
  })

  it('reads a stored grid that won\'t parse only once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { d } = deps(async () => {
      throw new Error('offline')
    })
    await d.writeStored(999_000, { broken: true })
    const readStored = vi.fn(d.readStored)
    const source = createWaveGridSource({ ...d, readStored })
    for (let n = 0; n < 3; n++) {
      await source.peek()
      await source.settled()
    }
    expect(warn.mock.calls.filter(([m]) => String(m).includes('ignoring the stored')).length).toBe(1)
    warn.mockRestore()
  })

  it('falls back to nothing (the baked climate) offline, and backs off before asking again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { d, clock, backoff } = deps(async () => {
      throw new Error('offline')
    })
    const source = createWaveGridSource(d)
    expect(await source.peek()).toBeNull()
    await source.settled()
    expect(await source.peek()).toBeNull()
    await source.settled()
    expect(d.fetchJson).toHaveBeenCalledTimes(1)
    expect(backoff()?.failures).toBe(1)
    clock.t += LIVE_WAVES_RETRY_MS + 1
    await source.peek()
    await source.settled()
    expect(d.fetchJson).toHaveBeenCalledTimes(2)
    expect(backoff()?.failures).toBe(2)
    warn.mockRestore()
  })
})
