// Main-thread side of the GLM worker (tides-ufyr.13): hands file downloads
// to ./glm.worker.ts, which fetches, parses (jsfive, ~40 ms a file) and
// decodes them, and gets the flashes back in transferred buffers. Aborting
// cancels the job in the worker. Without a usable worker, or if it dies,
// files load on the main thread instead. No DOM here, so it is testable with
// a fake worker. Patterned on ./cloudWorkerClient.ts.
import type { GlmBatch } from '../glm'
import type { GlmLoadRequest } from './glmFile'

export type GlmWorkerRequest = ({ type: 'load'; id: number } & GlmLoadRequest) | { type: 'cancel'; id: number }

export type GlmWorkerReply =
  | { type: 'done'; id: number; batch: GlmBatch }
  | { type: 'error'; id: number; message: string; name?: string }

/** The part of Worker the client uses. */
export interface GlmWorker {
  postMessage(message: GlmWorkerRequest): void
  addEventListener(type: 'message', listener: (event: { data: GlmWorkerReply }) => void): void
  addEventListener(type: 'error', listener: (event: unknown) => void): void
  terminate(): void
}

export type GlmBatchLoad = (request: GlmLoadRequest, signal: AbortSignal) => Promise<GlmBatch>

interface Job {
  request: GlmLoadRequest
  signal: AbortSignal
  resolve: (batch: GlmBatch) => void
  reject: (err: unknown) => void
}

/**
 * A file loader for the feed. createWorker returns null where no worker can
 * run; it is called once, on the first load. inThread does the same work on
 * the main thread.
 */
export function createGlmLoader({
  createWorker,
  inThread,
}: {
  createWorker: () => GlmWorker | null
  inThread: GlmBatchLoad
}): GlmBatchLoad {
  let worker: GlmWorker | null | undefined
  let nextId = 1
  const jobs = new Map<number, Job>()

  function fallBack(err: unknown) {
    console.warn('[lightning] GLM worker failed; loading on the main thread', err)
    worker?.terminate()
    worker = null
    const orphans = [...jobs.values()]
    jobs.clear()
    for (const job of orphans) inThread(job.request, job.signal).then(job.resolve, job.reject)
  }

  function start(): GlmWorker | null {
    try {
      const w = createWorker()
      if (!w) return null
      w.addEventListener('message', ({ data }) => {
        const job = jobs.get(data.id)
        if (!job) return
        jobs.delete(data.id)
        if (data.type === 'done') job.resolve(data.batch)
        else job.reject(Object.assign(new Error(data.message), { name: data.name ?? 'Error' }))
      })
      w.addEventListener('error', fallBack)
      return w
    } catch (err) {
      console.warn('[lightning] no GLM worker; loading on the main thread', err)
      return null
    }
  }

  return (request, signal) => {
    signal.throwIfAborted()
    if (worker === undefined) worker = start()
    if (!worker) return inThread(request, signal)
    const w = worker
    const id = nextId++
    return new Promise<GlmBatch>((resolve, reject) => {
      jobs.set(id, { request, signal, resolve, reject })
      signal.addEventListener(
        'abort',
        () => {
          if (!jobs.delete(id)) return
          w.postMessage({ type: 'cancel', id })
          reject(signal.reason)
        },
        { once: true }
      )
      w.postMessage({ type: 'load', id, ...request })
    })
  }
}
