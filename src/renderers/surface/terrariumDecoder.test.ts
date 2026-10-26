import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HorizonJob, PaddedGrid } from './terrarium'
import { createTerrariumDecoder, type DecodeReply, type DecodeRequest, type DecodeWorker } from './terrariumDecoder'

class FakeWorker implements DecodeWorker {
  posted: DecodeRequest[] = []
  transfers: (Transferable[] | undefined)[] = []
  terminated = false
  private onMessage: ((event: { data: DecodeReply }) => void)[] = []
  private onError: ((event: unknown) => void)[] = []
  postMessage(message: DecodeRequest, transfer?: Transferable[]) {
    this.posted.push(message)
    this.transfers.push(transfer)
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

describe('terrain decoder listeners (tides-zmw.9.2 review)', () => {
  it('removes its abort listener when a job settles, so the signal keeps no buffer', async () => {
    const worker = new FakeWorker()
    const decoder = createTerrariumDecoder({ createWorker: () => worker, inThread: async () => grid(-1), size: 1 })
    const abort = new AbortController()
    const add = vi.spyOn(abort.signal, 'addEventListener')
    const remove = vi.spyOn(abort.signal, 'removeEventListener')
    const pending = decoder.decode(buffer(), abort.signal)
    worker.reply({ type: 'done', id: worker.decodes()[0].id, grid: grid(1) })
    await pending
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0][1])
  })

  it('rejects every decode after dispose without decoding on the main thread', async () => {
    const inThread = vi.fn(async () => grid(9))
    const decoder = createTerrariumDecoder({ createWorker: () => new FakeWorker(), inThread })
    decoder.dispose()
    await expect(decoder.decode(buffer(), new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(inThread).not.toHaveBeenCalled()
  })
})

describe('horizon bakes in the decode workers (tides-zmw.9.15)', () => {
  const job = (): HorizonJob => ({
    tileSize: 2,
    south: 0.5,
    north: 0.75,
    context: [{ data: new Float32Array(4), width: 2, height: 2, scale: 4, offsetX: 0, offsetY: 0, minX: 0, maxX: 1, minY: 0, maxY: 1 }],
  })

  it('bakes a copy of the grid with its job, the windows and the grid transferred, and hands the map back', async () => {
    const worker = new FakeWorker()
    const decoder = createTerrariumDecoder({ createWorker: () => worker, inThread: async () => grid(-1), size: 1 })
    expect(decoder.bakes).toBe(true)
    const horizon = job()
    const own = grid(5)
    const pending = decoder.bake(horizon, own, new AbortController().signal)
    const posted = worker.posted[0] as Extract<DecodeRequest, { type: 'bake' }>
    expect(posted.type).toBe('bake')
    expect(posted.horizon).toBe(horizon)
    expect(posted.grid).toBe(own)
    expect(worker.transfers[0]).toEqual([horizon.context[0].data.buffer, own.data.buffer])
    const map = new Uint8Array(8).fill(3)
    worker.reply({ type: 'baked', id: posted.id, baked: { horizon: map, ms: 4.5, max: 3 } })
    expect(await pending).toEqual({ horizon: map, ms: 4.5, max: 3 })
    // a decode carries nothing of it
    decoder.decode(buffer(), new AbortController().signal)
    expect(worker.posted[1]).toEqual({ type: 'decode', id: expect.any(Number), buffer: expect.any(ArrayBuffer) })
  })

  it('rejects a cancelled bake as aborted and tells the worker, dropping a late reply', async () => {
    const worker = new FakeWorker()
    const decoder = createTerrariumDecoder({ createWorker: () => worker, inThread: async () => grid(-1), size: 1 })
    const abort = new AbortController()
    const pending = decoder.bake(job(), grid(1), abort.signal)
    abort.abort(new DOMException('gone', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const id = worker.posted[0].id
    expect(worker.posted[1]).toEqual({ type: 'cancel', id })
    worker.reply({ type: 'baked', id, baked: { horizon: null, ms: 1 } }) // ignored
  })

  it('gives each worker one bake at a time, so a decode waits behind one bake at most (tides-zmw.9.25)', async () => {
    const workers: FakeWorker[] = []
    const decoder = createTerrariumDecoder({
      createWorker: () => (workers.push(new FakeWorker()), workers[workers.length - 1]),
      inThread: async () => grid(-1),
    })
    const signal = new AbortController().signal
    const bakes = [0, 1, 2, 3].map(() => decoder.bake(job(), grid(1), signal))
    for (const bake of bakes) bake.catch(() => {}) // the dispose below rejects the rest
    const bakesPosted = () => workers.map((w) => w.posted.filter((m) => m.type === 'bake').length)
    expect(bakesPosted()).toEqual([1, 1])
    // a decode goes straight out, behind one bake
    decoder.decode(buffer(), signal).catch(() => {})
    expect(workers[0].decodes().length + workers[1].decodes().length).toBe(1)
    // the first bake answered: the next waiting one goes to that worker
    const [w0] = workers
    w0.reply({ type: 'baked', id: w0.posted[0].id, baked: { horizon: null, ms: 1 } })
    expect(await bakes[0]).toEqual({ horizon: null, ms: 1 })
    expect(bakesPosted()).toEqual([2, 1])
    // a waiting bake aborted never goes out; a cancelled one frees its worker
    const abort = new AbortController()
    const late = decoder.bake(job(), grid(1), abort.signal)
    abort.abort(new DOMException('gone', 'AbortError'))
    await expect(late).rejects.toMatchObject({ name: 'AbortError' })
    decoder.dispose()
    await expect(bakes[3]).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('answers waiting bakes as a dead worker does when a worker dies', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const worker = new FakeWorker()
    const decoder = createTerrariumDecoder({ createWorker: () => worker, inThread: async () => grid(9), size: 1 })
    const first = decoder.bake(job(), grid(1), new AbortController().signal)
    const waiting = decoder.bake(job(), grid(1), new AbortController().signal)
    expect(worker.posted).toHaveLength(1)
    worker.fail(new Error('worker crashed'))
    expect(await first).toBeNull()
    expect(await waiting).toBeNull()
  })

  it('bakes nothing without a worker, after one dies, or after dispose (bakes false)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const none = createTerrariumDecoder({ createWorker: () => null, inThread: async () => grid(9) })
    expect(await none.bake(job(), grid(1), new AbortController().signal)).toBeNull()
    expect(none.bakes).toBe(false)

    const worker = new FakeWorker()
    const dying = createTerrariumDecoder({ createWorker: () => worker, inThread: async () => grid(9), size: 1 })
    const bake = dying.bake(job(), grid(1), new AbortController().signal)
    worker.fail(new Error('worker crashed'))
    expect(await bake).toBeNull()
    expect(dying.bakes).toBe(false)

    const disposed = createTerrariumDecoder({ createWorker: () => new FakeWorker(), inThread: async () => grid(9) })
    disposed.dispose()
    expect(disposed.bakes).toBe(false)
    vi.restoreAllMocks()
  })
})
