// Main-thread side of the terrain decode workers (tides-zmw.9.2), after
// ../cloudWorkerClient.ts: hands each fetched Terrarium tile to one of a
// small pool of ./terrarium-decode.worker.ts and gets the padded grid back as
// a transferred buffer, so the image decode and the 262k-pixel read-back
// never block a frame. An aborted decode is cancelled in its worker. Without
// a usable worker (no module workers or no OffscreenCanvas 2D: Safari before
// 16.4), or if one dies, decodes run on the main thread instead. No DOM
// here, so it is testable with a fake worker.
//
// tides-zmw.9.15: bake() makes a grid's horizon map (terrarium.ts
// bakeTileHorizon) in a worker from a copy of the grid and its job (where
// the grid is, and windows of its neighbours' and ancestors' grids), all
// transferred. It is separate from the decode, so a grid never waits on its
// context. On the main thread (no worker) nothing is baked (bakes is false
// and bake() answers null): a bake is ~10 ms, and the horizon only adds
// detail (tile-shadow.ts).
import type { HorizonJob, PaddedGrid } from './terrarium'

export type DecodeRequest =
  | { type: 'decode'; id: number; buffer: ArrayBuffer }
  | { type: 'bake'; id: number; horizon: HorizonJob; grid: PaddedGrid | null }
  | { type: 'cancel'; id: number }

/** What a bake hands back: the map (null: no horizon anywhere), its worker time, and its highest byte. */
export interface BakedHorizon {
  horizon: Uint8Array<ArrayBuffer> | null
  ms: number
  /** The map's highest byte (none: take 255). */
  max?: number
}

export type DecodeReply =
  | { type: 'done'; id: number; grid: PaddedGrid }
  | { type: 'baked'; id: number; baked: BakedHorizon }
  | { type: 'error'; id: number; message: string; name?: string }


/** The part of Worker the client uses. */
export interface DecodeWorker {
  postMessage(message: DecodeRequest, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: { data: DecodeReply }) => void): void
  addEventListener(type: 'error', listener: (event: unknown) => void): void
  terminate(): void
}

export type TerrariumDecode = (buffer: ArrayBuffer, signal: AbortSignal) => Promise<PaddedGrid>
/** A horizon map for `grid` (a copy: transferred, as the job's windows are), or null where no worker bakes. */
export type TerrariumBake = (horizon: HorizonJob, grid: PaddedGrid | null, signal: AbortSignal) => Promise<BakedHorizon | null>

export interface TerrariumDecoder {
  decode: TerrariumDecode
  bake: TerrariumBake
  /** Whether a bake would run (a worker is up or can be made, not disposed): false, and nothing need be gathered for one. */
  readonly bakes: boolean
  /** Terminates the workers; decodes still pending reject with an AbortError. */
  dispose(): void
}

interface Job {
  /** The job on the main thread (a dead worker's orphans): its closure holds the buffer. */
  inThread: () => Promise<unknown>
  signal: AbortSignal
  /** Removed once the job settles. */
  onAbort: () => void
  resolve: (result: PaddedGrid | BakedHorizon | null) => void
  reject: (err: unknown) => void
}

const disposedError = () => new DOMException('terrain decoder disposed', 'AbortError')

interface Slot {
  worker: DecodeWorker
  jobs: Map<number, Job>
}

/** Two workers: decodes overlap with downloads without crowding the page's cores. */
export const DECODE_WORKERS = 2

/**
 * createWorker returns null where a worker can't decode; it is called on
 * demand, up to `size` times. inThread decodes on the main thread.
 */
