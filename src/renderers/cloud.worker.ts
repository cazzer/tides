// The cloud worker (tides-9jn.2): runs ./cloudPipeline.ts off the main thread,
// tile fetches and decodes included, and keeps its caches (the daily
// composites and the static masks) between builds. Protocol in
// ./cloudWorkerClient.ts.
import { buildCloudImage } from './cloudPipeline'
import type { WorkerReply, WorkerRequest } from './cloudWorkerClient'

const jobs = new Map<number, AbortController>()

function reply(message: WorkerReply, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer })
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data
  if (message.type === 'cancel') {
    jobs.get(message.id)?.abort()
    jobs.delete(message.id)
    return
  }
  const { id, source, staticUrl, assets } = message
  const abort = new AbortController()
  jobs.set(id, abort)
  buildCloudImage(source, staticUrl, assets, abort.signal).then(
    (image) => {
      jobs.delete(id)
      if (abort.signal.aborted) return
      if (!image) return reply({ type: 'done', id, image: null })
      reply({ type: 'done', id, image }, [image.rgba.buffer])
    },
    (err: unknown) => {
      jobs.delete(id)
      if (abort.signal.aborted) return
      reply({ type: 'error', id, message: err instanceof Error ? err.message : String(err) })
    }
  )
}
