import { describe, expect, it } from 'vitest'
import { BAKE_MAX_WAIT_MS, FRAME_BUDGET_MS, FrameBudget, UPLOAD_BYTES_PER_FRAME, UPLOAD_MAX_FRAME_MS, UPLOAD_MAX_PENDING } from './frame-budget'

const flush = () => new Promise((r) => setTimeout(r, 0))

/** A clock the jobs move: each job "costs" what it adds. */
function fakeClock() {
  const clock = { now: 0, read: () => clock.now }
  return clock
}

describe('FrameBudget (tides-zmw.9.2, by time since tides-zmw.9.25)', () => {
  it('runs jobs in the tick until its ms are spent, at least one, in arrival order', async () => {
    expect(FRAME_BUDGET_MS).toBe(4)
    const clock = fakeClock()
    const budget = new FrameBudget(4, clock.read)
    const done: number[] = []
    for (let i = 0; i < 6; i++) budget.run(() => ((clock.now += 1.5), done.push(i)))
    await flush()
    expect(done).toEqual([])
    // 1.5, 3, 4.5: the third starts with 3 ms spent, then the budget is gone
    budget.tick()
    expect(done).toEqual([0, 1, 2])
    budget.tick()
    expect(done).toEqual([0, 1, 2, 3, 4, 5])
    expect(budget.pending).toBe(0)
    expect(budget.stats).toMatchObject({ jobs: 6, ms: 9, maxTickMs: 4.5, maxJobMs: 1.5, uploadBytes: 0 })
  })

  it('always runs one job a tick, however long', () => {
    const clock = fakeClock()
    const budget = new FrameBudget(4, clock.read)
    const done: number[] = []
    for (let i = 0; i < 3; i++) budget.run(() => ((clock.now += 10), done.push(i)))
    budget.tick()
    expect(done).toEqual([0])
    budget.tick()
    expect(done).toEqual([0, 1])
  })

  it('runs every grid before any bake, whatever the arrival order', () => {
    const clock = fakeClock()
    const budget = new FrameBudget(4, clock.read)
    const done: string[] = []
    budget.run(() => ((clock.now += 1), done.push('b0')), undefined, 'bake')
    budget.run(() => ((clock.now += 1), done.push('b1')), undefined, 'bake')
    budget.run(() => ((clock.now += 1), done.push('g0')))
    budget.run(() => ((clock.now += 1), done.push('g1')), undefined, 'grid')
    budget.run(() => ((clock.now += 1), done.push('g2')))
    budget.tick()
    expect(done).toEqual(['g0', 'g1', 'g2', 'b0'])
    budget.tick()
    expect(done).toEqual(['g0', 'g1', 'g2', 'b0', 'b1'])
  })

  it('lets one bake a tick through ahead of the grids once it has waited BAKE_MAX_WAIT_MS', () => {
    const clock = fakeClock()
    const budget = new FrameBudget(4, clock.read)
    const done: string[] = []
    budget.run(() => done.push('bake'), undefined, 'bake')
    let n = 0
    const grid = () => budget.run(() => ((clock.now += 5), done.push(`g${n++}`)))
    for (let i = 0; i < 3; i++) grid()
    budget.tick()
    expect(done).toEqual(['g0'])
    clock.now = BAKE_MAX_WAIT_MS
    budget.tick()
    expect(done).toEqual(['g0', 'bake', 'g1'])
    expect(budget.stats.agedBakes).toBe(1)
  })

  it('runs uploads last, only with time left, never forced', () => {
    const clock = fakeClock()
    const budget = new FrameBudget(4, clock.read)
    const done: string[] = []
    budget.run(() => ((clock.now += 1), done.push('u0'), 1), undefined, 'upload')
    budget.run(() => ((clock.now += 5), done.push('g0')))
    budget.run(() => ((clock.now += 1), done.push('b0')), undefined, 'bake')
    // the grid spends the frame: no bake, no upload
    budget.tick()
    expect(done).toEqual(['g0'])
    budget.tick()
    expect(done).toEqual(['g0', 'b0', 'u0'])
    // an upload alone costing more than the frame still runs (time was left when it started)
    budget.run(() => ((clock.now += 10), done.push('u1'), 1), undefined, 'upload')
    budget.run(() => ((clock.now += 1), done.push('u2'), 1), undefined, 'upload')
    budget.tick()
    expect(done.slice(3)).toEqual(['u1'])
  })

  it('lets at most UPLOAD_BYTES_PER_FRAME of uploads through a frame, counting what each says it sent', () => {
    expect(UPLOAD_BYTES_PER_FRAME).toBe(2 * 1024 * 1024)
    const budget = new FrameBudget(Infinity)
    const done: number[] = []
    const MB = 1024 * 1024
    budget.run(() => (done.push(0), 0), undefined, 'upload') // skipped: sent nothing
    for (let i = 1; i <= 4; i++) budget.run(() => (done.push(i), 1.2 * MB), undefined, 'upload')
    budget.tick()
    // 0 + 1.2 MB < 2 MB, then 2.4 MB: the frame's bytes are spent
    expect(done).toEqual([0, 1, 2])
    budget.tick()
    expect(done).toEqual([0, 1, 2, 3, 4])
    expect(budget.stats.uploadBytes).toBeCloseTo(4 * 1.2 * MB)
  })

  it('runs no uploads in a tick after a frame longer than UPLOAD_MAX_FRAME_MS (a GPU-bound frame)', () => {
    const clock = fakeClock()
    const budget = new FrameBudget(4, clock.read)
    const done: string[] = []
    const upload = (name: string) => budget.run(() => (done.push(name), 1), undefined, 'upload')
    upload('u0')
    budget.tick() // the first tick: no frame to judge
    expect(done).toEqual(['u0'])
    upload('u1')
    clock.now += UPLOAD_MAX_FRAME_MS + 20
    budget.tick()
    expect(done).toEqual(['u0'])
    expect(budget.stats.slowFrames).toBe(1)
    clock.now += 16
    budget.tick()
    expect(done).toEqual(['u0', 'u1'])
  })

  it('drops the oldest upload past UPLOAD_MAX_PENDING', async () => {
    const budget = new FrameBudget(Infinity)
    const first = budget.run(() => 0, undefined, 'upload')
    for (let i = 0; i < UPLOAD_MAX_PENDING; i++) budget.run(() => 0, undefined, 'upload')
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(budget.pending).toBe(UPLOAD_MAX_PENDING)
    expect(budget.stats.droppedUploads).toBe(1)
  })

  it('resolves with what the work returns and rejects with what it throws, without stopping the tick', async () => {
    const budget = new FrameBudget(Infinity)
    const ok = budget.run(() => 42)
    const bad = budget.run(() => {
      throw new Error('boom')
    })
    const after = budget.run(() => 'after')
    budget.tick()
    await expect(ok).resolves.toBe(42)
    await expect(bad).rejects.toThrow('boom')
    await expect(after).resolves.toBe('after')
  })

  it('drops an aborted job with its reason, never running it', async () => {
    const budget = new FrameBudget(Infinity)
    const abort = new AbortController()
    let ran = false
    const first = budget.run(() => (ran = true), abort.signal, 'bake')
    const second = budget.run(() => 'second')
    abort.abort(new DOMException('gone', 'AbortError'))
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(budget.pending).toBe(1)
    budget.tick()
    await expect(second).resolves.toBe('second')
    expect(ran).toBe(false)
    await expect(budget.run(() => 0, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects everything waiting, and every later run, once disposed', async () => {
    const budget = new FrameBudget()
    const waiting = budget.run(() => 0)
    const bake = budget.run(() => 0, undefined, 'bake')
    budget.dispose()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    await expect(bake).rejects.toMatchObject({ name: 'AbortError' })
    await expect(budget.run(() => 0)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
