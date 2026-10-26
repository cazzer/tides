// The streamed surface's own download and parse queues (tides-zmw.9.25),
// in place of the library's shared defaults.
//
// Every terrain tile's "download" is synthetic (the plugin's fetchData hands
// back an empty buffer at once): the real request is its elevation grid's,
// made from inside the tile's parse and queued on the same Mapterhorn origin
// as the tiles' own downloads, since a tile's url is its grid's. The
// library's priority puts items without one (every tile) ahead of items
// with one (each grid fetch, -performance.now()), and an origin's queue
// starts at most maxJobsPerOrigin jobs per animation frame. So once tiles
// were asked for faster than that many a frame (200/s against 8 x 11 fps
// under a loaded GPU), the grid fetches never started, every parse slot
// waited on one, and the stream stopped for good. Fetches go first here
// (a parse is waiting on each, and there are at most as many as parse
// slots, so the tiles' downloads still get their turn); the cap is the
// RCA's 16 (the shared default is 25), still well under the server's
// limits; and the parse queue (whose every slot holds a tile from its grid
// fetch through decode, the frame budget and its imagery) is the tiles'
// own at 16 slots, not the library's shared 5.
import { DEFAULT_DOWNLOAD_QUEUE, DEFAULT_PARSE_QUEUE, DownloadPriorityQueue, PriorityQueue } from '3d-tiles-renderer/core'

/** Requests in flight (and started per frame) per server. */
export const SURFACE_JOBS_PER_ORIGIN = 16
/** Tiles parsing at once: each holds its grid fetch, decode, budget turn and imagery fetch, one after another. */
export const SURFACE_PARSE_JOBS = 16

type Comparator = (a: unknown, b: unknown) => number

/** A queued tile (the library's tile objects carry `internal`); anything else is a data fetch. */
const isTile = (item: unknown) => typeof item === 'object' && item !== null && 'internal' in item

/**
 * The download queues' order: data fetches (elevation grids, imagery)
 * before tiles' downloads, then the library's own order. Like the
 * library's comparators, a positive answer runs `a` first.
 */
export function surfaceDownloadPriority(base: Comparator): Comparator {
  return (a, b) => {
    const ta = isTile(a)
    const tb = isTile(b)
    if (ta !== tb) return ta ? -1 : 1
    return base(a, b)
  }
}

export interface SurfaceQueues {
  downloads: DownloadPriorityQueue
  parse: PriorityQueue
}

export function createSurfaceQueues(): SurfaceQueues {
  const downloads = new DownloadPriorityQueue()
  downloads.maxJobsPerOrigin = SURFACE_JOBS_PER_ORIGIN
  downloads.priorityCallback = surfaceDownloadPriority(DEFAULT_DOWNLOAD_QUEUE.priorityCallback as Comparator)
  const parse = new PriorityQueue()
  parse.maxJobs = SURFACE_PARSE_JOBS
  parse.priorityCallback = DEFAULT_PARSE_QUEUE.priorityCallback
  return { downloads, parse }
}
