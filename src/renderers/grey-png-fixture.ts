// A lossless 8-bit grey PNG's levels, for tests that read the shipped depth
// maps (./waterDepth.test.ts, ./waterRefraction.test.ts).
import { inflateSync } from 'node:zlib'
import { expect } from 'vitest'

/** An 8-bit grey PNG's levels (no interlace): enough for the shipped maps. */
export function decodeGreyPng(bytes: Buffer) {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  let width = 0
  let height = 0
  let depth = 0
  let colour = -1
  let interlace = -1
  const data: Buffer[] = []
  for (let p = 8; p < bytes.length; ) {
    const length = bytes.readUInt32BE(p)
    const type = bytes.toString('latin1', p + 4, p + 8)
    const body = bytes.subarray(p + 8, p + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      depth = body[8]
      colour = body[9]
      interlace = body[12]
    } else if (type === 'IDAT') data.push(body)
    p += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const levels = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (width + 1)]
    const row = raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1))
    const out = y * width
    for (let x = 0; x < width; x++) {
      const a = x ? levels[out + x - 1] : 0
      const b = y ? levels[out - width + x] : 0
      const c = x && y ? levels[out - width + x - 1] : 0
      let predict = 0
      if (filter === 1) predict = a
      else if (filter === 2) predict = b
      else if (filter === 3) predict = (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        predict = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      levels[out + x] = (row[x] + predict) & 255
    }
  }
  return { width, height, depth, colour, interlace, levels }
}
