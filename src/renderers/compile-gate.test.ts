import { afterEach, describe, expect, it, vi } from 'vitest'
import { afterRound, allShownReady, compilesAhead, phaseAfterUnmount, readyNow, assetsLoaded, drainWithin, withTimeout } from './compile-gate'

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

describe('afterRound', () => {
  const round = (over: Partial<Parameters<typeof afterRound>[0]>) =>
    afterRound({ outcome: 'done', added: false, loaded: true, quiet: 0, deferred: false, final: false, ...over }, 2)

  it('warms after two quiet rounds in a row', () => {
    expect(round({ quiet: 0 })).toEqual({ next: 'compile', quiet: 1, final: false })
    expect(round({ quiet: 1 })).toEqual({ next: 'warm', quiet: 2, final: false })
  })

  it('runs one last round with what was left out, then warms', () => {
    expect(round({ quiet: 0, deferred: true })).toEqual({ next: 'compile', quiet: 1, final: false })
    expect(round({ quiet: 1, deferred: true })).toEqual({ next: 'compile', quiet: 2, final: true })
    expect(round({ quiet: 2, deferred: true, final: true, added: true })).toEqual({ next: 'warm', quiet: 2, final: true })
  })

  it('shows the scene when the last round times out', () => {
    expect(round({ quiet: 2, final: true, outcome: 'timeout' })).toEqual({ next: 'reveal', quiet: 2, final: true })
  })

  it('starts the count again on a round that added programs or with assets still loading', () => {
    expect(round({ quiet: 1, added: true })).toEqual({ next: 'compile', quiet: 0, final: false })
    expect(round({ quiet: 1, loaded: false })).toEqual({ next: 'compile', quiet: 0, final: false })
  })

  it('shows the scene after a round that timed out', () => {
    expect(round({ outcome: 'timeout', quiet: 1 }).next).toBe('reveal')
  })
})

describe('readyNow', () => {
  it('waits for two drawn frames and anything pending', () => {
    expect(readyNow({ drawn: 1, pending: false, late: false })).toBe(false)
    expect(readyNow({ drawn: 2, pending: true, late: false })).toBe(false)
    expect(readyNow({ drawn: 2, pending: false, late: false })).toBe(true)
  })

  it('stops waiting on what is pending past the deadline', () => {
    expect(readyNow({ drawn: 2, pending: true, late: true })).toBe(true)
  })
})

describe('phaseAfterUnmount', () => {
  it('unreadies a ready scene, to be readied again once drawn', () => {
    expect(phaseAfterUnmount('ready')).toEqual({ phase: 'shown', unready: true })
  })

  it('runs a round still compiling again', () => {
    expect(phaseAfterUnmount('compiling')).toEqual({ phase: 'compile', unready: false })
  })

  it('leaves any other phase as it is', () => {
    expect(phaseAfterUnmount('warm')).toEqual({ phase: 'warm', unready: false })
  })
})

describe('compilesAhead', () => {
  it('compiles materials with nothing on the way', () => {
    expect(compilesAhead([{ userData: {} }, { userData: { compileLater: false } }])).toBe(true)
    expect(compilesAhead([])).toBe(true)
  })

  it('leaves an object to its draw while one of its materials waits for what changes its program', () => {
    expect(compilesAhead([{ userData: {} }, { userData: { compileLater: true } }])).toBe(false)
  })
})
