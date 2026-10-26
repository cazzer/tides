import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { SurfaceImageryOverlay } from './SurfaceImageryOverlay'

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
    expect(BLANK_BLACK_FRACTION).toBe(0.02)
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
