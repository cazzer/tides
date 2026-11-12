// How fast a sped-up clock takes a moon round (the planets tour,
// tides-ufyr.7): its stops pick a speed at which the moon the caption names
// goes round within the stop, and none of the planet's moons goes round so
// fast that it strobes.

import { DEMO_FLIGHT_SECONDS } from './demo-flight'

const SECONDS_PER_DAY = 86_400

/**
 * The fewest frames (at 60 a second) a moon may take to go round once: at
 * 30 it moves 12° a frame, still read as going round rather than jumping.
 * [TUNE]
 */
export const MIN_LAP_FRAMES = 30

/** The least a stop runs on past its laps, seconds, so the last isn't cut
 * off at the stop. */
export const MIN_LAP_SLACK_SECONDS = 1.5

/** Real seconds for one lap of a moon of `periodDays` at `timeScale` sim seconds a second. */
export function lapSeconds(periodDays: number, timeScale: number): number {
  return (periodDays * SECONDS_PER_DAY) / timeScale
}

/**
 * The real seconds a stop from `from` to `to` (epoch ms) at `timeScale`
 * leaves for laps once the eye has flown in (DEMO_FLIGHT_SECONDS).
 */
export function stopLapSeconds(from: number, to: number, timeScale: number): number {
  return (to - from) / 1000 / timeScale - DEMO_FLIGHT_SECONDS
}
