import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImageOverlay } from '3d-tiles-renderer/three/plugins'
import { inflateSync } from 'node:zlib'
import {
  BLANK_BLACK_FRACTION,
  edgeBlackFraction,
  EOX_URL,
  fallbackImageryPng,
  FALLBACK_IMAGERY_RGB,
  fetchFirstOk,
  imageryUrl,
  imageryUrlsFor,
  insideUsgsCoverage,
  parseImageryUrl,
  tileBounds,
  USGS_URL,
  type ImageryTile,
} from './imagery'
import { ancestorCut, composedFrom, type AncestorCut, MATCH_DEADLINE_MS, regradeUsgs, SurfaceImageryOverlay } from './SurfaceImageryOverlay'
import { forEachTileInBounds } from '3d-tiles-renderer/src/three/plugins/images/overlays/utils.js'
import { CanvasTexture, Texture, type Source } from 'three'

// regradeUsgs's field and grader (the rest of both modules as they are).
const match = vi.hoisted(() => ({ params: vi.fn(), grade: vi.fn() }))
vi.mock('./imagery-match', async (original) => ({
  ...(await original<typeof import('./imagery-match')>()),
  matchField: () => ({ params: match.params }),
}))
vi.mock('./imagery-grade', async (original) => ({
  ...(await original<typeof import('./imagery-grade')>()),
  imageryGrader: () => ({ grade: match.grade }),
}))