export function createTerrariumDecoder({
  createWorker,
  inThread,
  size = DECODE_WORKERS,
}: {
  createWorker: () => DecodeWorker | null
  inThread: (buffer: ArrayBuffer) => Promise<PaddedGrid>
  size?: number
}): TerrariumDecoder {
  const slots: Slot[] = []
  // false once a worker can't be made or has died: everything runs in thread
  let workersOk = true
  let disposed = false
  let nextId = 1

  /** Drops the job's abort listener (and with it the buffer). */
  function detach(job: Job) {
    job.signal.removeEventListener('abort', job.onAbort)
  }

  function runInThread(job: Job) {
    job.signal.throwIfAborted()
    job.inThread().then((result) => job.resolve(result as PaddedGrid | BakedHorizon | null), job.reject)
  }

  function fallBack(err: unknown) {
    console.warn('surface tiles: terrain decode worker failed; decoding on the main thread', err)
    workersOk = false
    const orphans: Job[] = []
    for (const slot of slots.splice(0)) {
      slot.worker.terminate()
      orphans.push(...slot.jobs.values())
    }
    for (const job of orphans) {
      detach(job)
      try {
        runInThread(job)
      } catch (abort) {
        job.reject(abort)
      }
    }
  }

  function start(): Slot | null {
    try {
      const worker = createWorker()
      if (!worker) return null
      const slot: Slot = { worker, jobs: new Map() }
      worker.addEventListener('message', ({ data }) => {
        const job = slot.jobs.get(data.id)
        // Cancelled: the reply (and its buffer) is dropped.
        if (!job) return
        slot.jobs.delete(data.id)
        detach(job)
        if (data.type === 'done') job.resolve(data.grid)
        else if (data.type === 'baked') job.resolve(data.baked)
        else job.reject(Object.assign(new Error(data.message), { name: data.name ?? 'Error' }))
      })
      worker.addEventListener('error', fallBack)
      return slot
    } catch (err) {
      console.warn('surface tiles: no terrain decode worker; decoding on the main thread', err)
      return null
    }
  }

  /** The idlest worker, starting another while the pool has room. */
  function pick(): Slot | null {
    let best: Slot | null = null
    for (const slot of slots) if (!best || slot.jobs.size < best.jobs.size) best = slot
    if ((!best || best.jobs.size > 0) && slots.length < size) {
      const slot = start()
      if (slot) {
        slots.push(slot)
        return slot
      }
      if (slots.length === 0) workersOk = false
    }
    return best
  }

  /** Posts a job to the idlest worker, or runs `fallback` here. */
  function post<T extends PaddedGrid | BakedHorizon | null>(
    signal: AbortSignal,
    request: (id: number) => DecodeRequest,
    transfer: Transferable[],
    fallback: () => Promise<T>
  ): Promise<T> {
    // After dispose, nothing decodes (least of all on the main thread).
    if (disposed) return Promise.reject(disposedError())
    signal.throwIfAborted()
    const slot = workersOk ? pick() : null
    if (!slot) return fallback()
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!slot.jobs.delete(id)) return
        slot.worker.postMessage({ type: 'cancel', id })
        reject(signal.reason)
      }
      slot.jobs.set(id, { inThread: fallback, signal, onAbort, resolve: resolve as Job['resolve'], reject })
      signal.addEventListener('abort', onAbort, { once: true })
      slot.worker.postMessage(request(id), transfer)
    })
  }

  return {
    decode(buffer, signal) {
      // The buffer is copied, not transferred (a WebP tile is ~10-300 kB):
      // if the worker dies, its jobs are decoded here from the same buffer.
      return post<PaddedGrid>(signal, (id) => ({ type: 'decode', id, buffer }), [], () => inThread(buffer))
    },
    bake(horizon, grid, signal) {
      // the job's own copies, transferred (a dead worker's bake answers null)
      const transfer: Transferable[] = horizon.context.map((w) => w.data.buffer)
      if (grid) transfer.push(grid.data.buffer)
      return post<BakedHorizon | null>(signal, (id) => ({ type: 'bake', id, horizon, grid }), transfer, async () => null)
    },
    get bakes() {
      return workersOk && !disposed
    },
    dispose() {
      disposed = true
      workersOk = false
      for (const slot of slots.splice(0)) {
        slot.worker.terminate()
        for (const job of slot.jobs.values()) {
          detach(job)
          job.reject(disposedError())
        }
        slot.jobs.clear()
      }
    },
  }
}
