import { describe, expect, test, vi } from 'vitest'
import type { CloudImage } from './cloudPipeline'
import { createCloudImageBuilder, type CloudWorker, type WorkerReply, type WorkerRequest } from './cloudWorkerClient'
import type { ImagerySource } from './realCloudController'

const source: ImagerySource = {
  kind: 'gibs',
  layer: 'VIIRS_SNPP_CorrectedReflectance_TrueColor',
  snowLayer: 'VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1',
  date: '2026-10-18',
}
const assets = { specular: 'https://x/s.jpg', day: 'https://x/d.jpg', dem: 'https://x/e.bin' }
const image = (): CloudImage => ({ rgba: new Uint8ClampedArray(4), geo: null })

function fakeWorker() {
  const sent: WorkerRequest[] = []
  const listeners: { message: ((e: { data: WorkerReply }) => void)[]; error: ((e: unknown) => void)[] } = {
    message: [],
    error: [],
  }
  const worker: CloudWorker = {
    postMessage: (m) => sent.push(m),
    addEventListener: (type: 'message' | 'error', l: (e: never) => void) => listeners[type].push(l),
    terminate: vi.fn(),
  }
  return {
    worker,
    sent,
    reply: (data: WorkerReply) => listeners.message.forEach((l) => l({ data })),
    fail: () => listeners.error.forEach((l) => l(new Event('error'))),
  }
}

describe('createCloudImageBuilder', () => {
  test('builds in the worker and resolves with its reply', async () => {
    const fake = fakeWorker()
    const inThread = vi.fn()
    const build = createCloudImageBuilder({ createWorker: () => fake.worker, inThread, assets })
    const pending = build(source, 'https://x/clouds.jpg', new AbortController().signal)
    expect(fake.sent).toEqual([{ type: 'build', id: 1, source, staticUrl: 'https://x/clouds.jpg', assets }])
    const done = image()
    fake.reply({ type: 'done', id: 1, image: done })
    await expect(pending).resolves.toBe(done)
    expect(inThread).not.toHaveBeenCalled()
  })

  test('a worker error rejects only that build', async () => {
    const fake = fakeWorker()
    const build = createCloudImageBuilder({ createWorker: () => fake.worker, inThread: vi.fn(), assets })
    const a = build(source, 'u', new AbortController().signal)
    const b = build(source, 'u', new AbortController().signal)
    fake.reply({ type: 'error', id: 1, message: 'boom' })
    await expect(a).rejects.toThrow('boom')
    fake.reply({ type: 'done', id: 2, image: null })
    await expect(b).resolves.toBeNull()
  })

  test('an abort inside the worker rejects as an AbortError', async () => {
    const fake = fakeWorker()
    const build = createCloudImageBuilder({ createWorker: () => fake.worker, inThread: vi.fn(), assets })
    const a = build(source, 'u', new AbortController().signal)
    fake.reply({ type: 'error', id: 1, message: 'replaced', name: 'AbortError' })
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('aborting cancels the worker job and ignores its late reply', async () => {
    const fake = fakeWorker()
    const build = createCloudImageBuilder({ createWorker: () => fake.worker, inThread: vi.fn(), assets })
    const abort = new AbortController()
    const pending = build(source, 'u', abort.signal)
    abort.abort()
    await expect(pending).rejects.toBe(abort.signal.reason)
    expect(fake.sent[fake.sent.length - 1]).toEqual({ type: 'cancel', id: 1 })
    // A reply that crossed the cancel is dropped.
    expect(() => fake.reply({ type: 'done', id: 1, image: image() })).not.toThrow()
  })

  test('an already-aborted build throws without posting', () => {
    const fake = fakeWorker()
    const build = createCloudImageBuilder({ createWorker: () => fake.worker, inThread: vi.fn(), assets })
    const abort = new AbortController()
    abort.abort()
    expect(() => build(source, 'u', abort.signal)).toThrow()
    expect(fake.sent).toEqual([])
  })

  test('without a worker, builds run on the main thread', async () => {
    const done = image()
    const inThread = vi.fn().mockResolvedValue(done)
    const createWorker = vi.fn(() => null)
    const build = createCloudImageBuilder({ createWorker, inThread, assets })
    await expect(build(source, 'u', new AbortController().signal)).resolves.toBe(done)
    await build(source, 'u', new AbortController().signal)
    expect(createWorker).toHaveBeenCalledTimes(1)
    expect(inThread).toHaveBeenCalledTimes(2)
  })

  test('if the worker dies, its pending builds and later ones run on the main thread', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeWorker()
    const done = image()
    const inThread = vi.fn().mockResolvedValue(done)
    const build = createCloudImageBuilder({ createWorker: () => fake.worker, inThread, assets })
    const pending = build(source, 'u', new AbortController().signal)
    fake.fail()
    await expect(pending).resolves.toBe(done)
    expect(fake.worker.terminate).toHaveBeenCalled()
    await expect(build(source, 'u', new AbortController().signal)).resolves.toBe(done)
    expect(inThread).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
