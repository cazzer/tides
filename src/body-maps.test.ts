import { readdirSync, readFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, resolve } from 'path'
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

// Orientation (tides-0oi.14 review): basisu writes no KTXorientation, and
// three never flips a compressed texture, so -y_flip must store the JPEG's
// bottom row first, where TextureLoader's upload flip puts it. A small level
// of the KTX2, decoded by three's own transcoder, against the JPEG at that
// size (src/__fixtures__/<map>-32x16.rgb: magick -colorspace sRGB -resize
// 32x16! rgb:), matches row for row only when read bottom up.
describe('body map orientation', () => {
  interface Ktx2File {
    isValid(): boolean
    startTranscoding(): number
    getImageTranscodedSizeInBytes(level: number, layer: number, face: number, format: number): number
    transcodeImage(dst: Uint8Array, level: number, layer: number, face: number, format: number, flags: number, ch0: number, ch1: number): number
    close(): void
    delete(): void
  }
  interface Transcoder {
    initializeBasis(): void
    KTX2File: new (bytes: Uint8Array) => Ktx2File
  }
  const RGBA32 = 13

  async function transcoder(): Promise<Transcoder> {
    const require = createRequire(import.meta.url)
    const js = require.resolve('three/examples/jsm/libs/basis/basis_transcoder.js')
    const factory = new Function('require', '__filename', '__dirname', `${readFileSync(js, 'utf8')}\n;return BASIS`)(
      require,
      js,
      dirname(js)
    ) as (module: { wasmBinary: Uint8Array }) => Promise<Transcoder>
    const basis = await factory({ wasmBinary: readFileSync(resolve(dirname(js), 'basis_transcoder.wasm')) })
    basis.initializeBasis()
    return basis
  }

  it.each([
    ['assets/bodies/mars-2k.ktx2', 6, 'mars-2k-32x16.rgb'],
    ['assets/moons/ganymede-1k.ktx2', 5, 'ganymede-1k-32x16.rgb'],
  ] as const)('%s stores the bottom row first', async (file, level, fixture) => {
    const basis = await transcoder()
    const ktx2 = new basis.KTX2File(new Uint8Array(readFileSync(resolve(__dirname, file))))
    expect(ktx2.isValid() && ktx2.startTranscoding()).toBeTruthy()
    const rgba = new Uint8Array(ktx2.getImageTranscodedSizeInBytes(level, 0, 0, RGBA32))
    expect(ktx2.transcodeImage(rgba, level, 0, 0, RGBA32, 0, -1, -1)).toBeTruthy()
    ktx2.close()
    ktx2.delete()
    const jpeg = readFileSync(resolve(__dirname, '__fixtures__', fixture))
    const [w, h] = [32, 16]
    expect(rgba.length).toBe(w * h * 4)
    const meanError = (bottomUp: boolean) => {
      let sum = 0
      for (let y = 0; y < h; y++) {
        const row = bottomUp ? h - 1 - y : y
        for (let x = 0; x < w; x++) {
          for (let c = 0; c < 3; c++) sum += Math.abs(rgba[(y * w + x) * 4 + c] - jpeg[(row * w + x) * 3 + c])
        }
      }
      return sum / (w * h * 3)
    }
    // Different downsampling filters keep even the right way from 0.
    expect(meanError(true)).toBeLessThan(8)
    expect(meanError(false)).toBeGreaterThan(2 * meanError(true))
  })
})
