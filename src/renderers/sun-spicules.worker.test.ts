import { afterEach, describe, expect, it, vi } from 'vitest'
import { spiculeArrays, type SpiculeArrays } from './sun-spicules'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('the spicule worker (tides-9yw)', () => {
  it('posts the same layout as the main thread builds, its buffers transferred', async () => {
    const postMessage = vi.fn()
    const scope: { postMessage: typeof postMessage; onmessage: (() => void) | null } = { postMessage, onmessage: null }
    vi.stubGlobal('self', scope)
    await import('./sun-spicules.worker')
    scope.onmessage!()
    expect(postMessage).toHaveBeenCalledTimes(1)
    const [posted, { transfer }] = postMessage.mock.calls[0] as [SpiculeArrays, { transfer: ArrayBuffer[] }]
    const built = spiculeArrays()
    expect(posted.count).toBe(built.count)
    expect(transfer).toEqual([posted.spicule.buffer, posted.lean.buffer, posted.size.buffer])
    // Checksums: comparing ~1M floats one by one is slow.
    const sum = (array: Float32Array) => array.reduce((total, v, i) => total + v * ((i % 7) + 1), 0)
    for (const name of ['spicule', 'lean', 'size'] as const) expect(sum(posted[name])).toBe(sum(built[name]))
  })
})
