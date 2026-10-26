import { DEFAULT_DOWNLOAD_QUEUE, DownloadPriorityQueue } from '3d-tiles-renderer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSurfaceQueues, SURFACE_JOBS_PER_ORIGIN, SURFACE_PARSE_JOBS, surfaceDownloadPriority } from './surface-queues'

const ORIGIN = 'https://tiles.mapterhorn.com'

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
  // so a frame is one explicit tryRunJobs.
  let frames: (() => void)[]
  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb))
  })
  afterEach(() => vi.unstubAllGlobals())

  it("are the tiles' own, with 16 downloads per server and 16 parses", () => {
    const { downloads, parse } = createSurfaceQueues()
    expect(SURFACE_JOBS_PER_ORIGIN).toBe(16)
    expect(SURFACE_PARSE_JOBS).toBe(16)
    expect(downloads.maxJobsPerOrigin).toBe(16)
    expect(parse.maxJobs).toBe(16)
  })

  it('start a grid fetch ahead of every tile download queued on its server', () => {
    const { downloads } = createSurfaceQueues()
    downloads.maxJobsPerOrigin = 2
    const started: string[] = []
    const add = (item: { name: string }) => downloads.add(`${ORIGIN}/12/1/2.webp`, item, () => started.push(item.name))
    // tiles asked for before and after the fetch, far more than a frame starts
    for (let i = 0; i < 5; i++) add(tile(`t${i}`, i))
    add(fetchItem('grid-a', -1000))
    for (let i = 5; i < 10; i++) add(tile(`t${i}`, i))
    add(fetchItem('grid-b', -2000))
    const queue = downloads.originQueues.get(ORIGIN)!
    queue.tryRunJobs()
    // both fetches first (the older, -1000, ahead), then the nearest tiles
    expect(started).toEqual(['grid-a', 'grid-b'])
    queue.tryRunJobs()
    expect(started.slice(2)).toEqual(['t0', 't1'])
  })

  it('never let a stream of tile downloads starve the fetches (the 9.25 stall)', () => {
    // each frame: 40 new tiles, more than the frame starts, and one fetch a parse is waiting on
    const stream = (downloads: DownloadPriorityQueue) => {
      const started: string[] = []
      const add = (item: { name: string }) => downloads.add(`${ORIGIN}/14/3/4.webp`, item, () => started.push(item.name))
      for (let frame = 0; frame < 5; frame++) {
        for (let i = 0; i < 40; i++) add(tile(`f${frame}t${i}`, i))
        add(fetchItem(`grid${frame}`, -frame))
        downloads.originQueues.get(ORIGIN)!.tryRunJobs()
      }
      return started.filter((name) => name.startsWith('grid'))
    }
    expect(stream(createSurfaceQueues().downloads)).toEqual(['grid0', 'grid1', 'grid2', 'grid3', 'grid4'])
    // the library's own order, as before: not one fetch starts
    const library = new DownloadPriorityQueue()
    library.maxJobsPerOrigin = SURFACE_JOBS_PER_ORIGIN
    library.priorityCallback = DEFAULT_DOWNLOAD_QUEUE.priorityCallback
    expect(stream(library)).toEqual([])
  })

  it('keep the library order among tiles and among fetches', () => {
    const base = vi.fn(() => 1)
    const order = surfaceDownloadPriority(base)
    expect(order(fetchItem('g', 0), tile('t'))).toBe(1)
    expect(order(tile('t'), fetchItem('g', 0))).toBe(-1)
    expect(base).not.toHaveBeenCalled()
    expect(order(tile('a'), tile('b'))).toBe(1)
    expect(order(fetchItem('a', 0), fetchItem('b', 1))).toBe(1)
    expect(base).toHaveBeenCalledTimes(2)
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
