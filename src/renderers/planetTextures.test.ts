import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { BodyMapLoader, canFlipBitmaps, type ColorMapLoad, type CompressedMapLoad } from './planetTextures'

describe('canFlipBitmaps', () => {
  it('trusts Chrome, Safari 17+ and Firefox 98+', () => {
    expect(canFlipBitmaps('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36')).toBe(true)
    expect(canFlipBitmaps('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe(true)
    expect(canFlipBitmaps('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:98.0) Gecko/20100101 Firefox/98.0')).toBe(true)
  })

  it('keeps the image path on Safari 16, Firefox 97 and iOS Chrome', () => {
    expect(canFlipBitmaps('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15')).toBe(false)
    expect(canFlipBitmaps('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:97.0) Gecko/20100101 Firefox/97.0')).toBe(false)
    expect(canFlipBitmaps('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1')).toBe(false)
  })
})

describe('BodyMapLoader', () => {
  const renderer = (...extensions: string[]) =>
    ({ extensions: { has: (ext: string) => extensions.includes(ext) } }) as unknown as THREE.WebGLRenderer
  const jpegMap = new THREE.Texture()
  const ktx2Map = new THREE.CompressedTexture([], 2048, 1024, THREE.RGBA_ASTC_4x4_Format)
  const loadColor = vi.fn<ColorMapLoad>((_url, _anisotropy, onLoad) => onLoad(jpegMap))

  function load(loader: BodyMapLoader, url = 'mars.jpg'): Promise<THREE.Texture> {
    return new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject))
  }

  function loaderWith(loadCompressed: CompressedMapLoad, gl: THREE.WebGLRenderer) {
    loadColor.mockClear()
    const loader = new BodyMapLoader(loadColor, loadCompressed)
    loader.ktx2For.set('mars.jpg', 'mars.ktx2')
    loader.gl = gl
    loader.anisotropy = 8
    return loader
  }

  it('loads the KTX2 where the browser takes a format, with the anisotropy', async () => {
    const loadCompressed = vi.fn<CompressedMapLoad>(async () => ktx2Map)
    const loader = loaderWith(loadCompressed, renderer('WEBGL_compressed_texture_astc'))
    expect(await load(loader)).toBe(ktx2Map)
    expect(loadCompressed).toHaveBeenCalledWith('mars.ktx2', loader.gl)
    expect(ktx2Map.anisotropy).toBe(8)
    expect(loadColor).not.toHaveBeenCalled()
  })

  it('loads the JPEG where the browser takes none of the formats', async () => {
    const loadCompressed = vi.fn<CompressedMapLoad>(async () => ktx2Map)
    const loader = loaderWith(loadCompressed, renderer('WEBGL_compressed_texture_etc1'))
    expect(await load(loader)).toBe(jpegMap)
    expect(loadCompressed).not.toHaveBeenCalled()
    expect(loadColor).toHaveBeenCalledWith('mars.jpg', 8, expect.any(Function), expect.any(Function))
  })

  it('falls back to the JPEG when the KTX2 fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loader = loaderWith(() => Promise.reject(new Error('404')), renderer('EXT_texture_compression_bptc'))
    expect(await load(loader)).toBe(jpegMap)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('loads a url without a KTX2 sibling as it is', async () => {
    const loadCompressed = vi.fn<CompressedMapLoad>(async () => ktx2Map)
    const loader = loaderWith(loadCompressed, renderer('WEBGL_compressed_texture_astc'))
    expect(await load(loader, 'saturn-ring.png')).toBe(jpegMap)
    expect(loadCompressed).not.toHaveBeenCalled()
  })
})
