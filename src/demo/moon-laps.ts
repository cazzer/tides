// How fast a sped-up clock takes a moon round (the planets tour,
// tides-ufyr.7): its stops pick a speed at which the moon the caption names
// goes round within the stop, and none of the planet's moons goes round so
// fast that it strobes.

const SECONDS_PER_DAY = 86_400

/**
 * The fewest frames (at 60 a second) a moon may take to go round once: at
 * 30 it moves 12° a frame, still read as going round rather than jumping.
 * [TUNE]
 */
export const MIN_LAP_FRAMES = 30

/**
 * The real seconds at the start of a stop the eye spends flying to it
 * (DemoPlayer's DEMO_FLIGHT_SECONDS): the laps a stop promises are counted
 * after it.
 */
export const FLIGHT_LEAD_SECONDS = 3

/** Real seconds for one lap of a moon of `periodDays` at `timeScale` sim seconds a second. */
export function lapSeconds(periodDays: number, timeScale: number): number {
  return (periodDays * SECONDS_PER_DAY) / timeScale
}
