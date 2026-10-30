import { afterEach, describe, expect, test, vi } from 'vitest'
import { gridWithin, TYPE_GRID_WAIT_MS, typeGridLoad } from './cloudTypeGrid'
import { COVER_PAST_DAYS, FORECAST_STALE_MAX_MS, GRID_POINTS, type CoverGrid } from '../forecast-clouds'
import { DAY_MS, HOUR_MS, utcDay } from '../real-clouds'

const NOW = Date.UTC(2026, 9, 26, 1, 30)
const START = Date.UTC(2026, 9, 24)

/** High cloud everywhere, from START for two days. */
function grid(): CoverGrid {
  const n = 48 * GRID_POINTS
  return {
    startMs: START,
    hours: 48,
    cover: new Float32Array(n),
    layers: { low: new Float32Array(n), mid: new Float32Array(n), high: new Float32Array(n).fill(1) },
    precip: null,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('typeGridLoad', () => {
  test('peeks for the times the frame shows', async () => {
    const g = grid()
    const peek = vi.fn(async () => g)
    expect(await typeGridLoad({ peek, now: () => NOW }, START + HOUR_MS, START + 2 * HOUR_MS)).toBe(g)
    expect(peek).toHaveBeenCalledWith(START + HOUR_MS, START + 2 * HOUR_MS)
  })

  test("doesn't look for frames older than any grid still served reaches", async () => {
    const peek = vi.fn(async () => grid())
    const oldest = utcDay(NOW - FORECAST_STALE_MAX_MS) - COVER_PAST_DAYS * DAY_MS
    expect(await typeGridLoad({ peek, now: () => NOW }, oldest - 1, oldest + HOUR_MS)).toBeNull()
    expect(peek).not.toHaveBeenCalled()
    await typeGridLoad({ peek, now: () => NOW }, oldest, oldest + HOUR_MS)
    expect(peek).toHaveBeenCalledTimes(1)
  })

  test('a failing peek is null, not a failed build', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const peek = vi.fn(async (): Promise<CoverGrid | null> => {
      throw new Error('storage gone')
    })
    await expect(typeGridLoad({ peek, now: () => NOW }, START, START)).resolves.toBeNull()
    expect(warn).toHaveBeenCalled()
  })
})

describe('gridWithin', () => {
  test('the grid once it loads', async () => {
    const g = grid()
    expect(await gridWithin(Promise.resolve(g), new AbortController().signal)).toBe(g)
  })

  test('no grid: null', async () => {
    expect(await gridWithin(Promise.resolve(null), new AbortController().signal)).toBeNull()
  })

  test('storage that hangs: null after TYPE_GRID_WAIT_MS', async () => {
    vi.useFakeTimers()
    let settled = false
    const pending = gridWithin(new Promise<CoverGrid | null>(() => {}), new AbortController().signal)
    pending.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(TYPE_GRID_WAIT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  test('an abort while waiting rejects with an AbortError, not null', async () => {
    vi.useFakeTimers()
    const abort = new AbortController()
    const pending = gridWithin(new Promise<CoverGrid | null>(() => {}), abort.signal)
    abort.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(vi.getTimerCount()).toBe(0)
  })

  test('an already aborted build throws at once', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(gridWithin(Promise.resolve(grid()), abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('drops its abort listener once done', async () => {
    const abort = new AbortController()
    const remove = vi.spyOn(abort.signal, 'removeEventListener')
    await gridWithin(Promise.resolve(grid()), abort.signal)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})
