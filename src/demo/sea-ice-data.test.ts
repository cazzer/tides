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
  vi.useRealTimers()
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
