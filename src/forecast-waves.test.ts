// Live wave directions (tides-nh8.4): the request, the response's checks,
// the live headings over the baked climate, the window they serve in, and
// the fetching's cache and fallback.
import { describe, expect, it, vi } from 'vitest'
import {
  createWaveGridSource,
  LIVE_WAVE_TEXELS,
  LIVE_WAVES_MIN_SEA,
  LIVE_WAVES_RETRY_MS,
  LIVE_WAVES_TTL_MS,
  LIVE_WAVES_WINDOW_MS,
  liveClimate,
  liveServes,
  parseWaveGrid,
  waveRequestBodies,
  LIVE_WAVES_MAX_LOCATIONS,
  type WaveBackoff,
} from './forecast-waves'
import { bearing, CLIMATE_COLS, climateBytes, decode, texelLat, texelLon } from './renderers/waterClimate'

const TIME_S = 1_793_332_800
/** A response: every texel at sea but the first `land`, the swell from 281. */
function response(land = 0, time = TIME_S) {
  return LIVE_WAVE_TEXELS.map((k, n) => ({
    latitude: texelLat(Math.floor(k / CLIMATE_COLS)),
    longitude: texelLon(k % CLIMATE_COLS),
    current:
      n < land
        ? { time, wave_direction: null, wind_wave_direction: null, swell_wave_direction: null }
        : { time, wave_direction: 290, wind_wave_direction: 60, swell_wave_direction: 281 },
  }))
}

describe('the request', () => {
  it('asks every climate texel north of 80 S for its current directions, as the bake does, in even requests the API takes', () => {
    const bodies = waveRequestBodies()
    expect(bodies).toHaveLength(2)
    for (const body of bodies) {
      expect(body.get('latitude')!.split(',').length).toBeLessThanOrEqual(LIVE_WAVES_MAX_LOCATIONS)
      expect(body.get('current')).toBe('wave_direction,wind_wave_direction,swell_wave_direction')
      expect(body.get('models')).toBe('meteofrance_wave')
    }
    const lats = bodies.flatMap((b) => b.get('latitude')!.split(',').map(Number))
    const lons = bodies.flatMap((b) => b.get('longitude')!.split(',').map(Number))
    expect(lats).toHaveLength(LIVE_WAVE_TEXELS.length)
    expect(lats.map((lat, n) => [lat, lons[n]])).toEqual(LIVE_WAVE_TEXELS.map((k) => [texelLat(Math.floor(k / CLIMATE_COLS)), texelLon(k % CLIMATE_COLS)]))
    expect(Math.min(...lats)).toBeGreaterThan(-80)
    // 23 rows of 48: 86.25 N down to 78.75 S.
    expect(LIVE_WAVE_TEXELS).toHaveLength(23 * 48)
  })
})

describe('parseWaveGrid', () => {
  it('reads each texel\'s directions and their time, NaN over land', () => {
    const grid = parseWaveGrid(response(10))
    expect(grid.timeMs).toBe(TIME_S * 1000)
    const [land, sea] = [LIVE_WAVE_TEXELS[0], LIVE_WAVE_TEXELS[20]]
    expect(grid.swell[land]).toBeNaN()
    expect(grid.swell[sea]).toBe(281)
    expect(grid.wind[sea]).toBe(60)
    // The texels never asked (south of 80 S) are unknown too.
    expect(grid.wave[grid.wave.length - 1]).toBeNaN()
  })

  it('refuses a response that doesn\'t answer the request', () => {
    expect(() => parseWaveGrid({})).toThrow()
    expect(() => parseWaveGrid(response().slice(1))).toThrow()
    expect(() => parseWaveGrid(response(LIVE_WAVE_TEXELS.length - LIVE_WAVES_MIN_SEA + 1))).toThrow()
  })
})

describe('liveClimate', () => {
  const baked = decode(climateBytes())
  it('takes the live headings where the grid knows them, turned round to where the waves go, and the baked ones elsewhere', () => {
    const grid = parseWaveGrid(response(10))
    const cells = liveClimate(baked, grid)
    const sea = LIVE_WAVE_TEXELS[20]
    expect(bearing(cells[sea].swellCos, cells[sea].swellSin)).toBeCloseTo(101, 6)
    expect(bearing(cells[sea].windCos, cells[sea].windSin)).toBeCloseTo(240, 6)
    expect(bearing(cells[sea].waveCos, cells[sea].waveSin)).toBeCloseTo(110, 6)
    expect(Math.hypot(cells[sea].swellCos, cells[sea].swellSin)).toBeCloseTo(1, 9)
    expect(cells[sea].swell).toBe(baked[sea].swell)
    const land = LIVE_WAVE_TEXELS[0]
    expect(cells[land]).toEqual(baked[land])
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
