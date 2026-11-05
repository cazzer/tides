// The latest observation as the cloud worker keeps it for the forecast frames
// of its hour (./cloudPipeline.ts, tides-0oi.23). A forecast frame reads only
// the observation's G (its cloud alpha), so that stays a plain byte plane.
// The rest (R: cloud-top height, B: geostationary coverage, A) is only read
// back whole by a held frame, the observation passed through unchanged for
// want of a forecast, so it is kept deflated, and not at all where it is G
// again (a daily composite is grey and opaque). Lossless both ways: a held
// frame is the observation byte for byte. Pure, for the worker and the main
// thread alike.
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
  /** Null where every pixel has R = B = G and A = 255. Never rejects. */
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

/** rgba (RGBA) is only read, and is let go once rest settles. */
export function packObservation(rgba: ArrayLike<number>): PackedObservation {
  return { alpha: alphaBytes(rgba), rest: isGreyOpaque(rgba) ? null : restOf(rgba) }
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** A new RGBA copy of the packed observation, the same bytes it was packed
 * from. */
export async function unpackObservation({
  alpha,
  rest,
}: PackedObservation): Promise<Uint8ClampedArray<ArrayBuffer>> {
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
  const planes = deflated ? await inflate(bytes) : bytes
  if (planes.length !== n * REST_CHANNELS.length) {
    throw new Error(`observation planes are ${planes.length} bytes, not ${n * REST_CHANNELS.length}`)
  }
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    out[i] = planes[p]
    out[i + 1] = alpha[p]
    out[i + 2] = planes[n + p]
    out[i + 3] = planes[2 * n + p]
  }
  return out
}
