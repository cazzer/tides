import { DEFAULT_DOWNLOAD_QUEUE, DownloadPriorityQueue } from '3d-tiles-renderer/core'
import { TilesRenderer } from '3d-tiles-renderer/three'
import { TerrariumMeshPlugin } from '3d-tiles-renderer/three/plugins'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSurfaceQueues, isTileDownload, SURFACE_JOBS_PER_ORIGIN, SURFACE_PARSE_JOBS, SurfaceDownloadQueue } from './surface-queues'
import { SurfaceImageryOverlay } from './SurfaceImageryOverlay'

const ORIGIN = 'https://tiles.mapterhorn.com'

/** What a queue of the library holds (untyped there). */
const itemsOf = (queue: unknown) => (queue as { items: unknown[] } | undefined)?.items ?? []

/** A queued tile as the library's comparators read it (used and in view, at `distance`). */
function tile(name: string, distance = 1) {
  return {
    name,
    internal: { renderer: { loadAncestors: false }, hasUnrenderableContent: false, depthFromRenderedParent: 1 },
    traversal: { used: true, inFrustum: true, distanceFromCamera: distance, error: 1 },
  }
}

/** A grid or imagery fetch as the library queues it (TerrainRGBMeshPlugin's fetchData). */
const fetchItem = (name: string, priority: number) => ({ name, priority })

describe('surface queues (tides-zmw.9.25)', () => {
  // The library schedules each queue's runs on animation frames: held here,
  // so a frame is one explicit tryRunJobs per queue.
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
  })
  afterEach(() => vi.unstubAllGlobals())

  /** One frame: every queue starts what it may. */
  const frame = (downloads: DownloadPriorityQueue) => {
    for (const queue of [...downloads.originQueues.values()]) queue.tryRunJobs()
  }

  it("are the tiles' own, with 16 downloads per server and 16 parses", () => {
    const { downloads, parse } = createSurfaceQueues()
    expect(downloads).toBeInstanceOf(SurfaceDownloadQueue)
    expect(SURFACE_JOBS_PER_ORIGIN).toBe(16)
    expect(SURFACE_PARSE_JOBS).toBe(16)
    expect(downloads.maxJobsPerOrigin).toBe(16)
    expect(parse.maxJobs).toBe(16)
  })

  it("keep the tiles' synthetic downloads off their server's queue", () => {
    const { downloads } = createSurfaceQueues()
    downloads.add(`${ORIGIN}/12/1/2.webp`, tile('t'), () => {})
    downloads.add(`${ORIGIN}/12/1/2.webp`, fetchItem('grid', -1), () => {})
    expect(itemsOf(downloads.originQueues.get(null)).map((i) => (i as { name: string }).name)).toEqual(['t'])
    expect(itemsOf(downloads.originQueues.get(ORIGIN)).map((i) => (i as { name: string }).name)).toEqual(['grid'])
  })

  // each frame: 40 new tiles, more than a frame starts, and fetches parses wait on
  const stream = (downloads: DownloadPriorityQueue, fetchesPerFrame: number) => {
    const started: string[] = []
    const add = (item: { name: string }) => downloads.add(`${ORIGIN}/14/3/4.webp`, item, () => started.push(item.name))
    for (let f = 0; f < 5; f++) {
      for (let i = 0; i < 40; i++) add(tile(`f${f}t${i}`, i))
      for (let i = 0; i < fetchesPerFrame; i++) add(fetchItem(`grid${f}.${i}`, -f))
      frame(downloads)
    }
    return {
      grids: started.filter((name) => name.startsWith('grid')).length,
      tiles: started.filter((name) => !name.startsWith('grid')).length,
    }
  }

  it('never let a stream of tile downloads starve the fetches (the 9.25 stall)', () => {
    expect(stream(createSurfaceQueues().downloads, 1).grids).toBe(5)
    // the library's own order, one shared queue: not one fetch starts
    const library = new DownloadPriorityQueue()
    library.maxJobsPerOrigin = SURFACE_JOBS_PER_ORIGIN
    library.priorityCallback = DEFAULT_DOWNLOAD_QUEUE.priorityCallback
    expect(stream(library, 1).grids).toBe(0)
  })

  it('keep tile downloads moving while the fetches stay saturated', () => {
    // 3x the cap of fetches queued every frame: the server queue is never short of work
    const { grids, tiles } = stream(createSurfaceQueues().downloads, 3 * SURFACE_JOBS_PER_ORIGIN)
    expect(grids).toBe(5 * SURFACE_JOBS_PER_ORIGIN)
    expect(tiles).toBe(5 * SURFACE_JOBS_PER_ORIGIN)
  })

  it('parse nearer used tiles first, as the library does', () => {
    const { parse } = createSurfaceQueues()
    parse.maxJobs = 1
    const started: string[] = []
    for (const [name, distance] of [['far', 9], ['near', 1], ['mid', 5]] as const) parse.add(tile(name, distance), () => started.push(name))
    parse.tryRunJobs()
    parse.tryRunJobs()
    parse.tryRunJobs()
    expect(started).toEqual(['near', 'mid', 'far'])
  })
})

