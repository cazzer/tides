import { describe, expect, it } from 'vitest'
import { FrameBudget, GRIDS_PER_FRAME } from './frame-budget'

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('FrameBudget (tides-zmw.9.2)', () => {
  it('lets perFrame waiters through per tick, in arrival order', async () => {
    expect(GRIDS_PER_FRAME).toBe(2)
    const budget = new FrameBudget(2)
    const done: number[] = []
    for (let i = 0; i < 5; i++) budget.wait().then(() => done.push(i))
    await flush()
    expect(done).toEqual([])
    budget.tick()
    await flush()
    expect(done).toEqual([0, 1])
    budget.tick()
    budget.tick()
    await flush()
    expect(done).toEqual([0, 1, 2, 3, 4])
    expect(budget.pending).toBe(0)
  })

  it('drops an aborted waiter with its reason, freeing its turn', async () => {
    const budget = new FrameBudget(1)
    const abort = new AbortController()
    const first = budget.wait(abort.signal)
    const second = budget.wait()
    abort.abort(new DOMException('gone', 'AbortError'))
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(budget.pending).toBe(1)
    budget.tick()
    await expect(second).resolves.toBeUndefined()
    await expect(budget.wait(abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects everything waiting, and every later wait, once disposed', async () => {
    const budget = new FrameBudget()
    const waiting = budget.wait()
    budget.dispose()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    await expect(budget.wait()).rejects.toMatchObject({ name: 'AbortError' })
  })
})
