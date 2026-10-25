// Earth's 16-bit elevation map (tides-zmw.1): the format of
// src/assets/earth-dem-*.bin, which scripts/build-earth-dem.mjs writes and
// the renderer (renderers/earthDemTexture.ts) and terrain floor read. Pure,
// so Node scripts and tests share it.
//
// A file is gzip over: the magic "EDM1", width and height (uint16, little
// endian), then the heights as whole metres above sea level (uint16; the sea
// and land below it are 0), rows north first, columns from −180° east. Each
// row is stored as differences from the texel before it (mod 2^16), split
// into a plane of high bytes then one of low bytes: the high bytes are
// nearly all 0, which gzip packs far better than interleaved.

import { TERRAIN_KM_PER_GREY } from './cloud-layer'

/** Metres of elevation at displacement 1 (the old bump map's white). */
export const DEM_METRES_PER_UNIT = 1000 * TERRAIN_KM_PER_GREY

const MAGIC = 'EDM1'
const HEADER_BYTES = 8

/** Whole metres above sea level, rows north first. */
export interface EarthDem {
  width: number
  height: number
  metres: Uint16Array
}

/** One level of a height pyramid, in displacement units (DEM_METRES_PER_UNIT). */
export interface DemLevel {
  width: number
  height: number
  data: Float32Array
}

/** The uncompressed file body; the build gzips it. */
export function packEarthDem({ width, height, metres }: EarthDem): Uint8Array {
  if (metres.length !== width * height) {
    throw new Error(`DEM ${width}×${height} holds ${metres.length} heights`)
  }
  const n = width * height
  const out = new Uint8Array(HEADER_BYTES + 2 * n)
  for (let k = 0; k < 4; k++) out[k] = MAGIC.charCodeAt(k)
  const view = new DataView(out.buffer)
  view.setUint16(4, width, true)
  view.setUint16(6, height, true)
  for (let y = 0; y < height; y++) {
    let previous = 0
    for (let x = 0; x < width; x++) {
      const k = y * width + x
      const delta = (metres[k] - previous) & 0xffff
      previous = metres[k]
      out[HEADER_BYTES + k] = delta >> 8
      out[HEADER_BYTES + n + k] = delta & 0xff
    }
  }
  return out
}

/** packEarthDem's inverse. Throws on a body that isn't one. */
export function unpackEarthDem(body: Uint8Array): EarthDem {
  const magic = String.fromCharCode(...body.subarray(0, 4))
  if (body.length < HEADER_BYTES || magic !== MAGIC) throw new Error('Not an Earth DEM')
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const width = view.getUint16(4, true)
  const height = view.getUint16(6, true)
  const n = width * height
  if (body.length !== HEADER_BYTES + 2 * n) {
    throw new Error(`Earth DEM ${width}×${height}: ${body.length} bytes, expected ${HEADER_BYTES + 2 * n}`)
  }
  const metres = new Uint16Array(n)
  for (let y = 0; y < height; y++) {
    let value = 0
    for (let x = 0; x < width; x++) {
      const k = y * width + x
      value = (value + ((body[HEADER_BYTES + k] << 8) | body[HEADER_BYTES + n + k])) & 0xffff
      metres[k] = value
    }
  }
  return { width, height, metres }
}

/** Gunzip with the platform's DecompressionStream (browsers, Node 18+). */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** A shipped DEM file, gzip and all. */
export async function decodeEarthDem(file: ArrayBuffer | Uint8Array): Promise<EarthDem> {
  return unpackEarthDem(await gunzip(file instanceof Uint8Array ? file : new Uint8Array(file)))
}

/** The DEM in displacement units, the ground mesh's (rows north first). */
export function demLevel({ width, height, metres }: EarthDem): DemLevel {
  const data = new Float32Array(width * height)
  for (let k = 0; k < data.length; k++) data[k] = metres[k] / DEM_METRES_PER_UNIT
  return { width, height, data }
}

/**
 * The next mip down: each texel the mean of the 2 × 2 (or, once a side is
 * 1, the 2 × 1) it covers, as the GPU's own mips would be.
 */
export function halveLevel({ width, height, data }: DemLevel): DemLevel {
  const w = Math.max(1, width >> 1)
  const h = Math.max(1, height >> 1)
  const sx = width > 1 ? 2 : 1
  const sy = height > 1 ? 2 : 1
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let dy = 0; dy < sy; dy++) {
        for (let dx = 0; dx < sx; dx++) sum += data[(y * sy + dy) * width + x * sx + dx]
      }
      out[y * w + x] = sum / (sx * sy)
    }
  }
  return { width: w, height: h, data: out }
}

