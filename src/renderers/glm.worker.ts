// The GLM worker (tides-ufyr.13): downloads, parses and decodes lightning
// files off the main thread (./glmFile.ts), and hands each window's flashes
// back in transferred buffers. Protocol in ./glmWorkerClient.ts.
import { batchTransfer } from '../glm'
import { loadGlmBatch } from './glmFile'
import type { GlmWorkerReply, GlmWorkerRequest } from './glmWorkerClient'

const jobs = new Map<number, AbortController>()

function reply(message: GlmWorkerReply, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer })
}

self.onmessage = (event: MessageEvent<GlmWorkerRequest>) => {
  const message = event.data
  if (message.type === 'cancel') {
    jobs.get(message.id)?.abort()
    jobs.delete(message.id)
    return
  }
  const { id, url, key, windowStartMs } = message
  const abort = new AbortController()
  jobs.set(id, abort)
  loadGlmBatch({ url, key, windowStartMs }, abort.signal).then(
    (batch) => {
      jobs.delete(id)
      if (abort.signal.aborted) return
      reply({ type: 'done', id, batch }, batchTransfer(batch))
    },
    (err: unknown) => {
      jobs.delete(id)
      if (abort.signal.aborted) return
      reply({
        type: 'error',
        id,
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      })
    }
  )
}
