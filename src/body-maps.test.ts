import { readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { read } from 'three/examples/jsm/libs/ktx-parse.module.js'
import { canUseCompressedBodyMaps } from './body-maps'

describe('canUseCompressedBodyMaps', () => {
  const has = (...extensions: string[]) => (ext: string) => extensions.includes(ext)

  it('takes the formats three uploads as sRGB', () => {
    expect(canUseCompressedBodyMaps(has('WEBGL_compressed_texture_astc'))).toBe(true)
    expect(canUseCompressedBodyMaps(has('EXT_texture_compression_bptc'))).toBe(true)
    expect(canUseCompressedBodyMaps(has('WEBGL_compressed_texture_etc'))).toBe(true)
    expect(canUseCompressedBodyMaps(has('WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb'))).toBe(true)
    // KTX2Loader takes ASTC, BC7 and ETC2 before ETC1.
    expect(canUseCompressedBodyMaps(has('WEBGL_compressed_texture_etc1', 'WEBGL_compressed_texture_astc'))).toBe(true)
  })

  it('declines ETC1, BC1/BC3 without sRGB, and none', () => {
    expect(canUseCompressedBodyMaps(has('WEBGL_compressed_texture_etc1'))).toBe(false)
    expect(
      canUseCompressedBodyMaps(
        has('WEBGL_compressed_texture_etc1', 'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb')
      )
    ).toBe(false)
    expect(canUseCompressedBodyMaps(has('WEBGL_compressed_texture_s3tc'))).toBe(false)
    expect(canUseCompressedBodyMaps(has())).toBe(false)
  })
})

/** A baseline or progressive JPEG's [width, height], from its frame header. */
function jpegSize(bytes: Uint8Array): [number, number] {
  let i = 2
  while (i < bytes.length) {
    const marker = bytes[i + 1]
    const length = (bytes[i + 2] << 8) | bytes[i + 3]
    if (marker >= 0xc0 && marker <= 0xc3) {
      return [(bytes[i + 7] << 8) | bytes[i + 8], (bytes[i + 5] << 8) | bytes[i + 6]]
    }
    i += 2 + length
  }
  throw new Error('no frame header')
}

// What scripts/build-body-maps.sh must produce: UASTC (Zstandard), tagged
// sRGB, the JPEG's size, and a full chain, which ship mode's proxy is
// built from (body-map-residency.ts).
describe('body map assets', () => {
  const SRGB = 2
  const ZSTD = 2
  const UASTC_MODEL = 166
  const assets = resolve(__dirname, 'assets')
  const planets = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'].map(
    (key) => [`${key}-2k.jpg`, `assets/${key}-2k.jpg`, `assets/bodies/${key}-2k.ktx2`] as const
  )
  const moons = readdirSync(resolve(assets, 'moons'))
    .filter((f) => f.endsWith('.jpg'))
    .map((f) => [f, `assets/moons/${f}`, `assets/moons/${f.replace(/\.jpg$/, '.ktx2')}`] as const)

  it('covers the seven planets and every moon map', () => {
    expect(moons).toHaveLength(31)
    const shipped = readdirSync(resolve(assets, 'bodies')).filter((f) => f.endsWith('.ktx2'))
    expect(shipped.sort()).toEqual(planets.map(([, , ktx2]) => ktx2.split('/').pop()).sort())
  })

  it.each([...planets, ...moons])('%s', (_, jpeg, ktx2) => {
    const [width, height] = jpegSize(new Uint8Array(readFileSync(resolve(__dirname, jpeg))))
    const container = read(new Uint8Array(readFileSync(resolve(__dirname, ktx2))))
    expect(container.vkFormat).toBe(0)
    expect(container.supercompressionScheme).toBe(ZSTD)
    expect(container.dataFormatDescriptor[0].colorModel).toBe(UASTC_MODEL)
    expect(container.dataFormatDescriptor[0].transferFunction).toBe(SRGB)
    expect([container.pixelWidth, container.pixelHeight]).toEqual([width, height])
    expect(container.levelCount).toBe(Math.log2(Math.max(width, height)) + 1)
  })
})