/** The z tile holding (lat, lon) degrees. */
function tileAt(lat: number, lon: number, z: number): ImageryTile {
  const n = 2 ** z
  const la = (lat * Math.PI) / 180
  const x = Math.floor(((lon + 180) / 360) * n)
  const y = Math.floor(((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n)
  return { z, x, y }
}

/** A 200 carries a tile-sized body (a blank one is a few hundred bytes). */
const response = (status: number) => new Response(status === 200 ? new Uint8Array(8000) : null, { status })

describe('imagery source per tile (tides-zmw.9.1)', () => {
  it('takes USGS over the Grand Canyon (16/25721/12355, z/y/x)', () => {
    const tile = { z: 16, y: 25721, x: 12355 }
    const b = tileBounds(tile)
    expect(b.north).toBeCloseTo(36.04, 1)
    expect(b.west).toBeCloseTo(-112.13, 1)
    expect(imageryUrlsFor(tile)).toEqual([
      'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/16/25721/12355',
      'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/16/25721/12355.jpg',
    ])
  })

  it.each([
    ['Toronto', 43.65, -79.38],
    ['Vancouver', 49.28, -123.12],
    ['Victoria', 48.43, -123.37],
    ['Tijuana', 32.52, -117.03],
    ['the Alps', 46.5, 8.0],
    ['Havana', 23.11, -82.37],
    ['Nassau', 25.05, -77.35],
  ])('takes EOX over %s', (_name, lat, lon) => {
    for (const z of [8, 12, 16]) {
      const tile = tileAt(lat, lon, z)
      expect(insideUsgsCoverage(tile)).toBe(false)
      expect(imageryUrlsFor(tile)).toEqual([imageryUrl(EOX_URL, tile)])
    }
  })

  it.each([
    ['Denver', 39.74, -104.99],
    ['New York', 40.71, -74.0],
    ['Miami', 25.76, -80.25],
    ['Honolulu', 21.31, -157.86],
    ['Anchorage', 61.22, -149.9],
  ])('takes USGS first over %s', (_name, lat, lon) => {
    const tile = tileAt(lat, lon, 14)
    expect(imageryUrlsFor(tile)[0]).toBe(imageryUrl(USGS_URL, tile))
  })

  it('takes EOX at low zoom but where a whole tile fits a box (no zoom threshold)', () => {
    const usgs: string[] = []
    for (let z = 0; z <= 5; z++)
      for (let x = 0; x < 2 ** z; x++)
        for (let y = 0; y < 2 ** z; y++) if (insideUsgsCoverage({ z, x, y })) usgs.push(`${z}/${y}/${x}`)
    // interior Alaska, and the southeast from the Ohio to the Carolinas
    expect(usgs).toEqual(['5/7/2', '5/8/2', '5/9/2', '5/12/8'])
  })

  it('takes EOX for a tile straddling a box edge', () => {
    // a z9 tile across CONUS west's south edge at 32.8N, over Arizona
    const tile = tileAt(32.8, -112, 9)
    const b = tileBounds(tile)
    expect(b.south).toBeLessThan(32.8)
    expect(b.north).toBeGreaterThan(32.8)
    expect(insideUsgsCoverage(tile)).toBe(false)
    // the tile just north of it lies inside
    expect(insideUsgsCoverage({ ...tile, y: tile.y - 1 })).toBe(true)
  })

  it('reads z/y/x from either source URL', () => {
    const tile = { z: 13, x: 1544, y: 3215 }
    expect(parseImageryUrl(imageryUrl(EOX_URL, tile))).toEqual(tile)
    expect(parseImageryUrl(imageryUrl(USGS_URL, tile))).toEqual(tile)
    expect(imageryUrl(EOX_URL, tile)).toContain('/13/3215/1544.jpg')
    expect(parseImageryUrl('https://example.com/tileset.json')).toBeNull()
  })
})

describe('fetchFirstOk (tides-zmw.9.1)', () => {
  it('falls back to the next URL on a bad status and keeps the first ok', async () => {
    const calls: string[] = []
    const res = await fetchFirstOk(['usgs', 'eox'], async (u) => {
      calls.push(u)
      return response(u === 'usgs' ? 404 : 200)
    })
    expect(calls).toEqual(['usgs', 'eox'])
    expect(res.status).toBe(200)
    const only: string[] = []
    await fetchFirstOk(['usgs', 'eox'], async (u) => (only.push(u), response(200)))
    expect(only).toEqual(['usgs'])
  })

  it('returns the last answer when none is ok, and falls through network errors', async () => {
    expect((await fetchFirstOk(['a', 'b'], async () => response(404))).status).toBe(404)
    const res = await fetchFirstOk(['a', 'b'], async (u) => {
      if (u === 'a') throw new TypeError('Failed to fetch')
      return response(200)
    })
    expect(res.status).toBe(200)
  })

  it('stops at an abort', async () => {
    const abort = new DOMException('gone', 'AbortError')
    const fetcher = vi.fn(async () => {
      throw abort
    })
    await expect(fetchFirstOk(['a', 'b'], fetcher)).rejects.toBe(abort)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('SurfaceImageryOverlay (tides-zmw.9.1)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('asks super.fetch for USGS then EOX over the US, EOX alone elsewhere', async () => {
    const calls: string[] = []
    vi.spyOn(ImageOverlay.prototype, 'fetch').mockImplementation(async (url: string) => {
      calls.push(url)
      return response(url.includes('nationalmap') ? 404 : 200)
    })
    const overlay = new SurfaceImageryOverlay()
    const canyon = { z: 16, y: 25721, x: 12355 }
    const res = await overlay.fetch(imageryUrl(EOX_URL, canyon), {})
    expect(res.status).toBe(200)
    expect(calls).toEqual([imageryUrl(USGS_URL, canyon), imageryUrl(EOX_URL, canyon)])

    calls.length = 0
    const alps = tileAt(46.5, 8, 12)
    await overlay.fetch(imageryUrl(EOX_URL, alps), {})
    expect(calls).toEqual([imageryUrl(EOX_URL, alps)])
  })
})

describe('imagery fallback (tides-zmw.9.2)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('is a 1x1 PNG of the day map ocean colour', () => {
    expect(FALLBACK_IMAGERY_RGB).toEqual([25, 75, 101])
    const png = Buffer.from(fallbackImageryPng())
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    // IHDR: 1x1, 8-bit truecolour
    expect([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]]).toEqual([1, 1, 8, 2])
    const idat = png.indexOf('IDAT')
    const raw = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)))
    expect(Array.from(raw)).toEqual([0, ...FALLBACK_IMAGERY_RGB]) // filter byte, then RGB
  })

  it('skips a blank tile (USGS over open sea) for the next source, but takes a blank last answer', async () => {
    const blank = () => new Response(new Uint8Array(872), { status: 200 })
    const calls: string[] = []
    const res = await fetchFirstOk(['usgs', 'eox'], async (u) => (calls.push(u), u === 'usgs' ? blank() : response(200)))
    expect(calls).toEqual(['usgs', 'eox'])
    expect((await res.arrayBuffer()).byteLength).toBe(8000)
    const kept = await fetchFirstOk(['usgs', 'eox'], async (u) => (u === 'usgs' ? response(200) : blank()))
    expect((await kept.arrayBuffer()).byteLength).toBe(8000)
    expect((await (await fetchFirstOk(['eox'], async () => blank())).arrayBuffer()).byteLength).toBe(872)
  })

  it('skips a tile the probe finds part nodata black', async () => {
    const calls: string[] = []
    const blackish = async () => true
    const res = await fetchFirstOk(['usgs', 'eox'], async (u) => (calls.push(u), response(200)), blackish)
    expect(calls).toEqual(['usgs', 'eox'])
    expect(res.status).toBe(200)
    // the black count: pure black reaching the edge only
    const img = (rows: string[]) =>
      rows.flatMap((row) => [...row].flatMap((c) => (c === '#' ? [0, 0, 0, 255] : c === '.' ? [2, 1, 0, 255] : [90, 70, 50, 255])))
    // a nodata strip down the left edge: 4 of 16
    expect(edgeBlackFraction(img(['#ooo', '#ooo', '#ooo', '#ooo']), 4, 4)).toBe(0.25)
    // a shadow inside the tile, pure black but enclosed: none
    expect(edgeBlackFraction(img(['oooo', 'o##o', 'o##o', 'oooo']), 4, 4)).toBe(0)
    // near-black (sum <= 3) counts, and a corner patch follows its connection inward
    expect(edgeBlackFraction(img(['..oo', '.#oo', 'oo#o', 'oooo']), 4, 4)).toBe(4 / 16)
    expect(BLANK_BLACK_FRACTION).toBe(0.002)
  })

  it('cancels the body of an answer it skips', async () => {
    const skipped = new Response('Not Found', { status: 404 })
    const cancel = vi.spyOn(skipped.body!, 'cancel')
    await fetchFirstOk(['usgs', 'eox'], async (u) => (u === 'usgs' ? skipped : response(200)))
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('answers with the fallback when every source fails or the network does, and counts it', async () => {
    const overlay = new SurfaceImageryOverlay()
    overlay.retryDelays = [0, 0]
    const canyon = imageryUrl(EOX_URL, { z: 16, y: 25721, x: 12355 })
    const last = new Response('gone', { status: 500 })
    const cancel = vi.spyOn(last.body!, 'cancel')
    vi.spyOn(ImageOverlay.prototype, 'fetch').mockImplementation(async (url: string) =>
      url.includes('nationalmap') ? response(404) : last
    )
    const res = await overlay.fetch(canyon, {})
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(fallbackImageryPng()))
    expect(cancel).toHaveBeenCalled()
    expect(overlay.fallbacks).toBe(1)

    vi.spyOn(ImageOverlay.prototype, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    expect((await overlay.fetch(canyon, {})).status).toBe(200)
    expect(overlay.fallbacks).toBe(2)
  })

  it('still ends at an abort, and passes an ok answer through', async () => {
    const overlay = new SurfaceImageryOverlay()
    overlay.retryDelays = [0, 0]
    const alps = imageryUrl(EOX_URL, tileAt(46.5, 8, 12))
    const abort = new DOMException('gone', 'AbortError')
    vi.spyOn(ImageOverlay.prototype, 'fetch').mockRejectedValue(abort)
    await expect(overlay.fetch(alps, {})).rejects.toBe(abort)
    const ok = response(200)
    vi.spyOn(ImageOverlay.prototype, 'fetch').mockResolvedValue(ok)
    expect(await overlay.fetch(alps, {})).toBe(ok)
    expect(overlay.fallbacks).toBe(0)
  })
})