/** `base` and every box mip below it, down to 1 × 1. */
export function boxMips(base: DemLevel): DemLevel[] {
  const levels = [base]
  while (levels[levels.length - 1].width > 1 || levels[levels.length - 1].height > 1) {
    levels.push(halveLevel(levels[levels.length - 1]))
  }
  return levels
}

const _float = new Float32Array(1)
const _bits = new Uint32Array(_float.buffer)

/**
 * A height's half-float bits, rounded to the nearest (three's
 * DataUtils.toHalfFloat truncates). For 0 ≤ `value` < 65504, as heights are.
 */
export function toHalfBits(value: number): number {
  _float[0] = value
  const f = _bits[0]
  const exponent = (f >>> 23) - 112
  // Below 2^-14 halves are subnormal: steps of 2^-24 (rounding up to 2^-14
  // gives its normal bits, 0x400).
  if (exponent <= 0) return Math.round(value * 2 ** 24)
  // A carry out of the mantissa steps the exponent, as it should.
  return ((exponent << 10) | ((f >>> 13) & 0x3ff)) + ((f >>> 12) & 1)
}

/** The highest of each `factor` × `factor` block of a DEM. */
export function maxPoolDem({ width, height, metres }: EarthDem, factor: number): EarthDem {
  if (width % factor || height % factor) throw new Error(`DEM ${width}×${height} does not pool by ${factor}`)
  const w = width / factor
  const h = height / factor
  const out = new Uint16Array(w * h)
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / factor) * w
    for (let x = 0; x < width; x++) {
      const k = row + Math.floor(x / factor)
      const m = metres[y * width + x]
      if (m > out[k]) out[k] = m
    }
  }
  return { width: w, height: h, metres: out }
}

/** The mean of each `factor` × `factor` block of a DEM, to the nearest metre. */
export function meanPoolDem({ width, height, metres }: EarthDem, factor: number): EarthDem {
  if (width % factor || height % factor) throw new Error(`DEM ${width}×${height} does not pool by ${factor}`)
  const w = width / factor
  const h = height / factor
  const sum = new Float64Array(w * h)
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / factor) * w
    for (let x = 0; x < width; x++) sum[row + Math.floor(x / factor)] += metres[y * width + x]
  }
  return { width: w, height: h, metres: Uint16Array.from(sum, (s) => Math.round(s / (factor * factor))) }
}

/**
 * A DEM resampled to `width` × `height`, bilinear between texel centres as
 * a canvas draws an image scaled (wrapping east to west, held at the poles'
 * rows), to the nearest metre.
 */
export function resampleDem({ width, height, metres }: EarthDem, outWidth: number, outHeight: number): EarthDem {
  const out = new Uint16Array(outWidth * outHeight)
  for (let y = 0; y < outHeight; y++) {
    const sy = Math.min(Math.max(((y + 0.5) * height) / outHeight - 0.5, 0), height - 1)
    const j0 = Math.floor(sy)
    const j1 = Math.min(j0 + 1, height - 1)
    const fy = sy - j0
    for (let x = 0; x < outWidth; x++) {
      const sx = ((x + 0.5) * width) / outWidth - 0.5
      const i = Math.floor(sx)
      const fx = sx - i
      const i0 = (i + width) % width
      const i1 = (i + 1) % width
      const north = metres[j0 * width + i0] * (1 - fx) + metres[j0 * width + i1] * fx
      const south = metres[j1 * width + i0] * (1 - fx) + metres[j1 * width + i1] * fx
      out[y * outWidth + x] = Math.round(north * (1 - fy) + south * fy)
    }
  }
  return { width: outWidth, height: outHeight, metres: out }
}

/** The mean of each 2 × 2 block of a DEM, to the nearest metre. */
export function halveDem({ width, height, metres }: EarthDem): EarthDem {
  const w = width >> 1
  const h = height >> 1
  const out = new Uint16Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = 2 * y * width + 2 * x
      out[y * w + x] = Math.round((metres[k] + metres[k + 1] + metres[k + width] + metres[k + width + 1]) / 4)
    }
  }
  return { width: w, height: h, metres: out }
}
