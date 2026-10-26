// The imagery grade worker (tides-zmw.9.11): decodes a fetched tile, applies
// its colour match (./imagery-grade.ts, ./imagery-match.ts) and hands back a BMP or the
// pixels as a transferred buffer. A cancelled job still finishes (the decoder
// can't be interrupted) but its result is dropped.
import { gradeImage, type GradeReply, type GradeRequest } from './imagery-grade'

const active = new Set<number>()
const cancelled = new Set<number>()

self.onmessage = (event: MessageEvent<GradeRequest>) => {
  const message = event.data
  if (message.type === 'cancel') {
    if (active.has(message.id)) cancelled.add(message.id)
    return
  }
  const { id, buffer, grade, output, match } = message
  active.add(id)
  gradeImage(buffer, grade, output, match).then(
    (image) => {
      active.delete(id)
      if (cancelled.delete(id)) return
      const reply: GradeReply = { type: 'done', id, ...image }
      self.postMessage(reply, { transfer: [image.buffer] })
    },
    (err: unknown) => {
      active.delete(id)
      if (cancelled.delete(id)) return
      const reply: GradeReply = {
        type: 'error',
        id,
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : undefined,
      }
      self.postMessage(reply)
    }
  )
}
