import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { GlmBatch } from '../glm'
import { createGlmLoader, type GlmWorker, type GlmWorkerReply, type GlmWorkerRequest } from './glmWorkerClient'

const request = { url: 'https://x/f.nc', key: 'k', windowStartMs: 0 }
const batch = (): GlmBatch => ({
  source: 'glm',
  key: 'k',
  startMs: 0,
  count: 0,
  lat: new Float32Array(),
  lon: new Float32Array(),
  offsetMs: new Float32Array(),
  durationMs: new Float32Array(),
  energyJ: new Float32Array(),
  areaKm2: new Float32Array(),
  owned: new Uint8Array(),
  subpointLon: -75.2,
})

function fakeWorker() {
  const sent: GlmWorkerRequest[] = []
  const listeners: { message: ((e: { data: GlmWorkerReply }) => void)[]; error: ((e: unknown) => void)[] } = {
    message: [],
    error: [],
  }
  const worker: GlmWorker = {
    postMessage: (m) => sent.push(m),
    addEventListener: (type: 'message' | 'error', l: (e: never) => void) => listeners[type].push(l),
    terminate: vi.fn(),
  }
  return {
    worker,
    sent,
    reply: (data: GlmWorkerReply) => listeners.message.forEach((l) => l({ data })),
    fail: () => listeners.error.forEach((l) => l(new Event('error'))),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('createGlmLoader', () => {
  test('loads in the worker, started once on first use', async () => {
    const fake = fakeWorker()
    const createWorker = vi.fn(() => fake.worker)
    const inThread = vi.fn()
    const load = createGlmLoader({ createWorker, inThread })
    expect(createWorker).not.toHaveBeenCalled()
    const a = load(request, new AbortController().signal)
    const b = load(request, new AbortController().signal)
    expect(createWorker).toHaveBeenCalledTimes(1)
    expect(fake.sent).toEqual([
      { type: 'load', id: 1, ...request },
      { type: 'load', id: 2, ...request },
    ])
    const done = batch()
    fake.reply({ type: 'done', id: 2, batch: done })
    await expect(b).resolves.toBe(done)
    fake.reply({ type: 'error', id: 1, message: 'HTTP 503', name: 'Error' })
    await expect(a).rejects.toThrow('HTTP 503')
    expect(inThread).not.toHaveBeenCalled()
  })

  test('an abort cancels the job in the worker and drops its reply', async () => {
    const fake = fakeWorker()
    const load = createGlmLoader({ createWorker: () => fake.worker, inThread: vi.fn() })
    const abort = new AbortController()
    const pending = load(request, abort.signal)
    abort.abort()
    await expect(pending).rejects.toBeDefined()
    expect(fake.sent[fake.sent.length - 1]).toEqual({ type: 'cancel', id: 1 })
    fake.reply({ type: 'done', id: 1, batch: batch() })
  })

  test('without a worker, or once it dies, loads on the main thread', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const done = batch()
    const inThread = vi.fn(async () => done)
    const none = createGlmLoader({ createWorker: () => null, inThread })
    await expect(none(request, new AbortController().signal)).resolves.toBe(done)
    const fake = fakeWorker()
    const dying = createGlmLoader({ createWorker: () => fake.worker, inThread })
    const pending = dying(request, new AbortController().signal)
    fake.fail()
    await expect(pending).resolves.toBe(done)
    expect(fake.worker.terminate).toHaveBeenCalled()
    await expect(dying(request, new AbortController().signal)).resolves.toBe(done)
    expect(inThread).toHaveBeenCalledTimes(3)
  })
})

describe('the GLM worker', () => {
  test('fetches, parses and decodes a file, and posts it with its buffers transferred', async () => {
    const buf = readFileSync(new URL('../__fixtures__/glm-lcfa-g19-12.nc', import.meta.url))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(buf)))
    const postMessage = vi.fn()
    const scope: { postMessage: typeof postMessage; onmessage: ((e: { data: GlmWorkerRequest }) => void) | null } = {
      postMessage,
      onmessage: null,
    }
    vi.stubGlobal('self', scope)
    await import('./glm.worker')
    scope.onmessage!({ data: { type: 'load', id: 7, ...request } })
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1))
    const [reply, { transfer }] = postMessage.mock.calls[0] as [GlmWorkerReply, { transfer: ArrayBuffer[] }]
    expect(reply.type).toBe('done')
    const posted = (reply as { batch: GlmBatch }).batch
    expect(posted.count).toBe(12)
    expect(transfer).toEqual([posted.lat, posted.lon, posted.offsetMs, posted.durationMs, posted.energyJ, posted.areaKm2, posted.owned].map((a) => a.buffer))
  })
})
