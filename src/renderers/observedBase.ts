// The latest observation as the cloud pipeline keeps it for the forecast
// frames of its hour (./cloudPipeline.ts, tides-0oi.23). A forecast frame
// reads only the observation's G (its cloud alpha), so that stays a plain byte
// plane. The rest (R: cloud-top height, B: geostationary coverage, A) is only
// read back whole by a held frame, the observation passed through unchanged
// for want of a forecast. The worker keeps it deflated, and not at all where
// it is G again (a daily composite is grey and opaque); the main thread (no
// worker) keeps the observation as is rather than spend a frame's time
// deflating. Lossless every way: a held frame is the observation byte for
// byte. Pure, for the worker and the main thread alike.
import { alphaBytes } from './cloudCover'

/** The observation's R, B and A planes one after another, deflated (raw
 * deflate) where the platform can. */
export interface ObservationRest {
  bytes: Uint8Array<ArrayBuffer>
  deflated: boolean
}

export interface PackedObservation {
  /** G, a byte per pixel in the observation's order. */
  alpha: Uint8Array<ArrayBuffer>
  /** The observation itself, kept whole (deflate off); only read. */
  rgba?: ArrayLike<number>
  /** Null where it is kept whole, or where every pixel has R = B = G and
   * A = 255. Rejects only if the planes can't be had at all (out of
   * memory); a held frame's unpack then rejects too. */
  rest: Promise<ObservationRest> | null
}

const REST_CHANNELS = [0, 2, 3] as const

function isGreyOpaque(rgba: ArrayLike<number>): boolean {
  for (let i = 0; i < rgba.length; i += 4) {
    const g = rgba[i + 1]
    if (rgba[i] !== g || rgba[i + 2] !== g || rgba[i + 3] !== 255) return false
  }
  return true
}

function plane(rgba: ArrayLike<number>, channel: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(rgba.length / 4)
  for (let p = 0, i = channel; p < out.length; p++, i += 4) out[p] = rgba[i]
  return out
}

/** One plane at a time, so the planes are never all held undeflated. */
async function deflatePlanes(rgba: ArrayLike<number>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new CompressionStream('deflate-raw')
  const deflated = new Response(stream.readable).arrayBuffer()
  const writer = stream.writable.getWriter()
  try {
    for (const channel of REST_CHANNELS) await writer.write(plane(rgba, channel))
    await writer.close()
  } catch (err) {
    deflated.catch(() => {})
    throw err
  }
  return new Uint8Array(await deflated)
}

function rawPlanes(rgba: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  const n = rgba.length / 4
  const out = new Uint8Array(n * REST_CHANNELS.length)
  REST_CHANNELS.forEach((channel, k) => out.set(plane(rgba, channel), k * n))
  return out
}

async function restOf(rgba: ArrayLike<number>): Promise<ObservationRest> {
  if (typeof CompressionStream === 'function') {
    try {
      return { bytes: await deflatePlanes(rgba), deflated: true }
    } catch (err) {
      console.warn('[clouds] keeping the observation undeflated', err)
    }
  }
  return { bytes: rawPlanes(rgba), deflated: false }
}

/** rgba (RGBA) is only read. With deflate (the worker) the rest is deflated
 * and rgba let go once that settles; without (the main thread) rgba is kept
 * whole, and nothing is deflated. */
export function packObservation(
  rgba: ArrayLike<number>,
  { deflate }: { deflate: boolean }
): PackedObservation {
  const alpha = alphaBytes(rgba)
  if (!deflate) return { alpha, rgba, rest: null }
  if (isGreyOpaque(rgba)) return { alpha, rest: null }
  const rest = restOf(rgba)
  // Awaited only by held frames, which may never come.
  rest.catch(() => {})
  return { alpha, rest }
}

/** Writes chunk, the R, B and A planes (one after another) from offset from
 * on, into out's R, B and A. */
function scatterPlanes(out: Uint8ClampedArray, n: number, chunk: Uint8Array, from: number): void {
  for (let k = 0, offset = from; k < chunk.length; ) {
    const index = Math.floor(offset / n)
    const p = offset - index * n
    const count = Math.min(chunk.length - k, n - p)
    const channel = REST_CHANNELS[index]
    for (let j = 0, i = p * 4 + channel; j < count; j++, i += 4) out[i] = chunk[k + j]
    k += count
    offset += count
  }
}

/** A new RGBA copy of the packed observation, the same bytes it was packed
 * from. Throws when aborted. */
export async function unpackObservation(
  { alpha, rgba, rest }: PackedObservation,
  signal?: AbortSignal
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  signal?.throwIfAborted()
  if (rgba) return new Uint8ClampedArray(rgba)
  const n = alpha.length
  const out = new Uint8ClampedArray(n * 4)
  if (!rest) {
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      out[i] = out[i + 1] = out[i + 2] = alpha[p]
      out[i + 3] = 255
    }
    return out
  }
  const { bytes, deflated } = await rest
  signal?.throwIfAborted()
  const size = n * REST_CHANNELS.length
  for (let p = 0, i = 1; p < n; p++, i += 4) out[i] = alpha[p]
  if (!deflated) {
    if (bytes.length !== size) throw new Error(`observation planes are ${bytes.length} bytes, not ${size}`)
    scatterPlanes(out, n, bytes, 0)
    return out
  }
  // Chunk by chunk straight into out, so the inflated planes are never held
  // whole.
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      signal?.throwIfAborted()
      if (length + value.length > size) throw new Error(`observation planes are over ${size} bytes`)
      scatterPlanes(out, n, value, length)
      length += value.length
    }
  } catch (err) {
    reader.cancel().catch(() => {})
    throw err
  }
  if (length !== size) throw new Error(`observation planes are ${length} bytes, not ${size}`)
  return out
}
