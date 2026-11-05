import { afterEach, describe, expect, test, vi } from 'vitest'
import { OUT_H, OUT_W } from '../real-clouds'
import { imageOf } from './cloudPipeline'
import { packObservation, unpackObservation } from './observedBase'

const pixels = OUT_W * OUT_H
/** As the worker packs. */
const DEFLATE = { deflate: true }
const at = (p: number, seed: number) => (Math.imul(p ^ seed, 2654435761) >>> 0) / 4294967296

/** Like a geostationary build: R heights, G alpha, B coverage, all different;
 * A opaque. */
function geoLike() {
  const rgba = new Uint8ClampedArray(pixels * 4)
  for (let p = 0; p < pixels; p++) {
    rgba[p * 4] = 255 * at(p, 1)
    rgba[p * 4 + 1] = 255 * at(p, 2)
    // Coverage is mostly whole or none.
    rgba[p * 4 + 2] = p % OUT_W < OUT_W / 3 ? 255 : p % OUT_W < OUT_W / 2 ? 255 * at(p, 3) : 0
    rgba[p * 4 + 3] = 255
  }
  return rgba
}

/** Like a daily composite: grey and opaque. */
function greyLike() {
  const rgba = new Uint8ClampedArray(pixels * 4)
  for (let p = 0; p < pixels; p++) {
    rgba[p * 4] = rgba[p * 4 + 1] = rgba[p * 4 + 2] = 255 * at(p, 2)
    rgba[p * 4 + 3] = 255
  }
  return rgba
}

/** The held frame as it was made before tides-0oi.23, from a copy of the
 * whole observation, against the one made from the packed observation. */
async function heldFrames(rgba: Uint8ClampedArray) {
  const before = imageOf(new Uint8ClampedArray(rgba), null)
  const after = imageOf(await unpackObservation(packObservation(rgba, DEFLATE)), null)
  return { before, after }
}

describe('packObservation', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('a held frame from a geostationary observation is the same bytes, and the rest is deflated', async () => {
    const rgba = geoLike()
    const packed = packObservation(rgba, DEFLATE)
    expect(packed.alpha.length).toBe(pixels)
    const rest = await packed.rest
    expect(rest?.deflated).toBe(true)
    expect(rest!.bytes.length).toBeLessThan(pixels * 3)
    const { before, after } = await heldFrames(rgba)
    expect(Buffer.from(after.rgba).equals(Buffer.from(before.rgba))).toBe(true)
    expect(Buffer.from(after.cover!).equals(Buffer.from(before.cover!))).toBe(true)
  })

  test('a grey, opaque observation keeps only G and still gives the same held frame', async () => {
    const rgba = greyLike()
    expect(packObservation(rgba, DEFLATE).rest).toBeNull()
    const { before, after } = await heldFrames(rgba)
    expect(Buffer.from(after.rgba).equals(Buffer.from(before.rgba))).toBe(true)
  })

  test('one pixel off grey, or not opaque, keeps the rest', async () => {
    for (const i of [4 * 1234 + 3, 4 * 99 + 2, 0]) {
      const rgba = greyLike()
      rgba[i] ^= 1
      expect(packObservation(rgba, DEFLATE).rest).not.toBeNull()
      const { before, after } = await heldFrames(rgba)
      expect(Buffer.from(after.rgba).equals(Buffer.from(before.rgba))).toBe(true)
    }
  })

  test('without CompressionStream the rest is kept as is, with the same held frame', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    const rgba = geoLike()
    const rest = await packObservation(rgba, DEFLATE).rest
    expect(rest?.deflated).toBe(false)
    expect(rest!.bytes.length).toBe(pixels * 3)
    const { before, after } = await heldFrames(rgba)
    expect(Buffer.from(after.rgba).equals(Buffer.from(before.rgba))).toBe(true)
  })

  test('off the worker (no deflate) the observation is kept whole and nothing is deflated', async () => {
    const made = vi.fn()
    vi.stubGlobal(
      'CompressionStream',
      class {
        constructor() {
          made()
        }
      }
    )
    const rgba = geoLike()
    const packed = packObservation(rgba, { deflate: false })
    expect(packed.rest).toBeNull()
    expect(packed.rgba).toBe(rgba)
    expect(Buffer.from(packed.alpha).equals(Buffer.from(geoLike().filter((_, i) => i % 4 === 1)))).toBe(true)
    const unpacked = await unpackObservation(packed)
    expect(unpacked.buffer === rgba.buffer).toBe(false)
    expect(Buffer.from(unpacked).equals(Buffer.from(rgba))).toBe(true)
    expect(made).not.toHaveBeenCalled()
  })

  test('a CompressionStream that throws, at once or part way, leaves the rest undeflated and exact', async () => {
    const failures = [
      class {
        constructor() {
          throw new Error('no deflate here')
        }
      },
      class extends TransformStream<Uint8Array, Uint8Array> {
        constructor() {
          let chunks = 0
          super({
            transform(chunk, controller) {
              if (++chunks > 1) throw new Error('deflate failed part way')
              controller.enqueue(chunk.subarray(0, 10))
            },
          })
        }
      },
    ]
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const failing of failures) {
      vi.stubGlobal('CompressionStream', failing)
      const rgba = geoLike()
      const rest = await packObservation(rgba, DEFLATE).rest
      expect(rest?.deflated).toBe(false)
      const { before, after } = await heldFrames(rgba)
      expect(Buffer.from(after.rgba).equals(Buffer.from(before.rgba))).toBe(true)
    }
  })

  test('corrupt or short deflated planes reject the unpack', async () => {
    const alpha = new Uint8Array(pixels)
    const corrupt = new Uint8Array(4096).map((_, i) => (i * 97) & 0xff)
    await expect(
      unpackObservation({ alpha, rest: Promise.resolve({ bytes: corrupt, deflated: true }) })
    ).rejects.toThrow()
    const short = new Uint8Array(
      await new Response(
        new Blob([new Uint8Array(pixels)]).stream().pipeThrough(new CompressionStream('deflate-raw'))
      ).arrayBuffer()
    )
    await expect(
      unpackObservation({ alpha, rest: Promise.resolve({ bytes: short, deflated: true }) })
    ).rejects.toThrow(/not/)
    await expect(
      unpackObservation({ alpha, rest: Promise.resolve({ bytes: new Uint8Array(5), deflated: false }) })
    ).rejects.toThrow(/not/)
  })

  test('an aborted unpack throws', async () => {
    const packed = packObservation(geoLike(), DEFLATE)
    const abort = new AbortController()
    abort.abort()
    await expect(unpackObservation(packed, abort.signal)).rejects.toThrow()
    const late = new AbortController()
    const unpacking = unpackObservation(packed, late.signal)
    late.abort()
    await expect(unpacking).rejects.toThrow()
  })

  test('the packed observation is only read, and each unpack is a new copy', async () => {
    const rgba = geoLike()
    const copy = new Uint8ClampedArray(rgba)
    const packed = packObservation(rgba, DEFLATE)
    const [a, b] = await Promise.all([unpackObservation(packed), unpackObservation(packed)])
    expect(a.buffer === b.buffer).toBe(false)
    expect(Buffer.from(rgba).equals(Buffer.from(copy))).toBe(true)
    expect(Buffer.from(a).equals(Buffer.from(copy))).toBe(true)
  })
})
