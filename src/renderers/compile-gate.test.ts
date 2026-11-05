import { afterEach, describe, expect, it, vi } from 'vitest'
import { allShownReady, assetsLoaded, drainWithin, withTimeout } from './compile-gate'

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is done when the promise settles first', async () => {
    vi.useFakeTimers()
    const outcome = withTimeout(Promise.resolve('linked'), 1000)
    await expect(outcome).resolves.toBe('done')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out on a promise that never settles', async () => {
    vi.useFakeTimers()
    const outcome = withTimeout(new Promise(() => {}), 1000)
    await vi.advanceTimersByTimeAsync(999)
    let settled = false
    void outcome.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(outcome).resolves.toBe('timeout')
  })

  it('passes a rejection through', async () => {
    vi.useFakeTimers()
    await expect(withTimeout(Promise.reject(new Error('lost')), 1000)).rejects.toThrow('lost')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('drainWithin', () => {
  it('runs items until the budget is spent and returns the rest', () => {
    let clock = 0
    const ran: number[] = []
    const left = drainWithin([1, 2, 3, 4, 5], 8, () => clock, (item) => {
      ran.push(item)
      clock += 3
    })
    // 3, 6, then 9 >= 8 stops it.
    expect(ran).toEqual([1, 2, 3])
    expect(left).toEqual([4, 5])
  })

  it('always runs at least one item, however long it takes', () => {
    let clock = 0
    const left = drainWithin(['slow', 'next'], 8, () => clock, () => {
      clock += 50
    })
    expect(left).toEqual(['next'])
  })

  it('empties a queue that fits', () => {
    expect(drainWithin([1, 2], 8, () => 0, () => {})).toEqual([])
    expect(drainWithin([], 8, () => 0, () => {})).toEqual([])
  })
})

describe('assetsLoaded', () => {
  it('needs something asked for, all of it in, and the manager idle', () => {
    expect(assetsLoaded({ active: false, loaded: 0, total: 0 })).toBe(false)
    expect(assetsLoaded({ active: false, loaded: 3, total: 4 })).toBe(false)
    expect(assetsLoaded({ active: true, loaded: 4, total: 4 })).toBe(false)
    expect(assetsLoaded({ active: false, loaded: 4, total: 4 })).toBe(true)
  })
})

describe('allShownReady', () => {
  it('waits for every shown view', () => {
    expect(allShownReady(['main', 'top', 'bottom'], new Set(['main', 'top']))).toBe(false)
    expect(allShownReady(['main', 'top', 'bottom'], new Set(['main', 'top', 'bottom']))).toBe(true)
  })

  it('ignores views ready but no longer shown', () => {
    expect(allShownReady(['main'], new Set(['main', 'top']))).toBe(true)
  })

  it('is never ready with nothing shown', () => {
    expect(allShownReady([], new Set(['main']))).toBe(false)
  })
})
