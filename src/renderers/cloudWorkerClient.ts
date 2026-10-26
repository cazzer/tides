// Main-thread side of the cloud worker (tides-9jn.2): hands builds to
// ./cloud.worker.ts and gets the finished pixels back as a transferred
// buffer, so decoding and compositing (~1 s of CPU and ~60-80 MB of scratch
// per build) never block a frame. An aborted build is cancelled in the
// worker, which stops at its next step. Without a usable worker, or if it
// dies, builds run on the main thread instead. No DOM here, so it is
// testable with a fake worker.
import type { CloudAssets, CloudImage } from './cloudPipeline'
import type { ImagerySource } from './realCloudController'

export type WorkerRequest =
  | { type: 'build'; id: number; source: ImagerySource; staticUrl: string; assets: CloudAssets }
  | { type: 'cancel'; id: number }

export type WorkerReply =
  | { type: 'done'; id: number; image: CloudImage | null }
  | { type: 'error'; id: number; message: string; name?: string }

/** The buffers a finished image moves (not copies) out of the worker with:
 * its pixels, and its cloud-type grid where it has one (tides-tvr.4.1). */
export function imageTransfer(image: CloudImage): ArrayBuffer[] {
  return image.types ? [image.rgba.buffer, image.types.buffer] : [image.rgba.buffer]
}

/** The part of Worker the client uses. */
export interface CloudWorker {
  postMessage(message: WorkerRequest): void
  addEventListener(type: 'message', listener: (event: { data: WorkerReply }) => void): void
  addEventListener(type: 'error', listener: (event: unknown) => void): void
  terminate(): void
}

export type CloudImageBuild = (
  source: ImagerySource,
  staticUrl: string,
  signal: AbortSignal
) => Promise<CloudImage | null>

interface Job {
  source: ImagerySource
  staticUrl: string
  signal: AbortSignal
  resolve: (image: CloudImage | null) => void
  reject: (err: unknown) => void
}

/**
 * A build function for the controller. createWorker returns null where the
 * worker can't run the pipeline; it is called once, on the first build.
 * inThread runs the same pipeline on the main thread.
 */
export function createCloudImageBuilder({
  createWorker,
  inThread,
  assets,
}: {
  createWorker: () => CloudWorker | null
  inThread: CloudImageBuild
  assets: CloudAssets
}): CloudImageBuild {
  let worker: CloudWorker | null | undefined
  let nextId = 1
  const jobs = new Map<number, Job>()

  function fallBack(err: unknown) {
    console.warn('[clouds] cloud worker failed; building on the main thread', err)
    worker?.terminate()
    worker = null
    const orphans = [...jobs.values()]
    jobs.clear()
    for (const job of orphans) inThread(job.source, job.staticUrl, job.signal).then(job.resolve, job.reject)
  }

  function start(): CloudWorker | null {
    try {
      const w = createWorker()
      if (!w) return null
      w.addEventListener('message', ({ data }) => {
        const job = jobs.get(data.id)
        // Cancelled: the reply (and its buffer) is dropped.
        if (!job) return
        jobs.delete(data.id)
        if (data.type === 'done') job.resolve(data.image)
        // The name survives, so an AbortError (a build abandoned inside the
        // worker) is still recognisable as one.
        else job.reject(Object.assign(new Error(data.message), { name: data.name ?? 'Error' }))
      })
      w.addEventListener('error', fallBack)
      return w
    } catch (err) {
      console.warn('[clouds] no cloud worker; building on the main thread', err)
      return null
    }
  }

  return (source, staticUrl, signal) => {
    signal.throwIfAborted()
    if (worker === undefined) worker = start()
    if (!worker) return inThread(source, staticUrl, signal)
    const w = worker
    const id = nextId++
    return new Promise<CloudImage | null>((resolve, reject) => {
      jobs.set(id, { source, staticUrl, signal, resolve, reject })
      signal.addEventListener(
        'abort',
        () => {
          if (!jobs.delete(id)) return
          w.postMessage({ type: 'cancel', id })
          reject(signal.reason)
        },
        { once: true }
      )
      w.postMessage({ type: 'build', id, source, staticUrl, assets })
    })
  }
}
