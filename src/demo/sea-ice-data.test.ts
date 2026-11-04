import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { afterFrameWhenIdle } from './sea-ice-data'

// A frame and the idle callbacks after it, run by hand.
let frames: (() => void)[]
let idles: { callback: () => void; timeout?: number }[]

function runFrame() {
  const pending = frames
  frames = []
  pending.forEach((callback) => callback())
}

function runIdle() {
  const pending = idles
  idles = []
  pending.forEach(({ callback }) => callback())
}

beforeEach(() => {
  frames = []
  idles = []
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    frames[handle - 1] = () => {}
  })
  vi.stubGlobal('requestIdleCallback', (callback: () => void, options?: { timeout?: number }) => idles.push({ callback, timeout: options?.timeout }))
  vi.stubGlobal('cancelIdleCallback', (handle: number) => {
    idles[handle - 1] = { callback: () => {} }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// Each test gets a fresh module: what was asked for and loaded is module state.
async function freshData() {
  vi.resetModules()
  return import('./sea-ice-data')
}

describe('askForSeaIce', () => {
  it('fetches once for a deferred and an immediate caller', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const data = await freshData()
    data.askForSeaIce(true)
    expect(fetch).not.toHaveBeenCalled()
    data.askForSeaIce(false)
    expect(fetch).toHaveBeenCalledTimes(2)
    runFrame()
    runIdle()
    // The deferred ask finds it asked for already: the ice file and its mask, once each.
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(new Set(fetch.mock.calls.map((call: unknown[]) => String(call[0]))).size).toBe(2)
  })

  it('leaves the ice null when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const data = await freshData()
    data.askForSeaIce(false)
    await expect(data.loadSeaIce()).resolves.toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    // Asked once: a later caller doesn't fetch again.
    data.askForSeaIce(false)
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
  })
})

describe('afterFrameWhenIdle', () => {
  it('waits for a frame, then an idle moment', () => {
    const start = vi.fn()
    afterFrameWhenIdle(start)
    expect(start).not.toHaveBeenCalled()
    expect(idles).toHaveLength(0)
    runFrame()
    expect(start).not.toHaveBeenCalled()
    expect(idles).toHaveLength(1)
    expect(idles[0].timeout).toBeGreaterThan(0)
    runIdle()
    expect(start).toHaveBeenCalledOnce()
  })

  it('never starts once cancelled, before the frame or after it', () => {
    const early = vi.fn()
    afterFrameWhenIdle(early)()
    runFrame()
    runIdle()
    expect(early).not.toHaveBeenCalled()

    const late = vi.fn()
    const cancel = afterFrameWhenIdle(late)
    runFrame()
    cancel()
    runIdle()
    expect(late).not.toHaveBeenCalled()
  })

  it('takes a timeout after the frame where there are no idle callbacks', () => {
    vi.stubGlobal('requestIdleCallback', undefined)
    vi.useFakeTimers()
    const start = vi.fn()
    afterFrameWhenIdle(start)
    vi.runAllTimers()
    expect(start).not.toHaveBeenCalled()
    runFrame()
    vi.runAllTimers()
    expect(start).toHaveBeenCalledOnce()
  })
})
