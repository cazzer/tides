// The streamed surface's memory budget (tides-8h7.5): what the tiles may
// hold and run at once. Desktops keep the view-sized marks and the queues of
// tides-zmw.9.24/9.25. Phones and tablets (isTouchDevice: by user agent,
// iPads included) on the high tier got all of that too, and a pivot low to
// the ground filled the page past what iOS lets a tab keep (RCA on
// tides-8h7): the LRU marks count only the GPU-side bytes, while each
// tile's CPU copies (its grid, geometry and imagery before upload) roughly
// double the real cost; 16 parses and 16 requests per server in flight;
// and every bake waiting for a worker holds a ~2 MB copy of its grid, with
// no bound on how many wait. On touch, the marks are capped at a real
// budget, the queues are halved, the waiting bakes are bounded, and the
// system view's tiles stop choosing and fetching tiles while they sit
// above their range out their leave grace (tides-8h7), drawing nothing.
import { aboveTileRange } from '../../close-zoom-rules'
import type { CacheMarks } from './surface-lod'
import { SURFACE_JOBS_PER_ORIGIN, SURFACE_PARSE_JOBS } from './surface-queues'

const GIGABYTE = 2 ** 30

export interface SurfaceMemoryBudget {
  /** Requests in flight (and started per frame) per server. */
  jobsPerOrigin: number
  /** Tiles parsing at once. */
  parseJobs: number
  /** Horizon bakes waiting for a worker; more are dropped (and retried later, terrain-internals.ts). */
  maxWaitingBakes: number
  /** The cache's marks in real bytes (CPU copies included), or null: the view's marks alone (surfaceDetail). */
  cacheRealBytes: CacheMarks | null
  /** Whether the system view skips tiles.update() while its tiles sit above their range (pauseTileUpdates). */
  pauseAboveRange: boolean
}

/** As before tides-8h7.5: the view's marks, the tiles' own queues, every bake waits. */
export const DESKTOP_SURFACE_BUDGET: SurfaceMemoryBudget = {
  jobsPerOrigin: SURFACE_JOBS_PER_ORIGIN,
  parseJobs: SURFACE_PARSE_JOBS,
  maxWaitingBakes: Infinity,
  cacheRealBytes: null,
  pauseAboveRange: false,
}

/**
 * Phones and tablets. The marks hold a 390x844 phone's view-sized ones
 * (0.20/0.26 GiB counted) to 0.14/0.18 GiB counted, 0.28/0.36 GiB real.
 */
export const TOUCH_SURFACE_BUDGET: SurfaceMemoryBudget = {
  // [TUNE] at least parseJobs: each parse waits on its grid's request (tides-zmw.9.25)
  jobsPerOrigin: 8,
  // [TUNE]
  parseJobs: 8,
  // [TUNE] ~2 MB each
  maxWaitingBakes: 16,
  // [TUNE]
  cacheRealBytes: { min: 0.28 * GIGABYTE, max: 0.36 * GIGABYTE },
  pauseAboveRange: true,
}

/**
 * Real bytes per byte the cache counts: the tides-8h7 soak found the page
 * holding about twice what the LRU counted (the tiles' CPU copies). [TUNE]
 */
export const CPU_COPY_FACTOR = 2

/** This device's budget: `touch` from touchDevice() (../../quality.ts). */
export function surfaceMemoryBudget(touch: boolean): SurfaceMemoryBudget {
  return touch ? TOUCH_SURFACE_BUDGET : DESKTOP_SURFACE_BUDGET
}

/** The view's cache marks (surfaceDetail's), held to the budget's real bytes; min never above max. */
export function capCacheMarks(marks: CacheMarks, budget: SurfaceMemoryBudget): CacheMarks {
  const cap = budget.cacheRealBytes
  if (!cap) return marks
  const max = Math.min(marks.max, cap.max / CPU_COPY_FACTOR)
  return { min: Math.min(marks.min, cap.min / CPU_COPY_FACTOR, max), max }
}

/**
 * Whether the tiles skip this frame's update() (no new tiles chosen or
 * fetched; the parses in flight still finish): the system view's eye above
 * the tiles' range (aboveTileRange), where they draw nothing, on a budget
 * that pauses there. `top` is the handover's top, in `altitude`'s units.
 */
export function pauseTileUpdates(budget: SurfaceMemoryBudget, eye: 'ship' | 'system', altitude: number, top: number): boolean {
  return budget.pauseAboveRange && eye === 'system' && aboveTileRange(altitude, top)
}