describe('a failed tile is cut from its ancestor (tides-zmw.9.31)', () => {
  afterEach(() => vi.restoreAllMocks())
  // An Amazon tile at 3 km: x odd, y even, so it's the parent's top-right quarter.
  const amazon = { z: 16, y: 32986, x: 21853 }
  const image = (width: number) => ({ width, height: width }) as unknown as ImageBitmap

  it('finds the tile in the flipped bitmap: its rows count up from the bottom', () => {
    expect(ancestorCut(amazon, 1, 256, 256)).toEqual({ sx: 128, sy: 128, sw: 128, sh: 128, size: 128 })
    expect(ancestorCut({ ...amazon, y: amazon.y + 1 }, 1, 256, 256)).toEqual({ sx: 128, sy: 0, sw: 128, sh: 128, size: 128 })
    // 32986 = 4 * 8246 + 2, 21853 = 4 * 5463 + 1: column 1, row 2 of 4
    expect(ancestorCut(amazon, 2, 256, 256)).toEqual({ sx: 64, sy: 64, sw: 64, sh: 64, size: 64 })
    // an ancestor that was itself cut keeps its own size; never under 2 a side
    expect(ancestorCut(amazon, 1, 128, 128).size).toBe(64)
    expect(ancestorCut(amazon, 9, 256, 256).size).toBe(2)
  })

  /** An overlay whose every fetch fails, holding `cached` as z/x/y -> texture
   * (or a promise of one, still loading). */
  async function failingOverlay(cached: Record<string, unknown>) {
    vi.spyOn(ImageOverlay.prototype, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    const overlay = new SurfaceImageryOverlay()
    overlay.retryDelays = [0, 0]
    await (overlay as unknown as { init(): Promise<void> }).init()
    const source = (overlay as unknown as { imageSource: { get(x: number, y: number, z: number): unknown } }).imageSource
    source.get = (x, y, z) => cached[`${z}/${x}/${y}`] ?? null
    const cut = vi.fn(async (_image: ImageBitmap, _cut: AncestorCut) => new Uint8Array([7, 7]).buffer)
    overlay.cutAncestor = cut
    return { overlay, cut }
  }
  const key = (up: number) => `${amazon.z - up}/${amazon.x >> up}/${amazon.y >> up}`

  it('draws the nearest cached ancestor, passing over one drawn in the fallback colour', async () => {
    const parent = image(1)
    const grand = image(256)
    const { overlay, cut } = await failingOverlay({ [key(1)]: new Texture(parent), [key(2)]: new Texture(grand) })
    const res = await overlay.fetch(imageryUrl(EOX_URL, amazon), {})
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([7, 7])
    expect(cut).toHaveBeenCalledWith(grand, ancestorCut(amazon, 2, 256, 256))
    expect([overlay.fallbacks, overlay.ancestorFallbacks]).toEqual([1, 1])
  })

  it('passes over an ancestor still loading, and tries the next when a cut fails', async () => {
    const grand = image(256)
    const great = image(256)
    const { overlay, cut } = await failingOverlay({
      [key(1)]: new Promise(() => {}),
      [key(2)]: new Texture(grand),
      [key(3)]: new Texture(great),
    })
    cut.mockRejectedValueOnce(new DOMException('closed', 'InvalidStateError'))
    await overlay.fetch(imageryUrl(EOX_URL, amazon), {})
    expect(cut.mock.calls.map((c) => c[0])).toEqual([grand, great])
    expect(overlay.ancestorFallbacks).toBe(1)
  })

  it('takes the fallback colour when no ancestor is cached, and ends at an abort', async () => {
    const { overlay, cut } = await failingOverlay({})
    const res = await overlay.fetch(imageryUrl(EOX_URL, amazon), {})
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(fallbackImageryPng()))
    expect(cut).not.toHaveBeenCalled()
    expect([overlay.fallbacks, overlay.ancestorFallbacks]).toEqual([1, 0])

    const aborted = await failingOverlay({ [key(1)]: new Texture(image(256)) })
    const controller = new AbortController()
    aborted.cut.mockImplementation(async () => (controller.abort(), new ArrayBuffer(2)))
    await expect(aborted.overlay.fetch(imageryUrl(EOX_URL, amazon), { signal: controller.signal })).rejects.toThrow()
  })
})

