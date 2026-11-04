// A lossless 8-bit RGB PNG's pixels, for tests that read the shipped sea ice
// mask (./seaIceLayers.test.ts, ./surface/tile-ice.test.ts). Test-only.
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import type { SeaIceMask } from '../demo/sea-ice'

/** An 8-bit RGB PNG (no interlace) as RGB bytes. */
export function decodeRgbPng(bytes: Buffer): { width: number; height: number; rgb: Uint8Array } {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('not a PNG')
  let width = 0
  let height = 0
  const data: Buffer[] = []
  for (let p = 8; p < bytes.length; ) {
    const length = bytes.readUInt32BE(p)
    const type = bytes.toString('latin1', p + 4, p + 8)
    const body = bytes.subarray(p + 8, p + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[9] !== 2 || body[12] !== 0) throw new Error('not an 8-bit RGB PNG')
    } else if (type === 'IDAT') data.push(body)
    p += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * 3
  const rgb = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= 3 ? rgb[out + x - 3] : 0
      const b = y ? rgb[out - stride + x] : 0
      const c = x >= 3 && y ? rgb[out - stride + x - 3] : 0
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
      rgb[out + x] = (row[x] + predict) & 255
    }
  }
  return { width, height, rgb }
}

/** src/assets/sea-ice-mask.png as sea-ice-data.ts loads it. */
export function shippedSeaIceMask(): SeaIceMask {
  const { width, height, rgb } = decodeRgbPng(readFileSync('src/assets/sea-ice-mask.png'))
  const rg = new Uint8Array(width * height * 2)
  for (let i = 0; i < width * height; i++) {
    rg[2 * i] = rgb[3 * i]
    rg[2 * i + 1] = rgb[3 * i + 1]
  }
  return { rg, width, height }
}
