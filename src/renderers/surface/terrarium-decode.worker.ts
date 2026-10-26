// The terrain decode worker (tides-zmw.9.2): turns a fetched Terrarium tile
// into a padded elevation grid (./terrarium.ts) off the main thread and hands
// the floats back as a transferred buffer; and bakes grids' horizon maps
// (tides-zmw.9.15, ./terrarium.ts bakeTileHorizon). Protocol in
// ./terrariumDecoder.ts.
// A cancelled job still finishes its decode (the image decoder can't be
// interrupted) but its result is dropped here rather than posted.
import { bakeTileHorizon, decodeTerrariumImage, type HorizonJob, type PaddedGrid } from './terrarium'
import type { BakedHorizon, DecodeReply, DecodeRequest } from './terrariumDecoder'

const active = new Set<number>()
const cancelled = new Set<number>()

function reply(message: DecodeReply, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer })
}

function bake(job: HorizonJob, grid: PaddedGrid | null): BakedHorizon {
  const t0 = performance.now()
  const horizon = bakeTileHorizon(job, grid)
  let max = 0
  if (horizon) for (let i = 0; i < horizon.length; i++) if (horizon[i] > max) max = horizon[i]
  return { horizon, ms: performance.now() - t0, max }
}

self.onmessage = (event: MessageEvent<DecodeRequest>) => {
  const message = event.data
  if (message.type === 'cancel') {
    // only a job still decoding: a late cancel (the reply crossed it) is moot
    if (active.has(message.id)) cancelled.add(message.id)
    return
  }
  const { id } = message
  active.add(id)
  const job =
    message.type === 'bake'
      ? Promise.resolve().then((): DecodeReply => ({ type: 'baked', id, baked: bake(message.horizon, message.grid) }))
      : decodeTerrariumImage(message.buffer).then((grid): DecodeReply => ({ type: 'done', id, grid }))
  job.then(
    (done) => {
      active.delete(id)
      if (cancelled.delete(id)) return
      const transfer: Transferable[] = []
      if (done.type === 'done') transfer.push(done.grid.data.buffer)
      if (done.type === 'baked' && done.baked.horizon) transfer.push(done.baked.horizon.buffer)
      reply(done, transfer)
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
