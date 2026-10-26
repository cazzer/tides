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

/** errorTarget at rest: the plugin's recommended 1, 2 on touch devices. */
export const BASE_ERROR_TARGET = { desktop: 1, touch: 2 }
/** errorTarget at full sweep. */
export const MAX_ERROR_TARGET = 4
/** Sweep rates (1/s) the ramp runs between, log-linear. */
export const RATE_LOW = 0.05
export const RATE_HIGH = 0.5
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