describe('surface queues against the library 0.5.3 (tides-zmw.9.25)', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('window', { location: { href: 'http://localhost/tides/' } })
    vi.stubGlobal('fetch', async () => new Response(new ArrayBuffer(4)))
    // the plugin's grid cache makes a canvas
    vi.stubGlobal('OffscreenCanvas', class {
      getContext() {
        return null
      }
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it("route the terrain plugin's grid fetches, the imagery's and the tiles' own downloads as isTileDownload expects", async () => {
    const terrain = new TerrariumMeshPlugin({ url: 'https://tiles.example/{z}/{x}/{y}.webp', tileDimension: 4, maxZoom: 8 })
    const tiles = new TilesRenderer()
    const queued: { url: string | null; item: unknown }[] = []
    const downloads = new (class extends SurfaceDownloadQueue {
      override add(url: string | null, item: unknown, callback: (item: unknown) => unknown, signal: AbortSignal | null = null) {
        queued.push({ url, item })
        return super.add(url, item, callback, signal)
      }
    })()
    tiles.downloadQueue = downloads
    tiles.registerPlugin(terrain)
    const tileset = (await (terrain as unknown as { loadRootTileset(): Promise<{ root: unknown }> }).loadRootTileset()).root as {
      children: { children: unknown[] }[]
      internal: { basePath: string }
    }
    // a grid fetch, as the plugin's _source.fetchData queues it
    const source = (terrain as unknown as { _source: { fetchData(url: string, options: RequestInit): Promise<unknown> } })._source
    void source.fetchData('https://tiles.example/1/0/0.webp', { signal: new AbortController().signal })
    // imagery, as ImageOverlay's fetch queues it
    const overlay = new SurfaceImageryOverlay()
    overlay.downloadQueue = downloads
    void (overlay as unknown as { fetch(url: string, options: RequestInit): Promise<unknown> })
      .fetch('https://imagery.example/1/0/0.jpg', { signal: new AbortController().signal })
      .catch(() => {})
    // a tile's own download
    const child = tileset.children[0]
    const internals = tiles as unknown as { preprocessNode(tile: unknown, dir: string, parent: unknown): void; requestTileContents(tile: unknown): unknown }
    internals.preprocessNode(child, tileset.internal.basePath, tileset)
    internals.requestTileContents(child)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const kinds = queued.map(({ url, item }) => [url && new URL(url).host, isTileDownload(item)])
    expect(kinds).toContainEqual(['tiles.example', false])
    // (the overlay asks its own servers for the tile it reads from the url)
    expect(kinds.filter(([host, isTile]) => host !== 'tiles.example' && isTile === false).length).toBeGreaterThan(0)
    expect(kinds).toContainEqual(['tiles.example', true])
    expect(queued.find(({ item }) => item === child)).toBeTruthy()
    // and only the tile went to the tiles' lane
    expect(itemsOf(downloads.originQueues.get(null))).toEqual([child])
  })
})
