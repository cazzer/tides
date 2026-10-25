import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageOverlay } from '3d-tiles-renderer/three/plugins'
import {
  EOX_URL,
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

const response = (status: number) => new Response(status === 200 ? 'img' : null, { status })

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
