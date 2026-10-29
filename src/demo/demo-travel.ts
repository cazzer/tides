// A step's travel (DemoStep.travel): the clock carried from the instant
// shown to the step's date over a few seconds, instead of cutting to it.

import { easeProgress, type DemoTravel } from './demo-script'

/** The longest frame a demo's eases and travels count, so a stall doesn't skip them. */
export const DEMO_MAX_DELTA = 0.1

/** A rate travel that would take longer than this (seconds) cuts instead. */
export const TRAVEL_MAX_SECONDS = 12

/** A travel under way, from one sim instant (epoch ms) to another. */
export interface TravelRun {
  from: number
  to: number
  /** How long it takes, in real seconds. */
  seconds: number
  easing: 'smooth' | 'linear'
  holdSpin: boolean
  hideMoon: boolean
}

/**
 * The run for `travel` from the instant shown to the step's date, or null
 * where the clock cuts: no travel, reduced motion, no instant shown yet,
 * nowhere to go, or a rate too slow to cover the gap within the cap.
 */
export function travelRun(
  travel: DemoTravel | undefined,
  from: number | null,
  to: number,
  reduced: boolean
): TravelRun | null {
  if (!travel || reduced || from == null || from === to) return null
  const linear = travel.rate !== undefined
  const seconds = travel.rate !== undefined ? Math.abs(to - from) / 1000 / travel.rate : travel.seconds
  if (!(seconds > 0) || (linear && seconds > TRAVEL_MAX_SECONDS)) return null
  const hold = travel.hold ?? []
  return {
    from,
    to,
    seconds,
    easing: linear ? 'linear' : 'smooth',
    holdSpin: hold.includes('spin'),
    hideMoon: hold.includes('moon'),
  }
}

/** The sim instant `elapsed` real seconds into `run`; either direction. */
export function travelTimestamp(run: TravelRun, elapsed: number): number {
  const p =
    run.easing === 'linear'
      ? Math.min(1, Math.max(0, elapsed / run.seconds))
      : easeProgress(elapsed, run.seconds)
  return run.from + (run.to - run.from) * p
}
