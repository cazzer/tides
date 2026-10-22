import { readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'
import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { read } from 'three/examples/jsm/libs/ktx-parse.module.js'
import {
  canUseFlightTextures,
  createFlightTextureCache,
  FLIGHT_TEXTURE_KEYS,
  FLIGHT_TEXTURE_RANGE,
  flightTextureUrl,
  inFlightTextureRange,
} from './flight-textures'

describe('flightTextureUrl', () => {
  it('picks 8k where there is one and the cap allows it', () => {
    for (const key of ['mars', 'mercury'] as const) {
      expect(flightTextureUrl(key, 8192)).toMatch(new RegExp(`${key}-8k`))
      expect(flightTextureUrl(key, 4096)).toMatch(new RegExp(`${key}-4k`))
    }
    for (const key of ['jupiter', 'saturn', 'venus'] as const) {
      expect(flightTextureUrl(key, 8192)).toMatch(new RegExp(`${key}-4k`))
    }
  })

  it('has a 4k map for every key', () => {
    for (const key of FLIGHT_TEXTURE_KEYS) expect(flightTextureUrl(key, 4096)).toBeDefined()
  })
})

describe('inFlightTextureRange', () => {
  it('is within FLIGHT_TEXTURE_RANGE radii of the surface', () => {
    expect(inFlightTextureRange(FLIGHT_TEXTURE_RANGE * 2 - 0.01, 2)).toBe(true)
    expect(inFlightTextureRange(FLIGHT_TEXTURE_RANGE * 2, 2)).toBe(false)
  })
})

describe('canUseFlightTextures', () => {
  const has = (...extensions: string[]) => (ext: string) => extensions.includes(ext)

  it('takes formats three uploads as sRGB', () => {
    expect(canUseFlightTextures(has('WEBGL_compressed_texture_etc'))).toBe(true)
    expect(canUseFlightTextures(has('EXT_texture_compression_bptc'))).toBe(true)
    // KTX2Loader takes BC7 before ETC1, for ETC1S too.
    expect(canUseFlightTextures(has('WEBGL_compressed_texture_etc1', 'EXT_texture_compression_bptc'))).toBe(true)
    expect(canUseFlightTextures(has('WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb'))).toBe(true)
  })

  it('declines ETC1, BC1 without sRGB, and plain RGBA', () => {
    expect(canUseFlightTextures(has('WEBGL_compressed_texture_etc1', 'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb'))).toBe(false)
    expect(canUseFlightTextures(has('WEBGL_compressed_texture_s3tc'))).toBe(false)
    expect(canUseFlightTextures(has())).toBe(false)
  })
})

describe('createFlightTextureCache', () => {
  function texture() {
    const t = new THREE.Texture()
    t.dispose = vi.fn()
    return t
  }

  it('loads each url once', async () => {
    const load = vi.fn(async () => texture())
    const cache = createFlightTextureCache(load)
    const [a, b] = await Promise.all([cache.request('a'), cache.request('a')])
    expect(a).toBe(b)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('disposes on release, including loads that land afterwards', async () => {
    let finish!: (t: THREE.Texture) => void
    const late = texture()
    const early = texture()
    let current!: () => boolean
    const cache = createFlightTextureCache((url, isCurrent) => {
      if (url !== 'late') return Promise.resolve(early)
      current = isCurrent
      return new Promise((resolve) => (finish = resolve))
    })
    await cache.request('early')
    const pending = cache.request('late')
    cache.release()
    expect(current()).toBe(false)
    finish(late)
    expect(await pending).toBeNull()
    expect(late.dispose).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(early.dispose).toHaveBeenCalledTimes(1)
  })

  it('resolves a failed load to null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cache = createFlightTextureCache(() => Promise.reject(new Error('404')))
    expect(await cache.request('x')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

// What the asset script must produce: Basis ETC1S (BasisLZ) or UASTC
// (Zstandard) with a full mip chain, tagged sRGB, the colour space
// KTX2Loader then gives the texture.
describe('flight assets', () => {
  const SRGB = 2
  const BASIS_LZ = 1
  const ZSTD = 2
  const files = [
    ['mars', 8192, BASIS_LZ], ['mars', 4096, BASIS_LZ], ['mercury', 8192, BASIS_LZ], ['mercury', 4096, BASIS_LZ],
    ['jupiter', 4096, ZSTD], ['saturn', 4096, ZSTD], ['venus', 4096, ZSTD],
  ] as const

  it.each(files)('%s at %i', (key, width, scheme) => {
    const file = resolve(__dirname, `assets/flight/${key}-${width / 1024}k.ktx2`)
    const container = read(new Uint8Array(readFileSync(file)))
    expect(container.vkFormat).toBe(0)
    expect(container.supercompressionScheme).toBe(scheme)
    expect([container.pixelWidth, container.pixelHeight]).toEqual([width, width / 2])
    expect(container.levelCount).toBe(Math.log2(width) + 1)
    expect(container.dataFormatDescriptor[0].transferFunction).toBe(SRGB)
  })

  it('has a file for every map and no others', () => {
    const names = files.map(([key, width]) => `${key}-${width / 1024}k.ktx2`).sort()
    const shipped = readdirSync(resolve(__dirname, 'assets/flight')).filter((f) => f.endsWith('.ktx2'))
    expect(shipped.sort()).toEqual(names)
  })
})
