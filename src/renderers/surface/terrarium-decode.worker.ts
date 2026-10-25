// The terrain decode worker (tides-zmw.9.2): turns a fetched Terrarium tile
// into a padded elevation grid (./terrarium.ts) off the main thread and hands
// the floats back as a transferred buffer. Protocol in ./terrariumDecoder.ts.
// A cancelled job still finishes its decode (the image decoder can't be
// interrupted) but its result is dropped here rather than posted.
import { decodeTerrariumImage } from './terrarium'
import type { DecodeReply, DecodeRequest } from './terrariumDecoder'

const active = new Set<number>()
const cancelled = new Set<number>()

function reply(message: DecodeReply, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer })
}

self.onmessage = (event: MessageEvent<DecodeRequest>) => {
  const message = event.data
  if (message.type === 'cancel') {
    // only a job still decoding: a late cancel (the reply crossed it) is moot
    if (active.has(message.id)) cancelled.add(message.id)
    return
  }
  const { id, buffer } = message
  active.add(id)
  decodeTerrariumImage(buffer).then(
    (grid) => {
      active.delete(id)
      if (cancelled.delete(id)) return
      reply({ type: 'done', id, grid }, [grid.data.buffer])
    },
    (err: unknown) => {
      active.delete(id)
      if (cancelled.delete(id)) return
      reply({
        type: 'error',
        id,
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      })
    }
  )
}
