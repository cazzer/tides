// A step's travel (DemoStep.travel): the clock carried from the instant
// shown to the step's date over a few seconds, instead of cutting to it.

import { earthSpin } from '../ephemeris'
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

/** One frame of a travel: where the clock is, and the spin hold to show. */
export interface TravelStep {
  elapsed: number
  timestamp: number
  /** Landed: the timestamp is exactly `to`, and nothing is held. */
  done: boolean
  hold: EarthSpinHold | null
}

/**
 * `run` a frame on, `delta` real seconds (capped at DEMO_MAX_DELTA) past
 * `elapsed`; the hold turns from spinFrom, the angle shown when it set out.
 */
export function stepTravel(run: TravelRun, elapsed: number, delta: number, spinFrom: number): TravelStep {
  const next = elapsed + Math.min(delta, DEMO_MAX_DELTA)
  const done = next >= run.seconds
  return {
    elapsed: next,
    timestamp: done ? run.to : travelTimestamp(run, next),
    done,
    hold: run.holdSpin && !done ? { from: run.from, to: run.to, spinFrom } : null,
  }
}

// --- Spin hold --------------------------------------------------------------

/** A spin hold under way: the travel's span and the angle it set out from. */
export interface EarthSpinHold {
  from: number
  to: number
  /** The spin shown at the travel's start (radians, as earthSpin). */
  spinFrom: number
}

function wrapPi(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI))
}

/**
 * Earth's spin shown at t under `hold`: turned from spinFrom the short way
 * round to the true spin at the travel's end, in step with the clock, so a
 * travel of months turns the globe under half a turn instead of strobing
 * through hundreds, and lands on the true spin with no snap.
 */
export function heldEarthSpin(t: number, hold: EarthSpinHold): number {
  const span = hold.to - hold.from
  const p = span === 0 ? 1 : Math.min(1, Math.max(0, (t - hold.from) / span))
  return hold.spinFrom + wrapPi(earthSpin(hold.to) - hold.spinFrom) * p
}

// Module state, not the store: Earth and everything drawn in its frame read
// it every frame. Written only by DemoClock.
let spinHold: EarthSpinHold | null = null

export function setEarthSpinHold(hold: EarthSpinHold | null): void {
  spinHold = hold
}

/** Earth's spin as drawn at t: the hold's while a travel holds it, else the true one. */
export function shownEarthSpin(t: number): number {
  return spinHold ? heldEarthSpin(t, spinHold) : earthSpin(t)
}

/** How far (radians) the drawn globe is turned short of the true one at t. */
export function earthSpinLag(t: number): number {
  return earthSpin(t) - shownEarthSpin(t)
}