describe('imagery retry (tides-zmw.9.2 review)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('retries a transient failure before falling back, so a blip recovers to real imagery', async () => {
    const overlay = new SurfaceImageryOverlay()
    overlay.retryDelays = [0, 0]
    const alps = imageryUrl(EOX_URL, tileAt(46.5, 8, 12))
    let n = 0
    vi.spyOn(ImageOverlay.prototype, 'fetch').mockImplementation(async () => {
      n++
      if (n === 1) return new Response('busy', { status: 503 })
      if (n === 2) throw new TypeError('Failed to fetch')
      return response(200)
    })
    const res = await overlay.fetch(alps, {})
    expect(n).toBe(3)
    expect((await res.arrayBuffer()).byteLength).toBe(8000)
    expect(overlay.fallbacks).toBe(0)
  })
})

describe('which source served a US tile (tides-zmw.9.2)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('remembers a US tile EOX answered for, and forgets it once USGS answers', async () => {
    const overlay = new SurfaceImageryOverlay()
    overlay.retryDelays = [0, 0]
    const sea = { z: 11, y: 801, x: 326 }
    let usgs = 404
    vi.spyOn(ImageOverlay.prototype, 'fetch').mockImplementation(async (url: string) =>
      response(url.includes('nationalmap') ? usgs : 200)
    )
    expect(insideUsgsCoverage(sea)).toBe(true)
    await overlay.fetch(imageryUrl(EOX_URL, sea), {})
    expect(overlay.servedByEox(sea)).toBe(true)
    usgs = 200
    await overlay.fetch(imageryUrl(EOX_URL, sea), {})
    expect(overlay.servedByEox(sea)).toBe(false)
    // outside the boxes EOX is the only source, not a stand-in
    const alps = tileAt(46.5, 8, 12)
    await overlay.fetch(imageryUrl(EOX_URL, alps), {})
    expect(overlay.servedByEox(alps)).toBe(false)
  })
})

