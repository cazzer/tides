// Pins every 3d-tiles-renderer internal terrain-internals.ts relies on to
// 0.5.3 (tides-zmw.9.2): if any of these fail after a bump, reread the
// library before touching the expectations.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BufferGeometry,
  DataTexture,
  FloatType,
  Group,
  LinearFilter,
  Mesh,
  MeshLambertMaterial,
  NearestFilter,
  RedFormat,
} from 'three'
import { TilesRenderer } from '3d-tiles-renderer/three'
import { TerrariumMeshPlugin } from '3d-tiles-renderer/three/plugins'
import { GridCache } from '3d-tiles-renderer/src/three/plugins/images/terrain-rgb/GridCache.js'
import { FrameBudget } from './frame-budget'
import { SurfaceImageryOverlay } from './SurfaceImageryOverlay'
import {
  installSurfaceGridCache,
  PINNED_TILES_VERSION,
  protectOverlayBitmaps,
  shareGridBytes,
  quietTilesetVersion,
  SurfaceGridCache,
  type SurfaceGridOptions,
  type TerrainPluginInternals,
} from './terrain-internals'
import { decodeTerrariumPadded, type PaddedGrid } from './terrarium'

const LIB = path.resolve(process.cwd(), 'node_modules/3d-tiles-renderer')
const read = (file: string) => readFileSync(path.join(LIB, file), 'utf8')
const built = (pattern: RegExp) =>
  readdirSync(path.join(LIB, 'build'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => read(`build/${f}`))
    .filter((src) => pattern.test(src))

// The library's GridCache constructor makes an OffscreenCanvas (node has none).
class FakeOffscreenCanvas {
  width: number
  height: number
  constructor(w: number, h: number) {
    this.width = w
    this.height = h
  }
  getContext() {
    return null
  }
}

describe('3d-tiles-renderer internals (pinned to 0.5.3)', () => {
  it('is 0.5.3, exactly, in node_modules and package.json', () => {
    expect(JSON.parse(read('package.json')).version).toBe(PINNED_TILES_VERSION)
    const app = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'))
    expect(app.dependencies['3d-tiles-renderer']).toBe(PINNED_TILES_VERSION)
  })

  it('builds the terrain plugin with a replaceable _gridCache and a queue-routed _source.fetchData', () => {
    const [plugins, ...others] = built(/_gridCache/)
    expect(others).toHaveLength(0)
    // the property names survive minification; the class names don't
    expect(plugins).toMatch(/this\._gridCache = new \w+\(this\)/)
    expect(plugins).toContain('this._source.fetchData = ')
    // the plugin only ever locks, gets and releases grids
    const uses = [...plugins.matchAll(/_gridCache\.(\w+)\(/g)].map((m) => m[1])
    expect(new Set(uses)).toEqual(new Set(['lock', 'get', 'release']))
  })

  it('reads the tileset asset only in preprocessTileset, for the version warning', () => {
    const [renderer, ...others] = built(/preprocessTileset\(e, t, n = null\)/)
    expect(others).toHaveLength(0)
    expect([...renderer.matchAll(/\.asset\.[\w.]+/g)].map((m) => m[0])).toEqual(['.asset.version.split'])
    expect(read('src/three/plugins/images/terrain-rgb/TerrainRGBMeshPlugin.js')).toContain("asset: { version: '1.1' }")
  })

  it("closes every material texture's ImageBitmap when TilesRenderer drops a tile; the overlay source makes and closes them", () => {
    const [renderer, ...others] = built(/\.image instanceof ImageBitmap && \w\.image\.close\(\), \w\.dispose\(\)/)
    expect(others).toHaveLength(0)
    expect(renderer.match(/\.image instanceof ImageBitmap && \w\.image\.close\(\), \w\.dispose\(\)/g)).toHaveLength(2)
    const src = read('src/three/plugins/images/sources/TiledImageSource.js')
    expect(src).toContain('.then( buffer => this.processBufferToTexture( buffer ) );')
    expect(src).toContain('texture.image.close();')
  })

  it("sums every plugin's calculateBytesUsed into a tile's bytes, three's estimate counting each scene's textures", () => {
    const sum = /\w\.calculateBytesUsed && \(\w \+= \w\.calculateBytesUsed\(\w, \w\.engineData\.scene\) \|\| 0\)/
    expect(built(sum)).toHaveLength(1)
    expect(read('src/three/renderer/tiles/TilesRenderer.js')).toContain('bytesUsed.set( tile, estimateBytesUsed( scene ) );')
  })

  it('keeps stitchNeighbors on the source GridCache', () => {
    expect(typeof GridCache.prototype.stitchNeighbors).toBe('function')
    const src = read('src/three/plugins/images/terrain-rgb/GridCache.js')
    expect(src).toContain('const tiling = this.plugin._source.tiling;')
    expect(src).toContain('fillBorder( neighbor, grid, - dx, - dy );')
  })

  it('decodes as the library does: rows south first, edge texels copied into the border', async () => {
    // The library's own decode (GridCache.fetchItem's module-local
    // readImageData) over a fake canvas holding the image as it draws it,
    // flipped on load; ours reads the unflipped pixels.
    const w = 5
    const h = 4
    const topDown = new Uint8ClampedArray(w * h * 4).map((_, i) => (i * 37 + 11) % 256)
    const flipped = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) flipped.set(topDown.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
    const terrarium = TerrariumMeshPlugin.prototype as unknown as { decodeElevation(r: number, g: number, b: number): number }
    const plugin = new (class {
      decodeElevation = terrarium.decodeElevation
      _source = {
        fetchItem: async () => ({ image: { width: w, height: h } }),
        disposeItem: () => {},
        tiling: { getLevel: () => ({ tileCountX: 1 }), flipY: true },
      }
    })()
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    try {
      const cache = new GridCache(plugin)
      ;(cache as unknown as { canvas: unknown }).canvas = { getContext: () => ({ drawImage() {}, clearRect() {}, getImageData: () => ({ data: flipped }) }) }
      const theirs = (await GridCache.prototype.fetchItem.call(cache, [0, 0, 0], new AbortController().signal)) as DataTexture
      const ours = decodeTerrariumPadded(topDown, w, h)
      expect([theirs.image.width, theirs.image.height]).toEqual([ours.width, ours.height])
      expect(Array.from(theirs.image.data as unknown as Float32Array)).toEqual(Array.from(ours.data))
      expect([theirs.format, theirs.type]).toEqual([RedFormat, FloatType])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

/** A plugin wired as loadRootTileset leaves it, with fetch and window stubbed. */
async function loadedPlugin(quiet = true) {
  const terrain = new TerrariumMeshPlugin({ url: 'https://tiles.example/{z}/{x}/{y}.webp', tileDimension: 4, maxZoom: 8 })
  const tiles = new TilesRenderer()
  if (quiet) quietTilesetVersion(tiles)
  tiles.registerPlugin(terrain)
  await (terrain as unknown as { loadRootTileset(): Promise<unknown> }).loadRootTileset()
  return { terrain, tiles }
}

function options(over: Partial<SurfaceGridOptions> = {}): SurfaceGridOptions & { budget: FrameBudget } {
  const budget = new FrameBudget(Infinity)
  return {
    filter: 'nearest',
    decode: async () => ({ data: new Float32Array(36).fill(7), width: 6, height: 6 }),
    budget,
    retryDelays: [0, 0],
    ...over,
  } as SurfaceGridOptions & { budget: FrameBudget }
}

/** Resolves once the budget has someone waiting, then lets them through. */
async function release(budget: FrameBudget) {
  await vi.waitFor(() => expect(budget.pending).toBeGreaterThan(0))
  budget.tick()
}

describe('SurfaceGridCache (tides-zmw.9.2)', () => {
  const fetches: string[] = []
  let answer: (url: string, init?: RequestInit) => Promise<Response>

  beforeEach(() => {
    fetches.length = 0
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    vi.stubGlobal('window', { location: { href: 'http://localhost/tides/' } })
    // the library's queues schedule their runs on animation frames
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      fetches.push(url)
      return answer(url, init)
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('takes over the plugin cache, and the plugin routes its fetches through the tiles queue', async () => {
    const { terrain, tiles } = await loadedPlugin()
    const opts = options()
    const cache = installSurfaceGridCache(terrain, opts)
    expect((terrain as unknown as TerrainPluginInternals)._gridCache).toBe(cache)
    const add = vi.spyOn(tiles.downloadQueue, 'add')
    answer = async () => new Response(null, { status: 404 })
    const grid = cache.lock(1, 2, 3)
    await release(opts.budget)
    await grid
    expect(add).toHaveBeenCalledTimes(1)
    expect(fetches).toEqual(['https://tiles.example/3/1/2.webp'])
  })

  it('makes a 404 a flat, full-size sea-level grid and cancels its body', async () => {
    const { terrain } = await loadedPlugin()
    const opts = options()
    const cache = installSurfaceGridCache(terrain, opts)
    const cancel = vi.fn(async () => {})
    answer = async () => {
      const res = new Response('Not Found', { status: 404 })
      vi.spyOn(res.body!, 'cancel').mockImplementation(cancel)
      return res
    }
    const pending = cache.lock(6, 5, 4)
    await release(opts.budget)
    const grid = (await pending) as DataTexture
    expect([grid.image.width, grid.image.height]).toEqual([6, 6]) // tileDimension 4 + border
    expect((grid.image.data as unknown as Float32Array).every((v) => v === 0)).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cache.flatTiles).toBe(1)
  })

  it('asks nothing under a tile that answered no data', async () => {
    const { terrain } = await loadedPlugin()
    const opts = options()
    const cache = installSurfaceGridCache(terrain, opts)
    answer = async () => new Response(null, { status: 404 })
    const parent = cache.lock(6, 5, 4)
    await release(opts.budget)
    await parent
    expect(fetches).toHaveLength(1)
    const child = cache.lock(25, 21, 6)
    await release(opts.budget)
    await child
    expect(fetches).toHaveLength(1)
    expect(cache.flatTiles).toBe(2)
    // a sibling of the parent is still asked for
    answer = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    const sibling = cache.lock(7, 5, 4)
    await release(opts.budget)
    await sibling
    expect(fetches).toHaveLength(2)
  })

  it.each([
    ['linear', LinearFilter],
    ['nearest', NearestFilter],
  ] as const)('decodes a 200 with the injected decoder, %s-filtered, uploaded and stitched', async (filter, three) => {
    const { terrain } = await loadedPlugin()
    const decoded: ArrayBuffer[] = []
    const upload = vi.fn()
    let n = 0
    const opts = options({
      filter,
      upload,
      decode: async (buffer): Promise<PaddedGrid> => {
        decoded.push(buffer)
        n++
        return { data: new Float32Array(36).fill(n * 100), width: 6, height: 6 }
      },
    })
    const cache = installSurfaceGridCache(terrain, opts)
    answer = async () => new Response(new Uint8Array([9, 8, 7]), { status: 200 })
    const a = cache.lock(2, 2, 4)
    await release(opts.budget)
    const left = (await a) as DataTexture
    const b = cache.lock(3, 2, 4)
    await release(opts.budget)
    const right = (await b) as DataTexture
    expect(decoded.map((buf) => Array.from(new Uint8Array(buf)))).toEqual([
      [9, 8, 7],
      [9, 8, 7],
    ])
    for (const grid of [left, right]) {
      expect([grid.minFilter, grid.magFilter]).toEqual([three, three])
      expect([grid.format, grid.type]).toEqual([RedFormat, FloatType])
    }
    expect(upload.mock.calls.map((c) => c[0])).toEqual([left, right])
    // the library's stitch: left's east border holds right's west edge, and back
    const at = (g: DataTexture, x: number, y: number) => (g.image.data as unknown as Float32Array)[y * 6 + x]
    expect(at(left, 5, 2)).toBe(200)
    expect(at(right, 0, 2)).toBe(100)
    expect(cache.flatTiles).toBe(0)
  })

  it('fails a tile on any other bad status, cancelling the body', async () => {
    const { terrain } = await loadedPlugin()
    const cache = installSurfaceGridCache(terrain, options())
    const res = new Response('no', { status: 403 })
    const cancel = vi.spyOn(res.body!, 'cancel')
    answer = async () => res
    await expect(cache.lock(1, 1, 2)).rejects.toThrow(/2\/1\/1 answered 403/)
    expect(cancel).toHaveBeenCalled()
    expect(fetches).toHaveLength(1) // not transient: no retry
  })

  it('ends in an AbortError when aborted while downloading or waiting for a turn', async () => {
    const { terrain } = await loadedPlugin()
    const opts = options()
    const cache = installSurfaceGridCache(terrain, opts)
    answer = (_url, init) =>
      new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))
    const downloading = new AbortController()
    const a = cache.fetchItem([1, 1, 2], downloading.signal)
    await vi.waitFor(() => expect(fetches).toHaveLength(1))
    downloading.abort(new DOMException('gone', 'AbortError'))
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })

    answer = async () => new Response(null, { status: 404 })
    const waiting = new AbortController()
    const b = cache.fetchItem([2, 2, 2], waiting.signal)
    await vi.waitFor(() => expect(opts.budget.pending).toBe(1))
    waiting.abort(new DOMException('gone', 'AbortError'))
    await expect(b).rejects.toMatchObject({ name: 'AbortError' })
    expect(opts.budget.pending).toBe(0)
  })

  it('disposes a finished grid the cache drops unread', async () => {
    const { terrain } = await loadedPlugin()
    const opts = options()
    const cache = installSurfaceGridCache(terrain, opts)
    answer = async () => new Response(null, { status: 404 })
    const signal = new AbortController()
    const pending = cache.fetchItem([2, 2, 2], signal.signal)
    await release(opts.budget)
    const grid = await pending
    const dispose = vi.spyOn(grid, 'dispose')
    signal.abort()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('retries a network error or 5xx, then takes the answer', async () => {
    const { terrain } = await loadedPlugin()
    const opts = options()
    const cache = installSurfaceGridCache(terrain, opts)
    let n = 0
    answer = async () => {
      n++
      if (n === 1) throw new TypeError('Failed to fetch')
      if (n === 2) return new Response('busy', { status: 503 })
      return new Response(null, { status: 404 })
    }
    const pending = cache.lock(3, 3, 4)
    await release(opts.budget)
    await pending
    expect(fetches).toHaveLength(3)
    expect(cache.flatTiles).toBe(1)

    fetches.length = 0
    answer = async () => new Response('busy', { status: 503 })
    await expect(cache.lock(1, 1, 2)).rejects.toThrow(/answered 503/)
    expect(fetches).toHaveLength(3)
  })

  it('stops retrying at an abort', async () => {
    const { terrain } = await loadedPlugin()
    const cache = installSurfaceGridCache(terrain, options({ retryDelays: [60000] }))
    answer = async () => {
      throw new TypeError('Failed to fetch')
    }
    const abort = new AbortController()
    const pending = cache.fetchItem([1, 1, 2], abort.signal)
    await vi.waitFor(() => expect(fetches).toHaveLength(1))
    abort.abort(new DOMException('gone', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetches).toHaveLength(1)
  })

  it('forgets a grid that failed for good, so the next lock fetches it again', async () => {
    const { terrain } = await loadedPlugin()
    const opts = options()
    const cache = installSurfaceGridCache(terrain, opts)
    answer = async () => new Response('no', { status: 403 })
    const first = cache.lock(1, 1, 2)
    const again = cache.lock(1, 1, 2) // a second tile reading the same grid
    await expect(first).rejects.toThrow(/answered 403/)
    await expect(again).rejects.toThrow(/answered 403/)
    await vi.waitFor(() => expect(cache.get(1, 1, 2)).toBeNull())
    expect(cache.count).toBe(0)
    answer = async () => new Response(null, { status: 404 })
    const retry = cache.lock(1, 1, 2)
    await release(opts.budget)
    await retry
    expect(fetches).toHaveLength(2)
    expect(cache.count).toBe(1)
  })

  it('keeps an aborted grid entry (the cache removed it itself)', async () => {
    const { terrain } = await loadedPlugin()
    const cache = installSurfaceGridCache(terrain, options())
    answer = (_url, init) =>
      new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)))
    const pending = cache.lock(1, 1, 2)
    cache.release(1, 1, 2)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cache.count).toBe(0)
  })

  it('stops fetches, retries and turns in flight on shutDown', async () => {
    const { terrain } = await loadedPlugin()
    const opts = options({ retryDelays: [60000] })
    const cache = installSurfaceGridCache(terrain, opts)
    answer = async () => {
      throw new TypeError('Failed to fetch')
    }
    const retrying = cache.fetchItem([1, 1, 2], new AbortController().signal)
    await vi.waitFor(() => expect(fetches).toHaveLength(1))
    answer = async () => new Response(null, { status: 404 })
    const waiting = cache.fetchItem([2, 2, 2], new AbortController().signal)
    await vi.waitFor(() => expect(opts.budget.pending).toBe(1))
    cache.shutDown()
    await expect(retrying).rejects.toMatchObject({ name: 'AbortError' })
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    await expect(cache.fetchItem([3, 3, 2], new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetches).toHaveLength(2)
  })

  it('refuses a plugin that is not the 0.5.3 Terrarium one', () => {
    expect(() => installSurfaceGridCache({ name: 'X' } as unknown as TerrariumMeshPlugin, options())).toThrow()
    expect(new SurfaceGridCache({ name: 'TERRARIUM_MESH_PLUGIN', _gridCache: null, _source: null, tileDimension: 4 }, options()))
      .toBeInstanceOf(GridCache)
  })
})

describe('quietTilesetVersion (tides-zmw.9.2)', () => {
  beforeEach(() => {
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
    vi.stubGlobal('window', { location: { href: 'http://localhost/tides/' } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("stops the renderer's 1.1 warning for the plugin's synthetic tileset", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await loadedPlugin(false)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/versions at 1.1 or higher/)
    warn.mockClear()
    const { terrain } = await loadedPlugin(true)
    expect(warn).not.toHaveBeenCalled()
    // the tileset the plugin hands back is untouched
    const tileset = (terrain as unknown as { getTileset(): { asset: { version: string } } }).getTileset()
    expect(tileset.asset.version).toBe('1.1')
  })
})

describe('protectOverlayBitmaps (tides-zmw.9.2)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it("lets only the overlay's cache close the bitmaps it makes", async () => {
    const realClose = vi.fn()
    class FakeImageBitmap {
      width = 1
      height = 1
      close() {
        realClose()
      }
    }
    vi.stubGlobal('ImageBitmap', FakeImageBitmap)
    vi.stubGlobal('createImageBitmap', async () => new FakeImageBitmap())
    const overlay = new SurfaceImageryOverlay()
    protectOverlayBitmaps(overlay)
    const source = (overlay as unknown as {
      imageSource: { processBufferToTexture(b: ArrayBuffer): Promise<DataTexture>; disposeItem(t: DataTexture): void }
    }).imageSource
    const texture = await source.processBufferToTexture(new ArrayBuffer(4))
    const bitmap = texture.image as unknown as FakeImageBitmap
    expect(bitmap).toBeInstanceOf(FakeImageBitmap)
    // TilesRenderer's dispose of a tile: image.close() on a clone's shared bitmap
    ;(texture.clone().image as unknown as FakeImageBitmap).close()
    expect(realClose).not.toHaveBeenCalled()
    source.disposeItem(texture)
    expect(realClose).toHaveBeenCalledTimes(1)
  })
})

describe('shareGridBytes (tides-zmw.9.2)', () => {
  it("charges a tile half its grid on top of three's whole-grid estimate", () => {
    const tiles = new TilesRenderer()
    shareGridBytes(tiles)
    const grid = new DataTexture(new Float32Array(10 * 10), 10, 10, RedFormat, FloatType)
    const material = new MeshLambertMaterial()
    material.displacementMap = grid.clone()
    material.bumpMap = material.displacementMap
    const scene = new Group().add(new Mesh(new BufferGeometry(), material))
    const getBytesUsed = (tiles as unknown as { getBytesUsed(tile: unknown): number }).getBytesUsed
    // three counts the grid once per scene (400 bytes); the hook takes back half
    expect(getBytesUsed.call(tiles, { engineData: { scene } })).toBeCloseTo(400 / 2, 6)
  })
})
