import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaddedGrid } from './terrarium'
import { createTerrariumDecoder, type DecodeReply, type DecodeRequest, type DecodeWorker } from './terrariumDecoder'

class FakeWorker implements DecodeWorker {
  posted: DecodeRequest[] = []
  terminated = false
  private onMessage: ((event: { data: DecodeReply }) => void)[] = []
  private onError: ((event: unknown) => void)[] = []
  postMessage(message: DecodeRequest) {
    this.posted.push(message)
  }
  addEventListener(type: 'message' | 'error', listener: (event: never) => void) {
    if (type === 'message') this.onMessage.push(listener)
    else this.onError.push(listener)
  }
  terminate() {
    this.terminated = true
  }
  reply(data: DecodeReply) {
    for (const l of this.onMessage) l({ data })
  }
  fail(err: unknown) {
    for (const l of this.onError) l(err)
  }
  decodes() {
    return this.posted.filter((m) => m.type === 'decode') as Extract<DecodeRequest, { type: 'decode' }>[]
  }
}

const grid = (v: number): PaddedGrid => ({ data: new Float32Array(4).fill(v), width: 2, height: 2 })
const buffer = () => new Uint8Array([1, 2, 3]).buffer

describe('terrain decoder client (tides-zmw.9.2)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('spreads decodes over a pool of two workers and resolves each by id', async () => {
    const workers: FakeWorker[] = []
    const decoder = createTerrariumDecoder({
      createWorker: () => (workers.push(new FakeWorker()), workers[workers.length - 1]),
      inThread: async () => grid(-1),
    })
    const signal = new AbortController().signal
    const a = decoder.decode(buffer(), signal)
    const b = decoder.decode(buffer(), signal)
    const c = decoder.decode(buffer(), signal)
    expect(workers).toHaveLength(2)
    expect(workers.map((w) => w.decodes().length)).toEqual([2, 1])
    const [w0, w1] = workers
    w1.reply({ type: 'done', id: w1.decodes()[0].id, grid: grid(2) })
    w0.reply({ type: 'done', id: w0.decodes()[1].id, grid: grid(3) })
    w0.reply({ type: 'done', id: w0.decodes()[0].id, grid: grid(1) })
    expect((await a).data[0]).toBe(1)
    expect((await b).data[0]).toBe(2)
    expect((await c).data[0]).toBe(3)
  })

  it('cancels an aborted decode in its worker and drops the late reply', async () => {
    const worker = new FakeWorker()
    const decoder = createTerrariumDecoder({ createWorker: () => worker, inThread: async () => grid(-1), size: 1 })
    const abort = new AbortController()
    const pending = decoder.decode(buffer(), abort.signal)
    abort.abort(new DOMException('gone', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const id = worker.decodes()[0].id
    expect(worker.posted[worker.posted.length - 1]).toEqual({ type: 'cancel', id })
    worker.reply({ type: 'done', id, grid: grid(1) }) // ignored
    expect(() => decoder.decode(buffer(), abort.signal)).toThrow()
  })

  it('passes a worker error on with its name', async () => {
    const worker = new FakeWorker()
    const decoder = createTerrariumDecoder({ createWorker: () => worker, inThread: async () => grid(-1), size: 1 })
    const pending = decoder.decode(buffer(), new AbortController().signal)
    worker.reply({ type: 'error', id: worker.decodes()[0].id, message: 'bad webp', name: 'EncodingError' })
    await expect(pending).rejects.toMatchObject({ message: 'bad webp', name: 'EncodingError' })
  })

  it('decodes on the main thread without a worker, or after one dies', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const inThread = vi.fn(async () => grid(9))
    const none = createTerrariumDecoder({ createWorker: () => null, inThread })
    expect((await none.decode(buffer(), new AbortController().signal)).data[0]).toBe(9)

    const worker = new FakeWorker()
    const dying = createTerrariumDecoder({ createWorker: () => worker, inThread, size: 1 })
    const orphan = dying.decode(buffer(), new AbortController().signal)
    worker.fail(new Error('worker crashed'))
    expect(worker.terminated).toBe(true)
    expect((await orphan).data[0]).toBe(9)
    expect((await dying.decode(buffer(), new AbortController().signal)).data[0]).toBe(9)
    expect(worker.decodes()).toHaveLength(1)
  })

  it('rejects pending decodes as aborted and terminates the workers on dispose', async () => {
    const worker = new FakeWorker()
    const decoder = createTerrariumDecoder({ createWorker: () => worker, inThread: async () => grid(-1), size: 1 })
    const pending = decoder.decode(buffer(), new AbortController().signal)
    decoder.dispose()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(worker.terminated).toBe(true)
  })
})
