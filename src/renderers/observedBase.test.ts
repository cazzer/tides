import { afterEach, describe, expect, test, vi } from 'vitest'
import { OUT_H, OUT_W } from '../real-clouds'
import { imageOf } from './cloudPipeline'
import { packObservation, unpackObservation } from './observedBase'

const pixels = OUT_W * OUT_H
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
  const after = imageOf(await unpackObservation(packObservation(rgba)), null)
  return { before, after }
}

describe('packObservation', () => {
  afterEach(() => vi.unstubAllGlobals())

  test('a held frame from a geostationary observation is the same bytes, and the rest is deflated', async () => {
    const rgba = geoLike()
    const packed = packObservation(rgba)
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
    expect(packObservation(rgba).rest).toBeNull()
    const { before, after } = await heldFrames(rgba)
    expect(Buffer.from(after.rgba).equals(Buffer.from(before.rgba))).toBe(true)
  })

  test('one pixel off grey, or not opaque, keeps the rest', async () => {
    for (const i of [4 * 1234 + 3, 4 * 99 + 2, 0]) {
      const rgba = greyLike()
      rgba[i] ^= 1
      expect(packObservation(rgba).rest).not.toBeNull()
      const { before, after } = await heldFrames(rgba)
      expect(Buffer.from(after.rgba).equals(Buffer.from(before.rgba))).toBe(true)
    }
  })

  test('without CompressionStream the rest is kept as is, with the same held frame', async () => {
    vi.stubGlobal('CompressionStream', undefined)
    const rgba = geoLike()
    const rest = await packObservation(rgba).rest
    expect(rest?.deflated).toBe(false)
    expect(rest!.bytes.length).toBe(pixels * 3)
    const { before, after } = await heldFrames(rgba)
    expect(Buffer.from(after.rgba).equals(Buffer.from(before.rgba))).toBe(true)
  })

  test('the packed observation is only read, and each unpack is a new copy', async () => {
    const rgba = geoLike()
    const copy = new Uint8ClampedArray(rgba)
    const packed = packObservation(rgba)
    const [a, b] = await Promise.all([unpackObservation(packed), unpackObservation(packed)])
    expect(a.buffer === b.buffer).toBe(false)
    expect(Buffer.from(rgba).equals(Buffer.from(copy))).toBe(true)
    expect(Buffer.from(a).equals(Buffer.from(copy))).toBe(true)
  })
})
