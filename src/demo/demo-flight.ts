// The eye's flight from one body to another between demo steps
// (DemoPlayer, tides-ufyr.7): it sets out from where it is, about the new
// focus, and arcs to the step's pose over DEMO_FLIGHT_SECONDS.

import type { Vector3 } from 'three'
import type { Demo, DemoFocus } from './demo-script'

/**
 * How long the eye takes to fly to a step's pose about another body than
 * the step before's, in seconds. The planets tour counts it out of each
 * stop's laps (moon-laps.ts). [TUNE]
 */
export const DEMO_FLIGHT_SECONDS = 3

// Module state, not the store: MoonBodies reads it every frame. Written only
// by DemoPlayer.
let flying = false

export function setDemoFlight(on: boolean): void {
  flying = on
}

/** Whether a flight is under way: no moon system grows until it lands
 * (stepMoonExpansions' holdGrowth), so the eye never flies through one. */
export function demoFlightRunning(): boolean {
  return flying
}

/**
 * The view's target `t` (the flight's 0..1 progress) of the way from where
 * CameraProvider has turned it toward the focus, which trails a moving
 * focus, onto the focus itself: on it exactly as the flight lands, so
 * locking it there then moves nothing.
 */
export function blendFlightTarget(target: Vector3, focus: Vector3, t: number): Vector3 {
  return target.lerp(focus, t)
}

/** The focus of the last pose before step `index`, as a run from the start
 * would have left the eye; null for none. */
export function poseFocusBefore(demo: Demo, index: number): DemoFocus | null {
  for (let i = Math.min(index, demo.steps.length) - 1; i >= 0; i--) {
    const focus = demo.steps[i].camera?.focus
    if (focus) return focus
  }
  return null
}
