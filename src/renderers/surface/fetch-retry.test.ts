import { describe, expect, it } from 'vitest'
import { eitherSignal, fetchWithRetry, isTransientStatus } from './fetch-retry'

describe('fetch retry (tides-zmw.9.2)', () => {
  it('retries transient statuses and network errors, then lets the last answer stand', async () => {
    expect([429, 500, 503].every(isTransientStatus)).toBe(true)
    expect([200, 403, 404].some(isTransientStatus)).toBe(false)
    let n = 0
    const res = await fetchWithRetry(async () => (++n < 3 ? new Response(null, { status: 503 }) : new Response('ok')), null, [0, 0])
    expect([n, res.status]).toEqual([3, 200])
    n = 0
    const last = await fetchWithRetry(async () => (n++, new Response(null, { status: 502 })), null, [0, 0])
    expect([n, last.status]).toEqual([3, 502])
    n = 0
    await expect(
      fetchWithRetry(async () => {
        n++
        throw new TypeError('Failed to fetch')
      }, null, [0])
    ).rejects.toThrow('Failed to fetch')
    expect(n).toBe(2)
  })

  it('combines two signals, with or without AbortSignal.any', () => {
    const a = new AbortController()
    const b = new AbortController()
    const { signal } = eitherSignal(a.signal, b.signal)
    b.abort('b')
    expect([signal.aborted, signal.reason]).toEqual([true, 'b'])
    const any = (AbortSignal as unknown as { any?: unknown }).any
    try {
      ;(AbortSignal as unknown as { any?: unknown }).any = undefined
      const c = new AbortController()
      const d = new AbortController()
      const both = eitherSignal(c.signal, d.signal)
      c.abort('c')
      expect([both.signal.aborted, both.signal.reason]).toEqual([true, 'c'])
      const e = new AbortController()
      const f = new AbortController()
      const kept = eitherSignal(e.signal, f.signal)
      kept.release()
      f.abort('f')
      expect(kept.signal.aborted).toBe(false)
    } finally {
      ;(AbortSignal as unknown as { any?: unknown }).any = any
    }
  })
})
