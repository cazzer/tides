// The colour feature's side fetches (tides-zmw.9.11): the limiter, the
// backoff and the deadline.
import { describe, expect, it, vi } from 'vitest'
import { createLimiter, KeyedBackoff, SIDE_BACKOFF_FIRST_MS, SIDE_BACKOFF_MAX_MS, withDeadline } from './side-fetch'

describe('side fetches (tides-zmw.9.11)', () => {
  it('runs at most the limit at once, the rest in the order they came', async () => {
    const limit = createLimiter(2)
    const started: number[] = []
    const finish: (() => void)[] = []
    const jobs = [0, 1, 2, 3].map((n) =>
      limit(() => {
        started.push(n)
        return new Promise<number>((r) => finish.push(() => r(n)))
      })
    )
    await Promise.resolve()
    expect(started).toEqual([0, 1])
    finish[0]()
    await jobs[0]
    await Promise.resolve()
    expect(started).toEqual([0, 1, 2])
    finish[1]()
    finish[2]()
    await Promise.all(jobs.slice(1, 3))
    await Promise.resolve()
    finish[3]()
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3])
  })

  it('backs a failed key off, doubling to the max, and forgets it on success', () => {
    const b = new KeyedBackoff()
    expect(b.due('a', 0)).toBe(true)
    b.failed('a', 0)
    expect(b.due('a', SIDE_BACKOFF_FIRST_MS - 1)).toBe(false)
    expect(b.due('a', SIDE_BACKOFF_FIRST_MS)).toBe(true)
    b.failed('a', SIDE_BACKOFF_FIRST_MS)
    expect(b.nextAt('a')).toBe(3 * SIDE_BACKOFF_FIRST_MS)
    for (let n = 0; n < 20; n++) b.failed('a', 0)
    expect(b.nextAt('a')).toBe(SIDE_BACKOFF_MAX_MS)
    b.succeeded('a')
    expect(b.due('a', 0)).toBe(true)
    expect(b.due('b', 0)).toBe(true)
  })

  it('gives up waiting at the deadline, and passes a value or error that comes first', async () => {
    vi.useFakeTimers()
    try {
      const slow = withDeadline(new Promise<number>((r) => setTimeout(() => r(1), 5000)), 2000)
      await vi.advanceTimersByTimeAsync(2000)
      await expect(slow).resolves.toBeUndefined()
      await expect(withDeadline(Promise.resolve(7), 2000)).resolves.toBe(7)
      await expect(withDeadline(Promise.reject(new Error('x')), 2000)).rejects.toThrow('x')
    } finally {
      vi.useRealTimers()
    }
  })
})
