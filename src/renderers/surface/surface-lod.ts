// How much detail the streamed surface asks for (tides-zmw.9.2): the tiles'
// errorTarget, in screen pixels of geometric error, from how fast the ground
// is sweeping past. The spike measured 53 MB/min of downloads at errorTarget
// 1 flying fast and 22 MB/min at 4, with no visible loss at speed: detail
// that is gone before it loads is wasted bandwidth and decode time.
//
// The sweep rate is speed over height above the surface (1/s: the fraction
// of the view's footprint crossed each second), so the same flight speed
// costs detail low down and nothing high up. Rises fast, so a dive sheds
// detail before it floods the queue, and falls slowly, so detail returns once
// the flight has settled rather than on every throttle wobble.
//
// tides-zmw.9.22 re-spanned the ramp for tides-zmw.9.18's speed law, under
// which the sweep rate near the ground is EARTH_GAP_RATE (2) x the throttle:
// the old 0.05-0.5/s ramp sat at 4 for any throttle over 0.25. Low down, the
// detail errorTarget 1 asks for is drawn even at full throttle (headless
// canyon passes; numbers in the bead): it is not gone before it loads, and
// what speed costs is downloads. So 1 up to throttle 0.25, 2 at 0.5, 3 at
// full throttle, and 4 only past 4/s (diving at the ground). The tiles under
// and around the eye never coarsen with it (surface-coverage.ts: the ship's
// floor reads them), out to eyeMarginMetres.
//
// tides-zmw.9.24 sized the tile cache to the view: the tiles a view needs
// grow with the square root of its pixels (its height, at one aspect), so
// the cache's marks scale with it, and past DETAIL_PIXELS_MAX the tiles pick
// their detail for that many pixels rather than load a gigabyte. Marks that
// fall (a smaller view) wait out CACHE_LOWER_DELAY_MS of a steady size
// (cacheMarkSetter), so a resize drag doesn't evict on every step.

import { EARTH_UNITS_PER_METRE, FINE_GROUND_CLEARANCE, floorReach } from '../../ship/ship-bodies'

/** errorTarget at rest: the plugin's recommended 1, 2 on touch devices. */
export const BASE_ERROR_TARGET = { desktop: 1, touch: 2 }
/** errorTarget at full sweep. */
export const MAX_ERROR_TARGET = 4
/** Sweep rates (1/s) the ramp runs between, log-linear: throttle 0.25 to past full throttle near the ground. */
export const RATE_LOW = 0.5
export const RATE_HIGH = 4
/** Smoothing time constants, seconds. */
export const RISE_SECONDS = 0.3
export const FALL_SECONDS = 2

/** The errorTarget a sweep rate (1/s) asks for. */
export function surfaceErrorTarget(rate: number, touch: boolean): number {
  const base = touch ? BASE_ERROR_TARGET.touch : BASE_ERROR_TARGET.desktop
  if (!(rate > RATE_LOW)) return base
  const t = Math.min(1, Math.log(rate / RATE_LOW) / Math.log(RATE_HIGH / RATE_LOW))
  return base + (MAX_ERROR_TARGET - base) * t
}

/** Moves `current` towards `target` over `dt` seconds, faster up than down. */
export function smoothErrorTarget(current: number, target: number, dt: number): number {
  if (!Number.isFinite(current)) return target
  const tau = target > current ? RISE_SECONDS : FALL_SECONDS
  return target + (current - target) * Math.exp(-Math.max(0, dt) / tau)
}

/**
 * The sweep rate over Earth (1/s) from the ship's speed (units/s) and its
 * nearest surface; 0 when the nearest body isn't Earth (the tiles aren't the
 * ground there) or the ship is still.
 */
export function sweepRate(speed: number, nearest: { key: string | null; surfaceDistance: number }): number {
  if (nearest.key !== 'earth' || !(speed > 0)) return 0
  return speed / Math.max(nearest.surfaceDistance, 1e-9)
}

/** The floor's window around the eye (ship-bodies.ts floorReach at the fine stop), metres. */
export const EYE_REACH_METRES = floorReach(FINE_GROUND_CLEARANCE) / EARTH_UNITS_PER_METRE
/** How far ahead (seconds of flight) the tiles around the eye keep their rest detail. */
export const EYE_LEAD_SECONDS = 1