describe('a late match regrades the tile (tides-zmw.9.26)', () => {
  /** A stand-in for a decoded bitmap (node has none), whose real close is
   * spied (protectOverlayBitmaps's patch doesn't run here). */
  class FakeImageBitmap {
    readonly closed = vi.fn()
    constructor(
      readonly width = 256,
      readonly height = width
    ) {}
    close() {
      this.closed()
    }
  }
  beforeEach(() => vi.stubGlobal('ImageBitmap', FakeImageBitmap))
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  const canyon = { z: 16, y: 25721, x: 12355 }
  const settle = () => new Promise((r) => setTimeout(r, 0))
  const bitmap = (size = 256) => new FakeImageBitmap(size) as unknown as ImageBitmap
  const closes = (texture: Texture) => (texture.image as unknown as FakeImageBitmap).closed.mock.calls.length

  interface Internals {
    imageSource: {
      tiling: { getTileBounds(x: number, y: number, z: number, normalized: boolean, clamp: boolean): number[] }
      setData(x: number, y: number, z: number, texture: unknown): void
      release(x: number, y: number, z: number): void
      processBufferToTexture(buffer: ArrayBuffer): Promise<Texture>
    }
    regionImageSource: {
      fetchItem(args: number[]): unknown
      lock(...args: number[]): unknown
      tileComposer: { setTarget: ReturnType<typeof vi.fn>; draw: ReturnType<typeof vi.fn> }
    }
  }

  /** An overlay holding the canyon tile's texture, whose next USGS fetch
   * misses the deadline: `late` hands it the matched image. */
  async function lateOverlay(signal?: AbortSignal) {
    vi.spyOn(ImageOverlay.prototype, 'fetch').mockImplementation(async () => response(200))
    const overlay = new SurfaceImageryOverlay()
    await (overlay as unknown as { init(): Promise<void> }).init()
    const internals = overlay as unknown as Internals
    const texture = new Texture(bitmap())
    internals.imageSource.setData(canyon.x, canyon.y, canyon.z, texture)
    const decoded = new Texture(bitmap())
    const decode = vi.fn(async () => decoded)
    internals.imageSource.processBufferToTexture = decode
    internals.regionImageSource.tileComposer = { setTarget: vi.fn(), draw: vi.fn() }
    let late: ((image: ArrayBuffer) => void) | undefined
    overlay.regrade = vi.fn(async (_b, _t, _s, l) => ((late = l), null))
    const reported: Source[][] = []
    overlay.onLateMatch = (sources) => reported.push([...sources])
    await overlay.fetch(imageryUrl(EOX_URL, canyon), { signal })
    return { overlay, internals, texture, decoded, decode, late: late!, reported }
  }

  it('swaps the matched image into the cached texture and reports its source', async () => {
    const { overlay, texture, decoded, late, reported } = await lateOverlay()
    const version = texture.version
    const old = texture.image as unknown as FakeImageBitmap
    late(new ArrayBuffer(4))
    await settle()
    expect(texture.image).toBe(decoded.image)
    // The old image closed for real; never the live one every clone shares.
    expect(old.closed).toHaveBeenCalledTimes(1)
    expect(closes(texture)).toBe(0)
    expect(texture.version).toBeGreaterThan(version)
    expect(reported).toEqual([[texture.source]])
    expect(overlay.lateMatches).toBe(1)
  })

  it('leaves the tile be once its fetch aborts, before or after the decode', async () => {
    const before = new AbortController()
    const a = await lateOverlay(before.signal)
    before.abort()
    a.late(new ArrayBuffer(4))
    await settle()
    expect(a.decode).not.toHaveBeenCalled()
    expect(a.texture.image).not.toBe(a.decoded.image)

    const between = new AbortController()
    const b = await lateOverlay(between.signal)
    b.decode.mockImplementation(async () => (between.abort(), b.decoded))
    b.late(new ArrayBuffer(4))
    await settle()
    expect(b.texture.image).not.toBe(b.decoded.image)
    expect([closes(b.decoded), closes(b.texture)]).toEqual([1, 0]) // the decoded bitmap, for real
    expect(b.overlay.lateMatches + a.overlay.lateMatches).toBe(0)
    expect([...a.reported, ...b.reported]).toEqual([])
  })

  it('leaves the tile be when its entry is gone or replaced, or the image is another size', async () => {
    const gone = await lateOverlay()
    gone.internals.imageSource.release(canyon.x, canyon.y, canyon.z)
    gone.late(new ArrayBuffer(4))
    await settle()
    expect(gone.overlay.lateMatches).toBe(0)

    const replaced = await lateOverlay()
    let closedByRelease = -1
    replaced.decode.mockImplementation(async () => {
      replaced.internals.imageSource.release(canyon.x, canyon.y, canyon.z)
      await settle() // the library drops the entry a microtask later, closing its image
      closedByRelease = closes(replaced.texture)
      replaced.internals.imageSource.setData(canyon.x, canyon.y, canyon.z, new Texture(bitmap()))
      return replaced.decoded
    })
    replaced.late(new ArrayBuffer(4))
    await settle()
    await settle()
    expect(replaced.texture.image).not.toBe(replaced.decoded.image)
    expect(replaced.decode).toHaveBeenCalledTimes(1)
    expect([closes(replaced.decoded), closes(replaced.texture)]).toEqual([1, closedByRelease])
    expect(replaced.overlay.lateMatches).toBe(0)

    const resized = await lateOverlay()
    resized.decoded.image = bitmap(1)
    resized.late(new ArrayBuffer(4))
    await settle()
    expect(resized.texture.image).not.toBe(resized.decoded.image)
    expect([closes(resized.decoded), closes(resized.texture)]).toEqual([1, 0])
    expect(resized.overlay.lateMatches).toBe(0)
    expect([...gone.reported, ...replaced.reported, ...resized.reported]).toEqual([])
  })

  it('redraws the tile into the regions composed from it, now or once composed while it stays', async () => {
    const { internals, texture, late, reported } = await lateOverlay()
    const { tiling } = internals.imageSource
    const regions = internals.regionImageSource
    const quarter = ([x0, y0, x1, y1]: number[]) => [x0, y0, (x0 + x1) / 2, (y0 + y1) / 2]
    const bounds = tiling.getTileBounds(canyon.x, canyon.y, canyon.z, true, false)
    // A z17 terrain tile's range (the imagery's deepest level is 16), and a
    // neighbour's.
    const child = [...quarter(bounds), canyon.z + 1]
    const other = [...quarter(tiling.getTileBounds(canyon.x + 1, canyon.y, canyon.z, true, false)), canyon.z + 1]
    const composed = new CanvasTexture(bitmap())
    const unrelated = new CanvasTexture(bitmap())
    // Two z18 ranges still composing (the second finishes after the tile is dropped).
    const pendingRange = [...quarter(quarter(bounds)), canyon.z + 2]
    const [x0, y0, x1, y1] = quarter(bounds)
    const droppedRange = [(x0 + x1) / 2, (y0 + y1) / 2, x1, y1, canyon.z + 2]
    const pending = new CanvasTexture(bitmap())
    const dropped = new CanvasTexture(bitmap())
    const composers: ((t: CanvasTexture) => void)[] = []
    regions.fetchItem = vi.fn((args: number[]) => {
      if (args[4] === canyon.z + 2) return new Promise<CanvasTexture>((r) => composers.push(r))
      return args[0] === child[0] ? composed : unrelated
    })
    regions.lock(...child)
    regions.lock(...other)
    regions.lock(...pendingRange)
    regions.lock(...droppedRange)
    const [compose, composeDropped] = composers
    const versions = [composed.version, unrelated.version]
    late(new ArrayBuffer(4))
    await settle()
    expect(regions.tileComposer.draw).toHaveBeenCalledTimes(1)
    expect(regions.tileComposer.setTarget).toHaveBeenLastCalledWith(composed, child.slice(0, 4))
    expect(regions.tileComposer.draw).toHaveBeenLastCalledWith(texture, bounds)
    expect([composed.version > versions[0], unrelated.version > versions[1]]).toEqual([true, false])
    expect(reported).toEqual([[texture.source, composed.source]])

    compose(pending)
    await settle()
    expect(regions.tileComposer.draw).toHaveBeenCalledTimes(2)
    expect(regions.tileComposer.setTarget).toHaveBeenLastCalledWith(pending, pendingRange.slice(0, 4))
    expect(reported).toEqual([[texture.source, composed.source], [pending.source]])

    // Its image closed with it: nothing to draw from.
    internals.imageSource.release(canyon.x, canyon.y, canyon.z)
    composeDropped(dropped)
    await settle()
    expect(regions.tileComposer.draw).toHaveBeenCalledTimes(2)
    expect(regions.tileComposer.setTarget).not.toHaveBeenCalledWith(dropped, expect.anything())
    expect(reported).toHaveLength(2)
  })

  it('reckons the tiles a composed region draws as the library does (composedFrom)', async () => {
    const overlay = new SurfaceImageryOverlay()
    await (overlay as unknown as { init(): Promise<void> }).init()
    const { tiling } = (overlay as unknown as Internals).imageSource as unknown as {
      tiling: Parameters<typeof composedFrom>[0] & { maxLevel: number }
    }
    expect(tiling.maxLevel).toBe(canyon.z)
    const tileSpan = (x: number, y: number, z: number) => tiling.getTileBounds(x, y, z, true, false)
    const sub = ([x0, y0, x1, y1]: number[], i: number, j: number, n: number) => {
      const w = (x1 - x0) / n
      const h = (y1 - y0) / n
      return [x0 + i * w, y0 + j * h, x0 + (i + 1) * w, y0 + (j + 1) * h]
    }
    const bounds = tileSpan(canyon.x, canyon.y, canyon.z)
    const [bx0, by0, bx1, by1] = bounds
    const w = bx1 - bx0
    const h = by1 - by0
    const ranges: number[][] = [
      // The tile's own bounds, at its level and finer.
      [...bounds, 14],
      [...bounds, 15],
      [...bounds, 16],
      [...bounds, 17],
      // Its z15 parent.
      [...tileSpan(canyon.x >> 1, canyon.y >> 1, 15), 15],
      [...tileSpan(canyon.x >> 1, canyon.y >> 1, 15), 16],
      // Straddling it and its neighbours.
      [bx0 - w / 2, by0 - h / 2, bx1 - w / 2, by1 - h / 2, 16],
      [bx0 + w / 3, by0, bx1 + w / 3, by1, 18],
      [bx0 - w * 1e-6, by0, bx1 - w * 1e-6, by1, 16],
      // A neighbour's.
      [...tileSpan(canyon.x + 1, canyon.y, canyon.z), 16],
      [...tileSpan(canyon.x, canyon.y - 1, canyon.z), 20],
    ]
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) ranges.push([...sub(bounds, i, j, 2), 17])
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j += 3) ranges.push([...sub(bounds, i, j, 4), 18], [...sub(bounds, i, j, 4), 22])
    const neighbours = [canyon, { ...canyon, x: canyon.x + 1 }, { ...canyon, y: canyon.y - 1 }, { ...canyon, x: canyon.x - 1, y: canyon.y - 1 }]
    let drawn = 0
    for (const args of ranges) {
      const visited = new Set<string>()
      forEachTileInBounds(args.slice(0, 4), args[4], tiling, (x, y, z) => visited.add(`${z}/${x}/${y}`))
      for (const tile of neighbours) {
        const expected = visited.has(`${tile.z}/${tile.x}/${tile.y}`)
        expect(composedFrom(tiling, args, tile), `${args} draws ${tile.x}/${tile.y}`).toBe(expected)
        drawn += expected ? 1 : 0
      }
      // A coarser tile under it never counts as drawn (only the clamped level is).
      expect(composedFrom(tiling, args, { z: 15, x: canyon.x >> 1, y: canyon.y >> 1 })).toBe(
        Math.max(Math.min(args[4], 16), 0) === 15
      )
    }
    expect(drawn).toBeGreaterThan(ranges.length / 2) // the sweep isn't vacuous
  })

  it('regradeUsgs hands a match that missed the deadline to late, unless the tile aborts', async () => {
    vi.useFakeTimers()
    const graded = new Uint8Array([1, 2, 3])
    match.grade.mockImplementation(async () => graded)
    const params = { gain: 1 }
    let give!: (p: unknown) => void
    match.params.mockImplementation(() => new Promise((r) => (give = r)))
    const body = new ArrayBuffer(8)
    const late = vi.fn()
    const signal = new AbortController().signal
    const answer = regradeUsgs(body, canyon, signal, late)
    await vi.advanceTimersByTimeAsync(MATCH_DEADLINE_MS)
    await expect(answer).resolves.toBeNull()
    expect(late).not.toHaveBeenCalled()
    give(params)
    await vi.advanceTimersByTimeAsync(0)
    expect(match.grade).toHaveBeenLastCalledWith(body, 'match', 'bmp', signal, params)
    expect(late).toHaveBeenCalledWith(graded.buffer)

    const aborts = new AbortController()
    const never = vi.fn()
    const missed = regradeUsgs(body, canyon, aborts.signal, never)
    await vi.advanceTimersByTimeAsync(MATCH_DEADLINE_MS)
    await expect(missed).resolves.toBeNull()
    aborts.abort()
    give(params)
    await vi.advanceTimersByTimeAsync(0)
    expect(never).not.toHaveBeenCalled()
  })
})
