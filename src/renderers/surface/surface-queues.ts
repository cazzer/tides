// The streamed surface's own download and parse queues (tides-zmw.9.25),
// in place of the library's shared defaults.
//
// Every terrain tile's "download" is synthetic (the plugin's fetchData hands
// back an empty buffer at once): the real request is its elevation grid's,
// made from inside the tile's parse. The tile's url is its grid's, so the
// library queued both on the same Mapterhorn origin, where its order puts
// items without a priority (every tile) ahead of items with one (each grid
// fetch, -performance.now()), and an origin's queue starts at most
// maxJobsPerOrigin jobs per animation frame. Once tiles were asked for
// faster than that (200/s against 8 x 11 fps under a loaded GPU), the grid
// fetches never started, every parse slot waited on one, and the stream
// stopped for good.
//
// Here the tiles' synthetic downloads never share a queue with network
// fetches: they go to a lane of their own (the queue the library keeps for
// items without a url), so neither can starve the other however many of
// the other are waiting (fetches can outnumber the parse slots two or three
// to one: grids above for coverage ends, retries). The cap per server is the
// RCA's 16 (the shared default is 25), still well under the servers'
// limits; and the parse queue, whose every slot holds a tile from its grid
// fetch through decode, the frame budget and its imagery, is the tiles' own
// at 16 slots, not the library's shared 5.
import { DEFAULT_DOWNLOAD_QUEUE, DEFAULT_PARSE_QUEUE, DownloadPriorityQueue, PriorityQueue } from '3d-tiles-renderer/core'

/** Requests in flight (and started per frame) per server, and tiles' synthetic downloads started per frame. */
export const SURFACE_JOBS_PER_ORIGIN = 16
/** Tiles parsing at once: each holds its grid fetch, decode, budget turn and imagery fetch, one after another. */
export const SURFACE_PARSE_JOBS = 16

/**
 * A tile's own download: the library's tile objects carry `internal` and no
 * numeric priority; its data fetches (TerrainRGBMeshPlugin's grid fetches,
 * ImageOverlay's imagery) are bare `{ priority: -performance.now() }`.
 */
export function isTileDownload(item: unknown): boolean {
  return typeof item === 'object' && item !== null && 'internal' in item && typeof (item as { priority?: unknown }).priority !== 'number'
}

/** A DownloadPriorityQueue that keeps tiles' synthetic downloads off the servers' queues. */
export class SurfaceDownloadQueue extends DownloadPriorityQueue {
  override add(url: string | null, item: unknown, callback: (item: unknown) => unknown, signal: AbortSignal | null = null): Promise<unknown> {
    return super.add(isTileDownload(item) ? null : url, item, callback, signal)
  }
}

export interface SurfaceQueues {
  downloads: DownloadPriorityQueue
  parse: PriorityQueue
}

export function createSurfaceQueues(): SurfaceQueues {
  const downloads = new SurfaceDownloadQueue()
  downloads.maxJobsPerOrigin = SURFACE_JOBS_PER_ORIGIN
  downloads.priorityCallback = DEFAULT_DOWNLOAD_QUEUE.priorityCallback
  const parse = new PriorityQueue()
  parse.maxJobs = SURFACE_PARSE_JOBS
  parse.priorityCallback = DEFAULT_PARSE_QUEUE.priorityCallback
  return { downloads, parse }
}