/**
 * How far around the eye (metres) the tiles keep their rest detail at a
 * `speed` (metres/s): the floor's window, or a second's flight, so the tile
 * the ship crosses into next is already refined when the floor reads it.
 */
export function eyeMarginMetres(speed: number): number {
  return Math.max(EYE_REACH_METRES, Number.isFinite(speed) ? Math.abs(speed) * EYE_LEAD_SECONDS : 0)
}

const GIGABYTE = 2 ** 30
/** The view the cache's marks are given for. */
export const REFERENCE_PIXELS = 1920 * 1080
/**
 * The cache's marks (bytes) at REFERENCE_PIXELS, scaled by the square root of
 * the detail pixels: past `max` new tiles are refused (the parents stay
 * drawn), and unused ones are evicted down to `min` (the library's LRU
 * cache trims whenever it is over `min`). `min` is ~1.15x the working set
 * of the heaviest stop measured (the Grand Canyon gorge, 464 MB at
 * 1920x1080), so the tiles just out of view survive a look around; `max`
 * leaves room over it for the loads in flight.
 */
export const CACHE_BYTES_AT_REFERENCE = { min: 0.5 * GIGABYTE, max: 0.65 * GIGABYTE }
/** Never under tides-zmw.9.2's fixed marks, whatever the view. */
export const CACHE_BYTES_FLOOR = { min: 0.15 * GIGABYTE, max: 0.25 * GIGABYTE }
/**
 * The most CSS pixels the tiles pick their detail for, a 2560x1440 view's
 * (a 5K display at DPR 2 gets all of its own): a larger view's resolution is
 * scaled down to this many, so its error target counts pixels a little
 * larger than its own. Caps the cache's high mark at 0.87 GB, where
 * 3840x2160 would want over 1 GB for its working set alone.
 */
export const DETAIL_PIXELS_MAX = 2560 * 1440

export interface SurfaceDetail {
  /** The resolution the tiles pick their detail for (CSS pixels, the view's aspect). */
  width: number
  height: number
  /** The tile cache's marks, bytes. */
  cache: { min: number; max: number }
}

/** The detail resolution and cache marks for a view of `width` x `height` CSS pixels. */
export function surfaceDetail(width: number, height: number): SurfaceDetail {
  // No size (NaN, negative) is an empty view.
  width = width > 0 ? width : 0
  height = height > 0 ? height : 0
  const pixels = width * height
  const k = pixels > DETAIL_PIXELS_MAX ? Math.sqrt(DETAIL_PIXELS_MAX / pixels) : 1
  const scale = Math.sqrt((pixels * k * k) / REFERENCE_PIXELS) || 0
  return {
    width: width * k,
    height: height * k,
    cache: {
      min: Math.max(CACHE_BYTES_FLOOR.min, CACHE_BYTES_AT_REFERENCE.min * scale),
      max: Math.max(CACHE_BYTES_FLOOR.max, CACHE_BYTES_AT_REFERENCE.max * scale),
    },
  }
}

/** How long (ms) a view must keep its size before the cache's marks fall to it. */
export const CACHE_LOWER_DELAY_MS = 1000

export interface CacheMarks {
  min: number
  max: number
}

/**
 * Applies cache marks as the view changes: raised at once, lowered only
 * once the size has held CACHE_LOWER_DELAY_MS (each new size restarts the
 * wait), since lowering the high mark evicts down to it in one pass, in-
 * flight loads under the eye included.
 */
export function cacheMarkSetter(apply: (marks: CacheMarks) => void, delayMs = CACHE_LOWER_DELAY_MS) {
  let current: CacheMarks | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const put = (marks: CacheMarks) => {
    if (current && current.min === marks.min && current.max === marks.max) return
    current = { ...marks }
    apply(current)
  }
  return {
    set(marks: CacheMarks) {
      cancel()
      if (!current) return put(marks)
      // Whatever rises now; the rest once the size has settled.
      put({ min: Math.max(current.min, marks.min), max: Math.max(current.max, marks.max) })
      if (marks.min < current.min || marks.max < current.max) {
        timer = setTimeout(() => {
          timer = null
          put(marks)
        }, delayMs)
      }
    },
    dispose: cancel,
  }
}
