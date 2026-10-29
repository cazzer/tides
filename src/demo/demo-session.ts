// Entering, stepping through and leaving a demo (tides-zec.5), as pure store
// patches, like ship-session.ts. Each step's patch is steps 0..i folded over
// the view the user had on entry, so going back to a step gives the same view
// as reaching it from the start.

import type {
  CameraFocus,
  Layout,
  Location,
  PanelKey,
  SystemAids,
} from '../store'
import type { SkyLook } from '../sky-look'
import type { Demo } from './demo-script'
import {
  shownEarthSpin,
  stepTravel,
  travelRun,
  type EarthSpinHold,
  type TravelRun,
} from './demo-travel'

/** The view a demo overrides, put back on exit. */
export interface DemoSaved {
  timestamp: number | null
  timeScale: number
  cameraFocus: CameraFocus
  mainPanel: PanelKey
  layout: Layout
  location: Location | null
  showPlanets: boolean
  showConstellations: boolean
  showConstellationArt: boolean
  showLunar: boolean
  showZodiac: boolean
  systemAids: SystemAids
  skyLook: SkyLook | null
  skyFov: number | null
  compass: boolean
}

export interface DemoRun {
  id: string
  step: number
}

/** DemoSaved as it was on entry, and when (wall-clock epoch ms) that was. */
export type DemoSnapshot = DemoSaved & { enteredAt: number }

export interface DemoSessionState extends DemoSaved {
  demo: DemoRun | null
  /** What DemoSaved held on entry; null outside a demo. */
  demoSaved: DemoSnapshot | null
  shipMode: boolean
  /** A date jump under way, landing on this date. */
  jumpDate: Date | null
  /** The clock travelling to the step's date (DemoClock carries it); null
   * otherwise. */
  demoTravel: TravelRun | null
}

/** The fields a step sets: all of DemoSaved but compass mode. */
type DemoView = Omit<DemoSaved, 'compass'>

function pickView(s: DemoView): DemoView {
  return {
    timestamp: s.timestamp,
    timeScale: s.timeScale,
    cameraFocus: s.cameraFocus,
    mainPanel: s.mainPanel,
    layout: s.layout,
    location: s.location,
    showPlanets: s.showPlanets,
    showConstellations: s.showConstellations,
    showConstellationArt: s.showConstellationArt,
    showLunar: s.showLunar,
    showZodiac: s.showZodiac,
    systemAids: s.systemAids,
    skyLook: s.skyLook,
    skyFov: s.skyFov,
  }
}

function pickSaved(s: DemoSaved): DemoSaved {
  return { ...pickView(s), compass: s.compass }
}

/**
 * The store patch for step `index`: its date, set directly (any date jump
 * cancelled, so it can't tween over it), and every other field as the
 * latest step up to `index` that sets it left it, else as saved.
 */
export function demoStepPatch(saved: DemoSaved, demo: Demo, index: number) {
  const view = pickView(saved)
  const systemAids = { ...saved.systemAids }
  for (const step of demo.steps.slice(0, index + 1)) {
    if (step.timeScale !== undefined) view.timeScale = step.timeScale
    if (step.camera) view.cameraFocus = step.camera.focus
    if (step.mainPanel) view.mainPanel = step.mainPanel
    if (step.layout) view.layout = step.layout
    if (step.location) view.location = step.location
    if (step.skyLook) view.skyLook = step.skyLook
    if (step.skyFov !== undefined) view.skyFov = step.skyFov
    const { systemAids: aids, ...flags } = step.overlays ?? {}
    for (const [key, on] of Object.entries(flags)) {
      if (on !== undefined) view[key as keyof typeof flags] = on
    }
    Object.assign(systemAids, aids)
  }
  return {
    ...view,
    systemAids,
    timestamp: Date.parse(demo.steps[index].date),
    jumpDate: null,
    demoTravel: null,
    demo: { id: demo.id, step: index },
  }
}

/**
 * The store patch that starts `demo` at its first step, compass mode off (it
 * would turn View from Earth away from the step's look). Null while a demo or
 * ship mode runs, so a second entry never saves the demo's view over the
 * user's own.
 */
export function enterDemoPatch(s: DemoSessionState, demo: Demo, now = Date.now()) {
  if (s.demo || s.shipMode || demo.steps.length === 0) return null
  // Mid-jump, the date picked is the one to come back to.
  const saved: DemoSnapshot = {
    ...pickSaved(s),
    timestamp: s.jumpDate?.getTime() ?? s.timestamp,
    enteredAt: now,
  }
  return { demoSaved: saved, compass: false, ...demoStepPatch(saved, demo, 0) }
}

/**
 * The store patch for step `index` of the running demo; null if out of
 * range. Moving to another step with a travel keeps the instant shown and
 * starts the clock travelling from it. Next while a travel runs lands it
 * instead: the first press finishes the journey, the second moves on.
 */
export function goToDemoStepPatch(s: DemoSessionState, demo: Demo, index: number, reduced = false) {
  if (!s.demo || !s.demoSaved || s.demo.id !== demo.id) return null
  if (!Number.isInteger(index) || index < 0 || index >= demo.steps.length) return null
  if (s.demoTravel && index === s.demo.step + 1) return { timestamp: s.demoTravel.to, demoTravel: null }
  const patch = demoStepPatch(s.demoSaved, demo, index)
  if (index === s.demo.step) return patch
  const run = travelRun(demo.steps[index].travel, s.timestamp, patch.timestamp, reduced)
  return run ? { ...patch, timestamp: s.timestamp, demoTravel: run } : patch
}

/**
 * The store patch that leaves the demo, putting back everything saved on
 * entry in one go (setShowPlanets and setLocation would move the focus).
 * Someone following real time comes back to now, the time the demo took
 * included; any other clock comes back as it was. Null outside a demo.
 */
export function exitDemoPatch(s: DemoSessionState, now = Date.now()) {
  if (!s.demo || !s.demoSaved) return null
  const { enteredAt, ...saved } = s.demoSaved
  const timestamp =
    saved.timeScale === 1 && saved.timestamp != null
      ? saved.timestamp + (now - enteredAt)
      : saved.timestamp
  return { demo: null, demoSaved: null, jumpDate: null, demoTravel: null, ...saved, timestamp }
}

/** The speed Play runs a step at: its own, or an hour a second where it pauses. */
export const DEMO_PLAY_SCALE = 3600

export function demoPlayScale(s: DemoSessionState, demo: Demo): number {
  if (!s.demo || !s.demoSaved) return DEMO_PLAY_SCALE
  const { timeScale } = demoStepPatch(s.demoSaved, demo, s.demo.step)
  return timeScale > 0 ? timeScale : DEMO_PLAY_SCALE
}

/**
 * Whether the clock, moving from `previous` to `now`, has just reached the
 * step's stop. Only the crossing counts, so Play after the stop runs on.
 */
export function reachedUntil(previous: number | null, now: number, until: number): boolean {
  return previous != null && previous < until && now >= until
}

/** What DemoClock carries from one frame to the next. */
export interface DemoClockTrack {
  travel: TravelRun | null
  elapsed: number
  /** The spin shown as the travel set out (demo-travel.ts). */
  spinFrom: number
  /** The clock as last seen, for reachedUntil; null after a step change. */
  previous: number | null
}

export function demoClockTrack(): DemoClockTrack {
  return { travel: null, elapsed: 0, spinFrom: 0, previous: null }
}

/**
 * One DemoClock frame, `delta` real seconds on: the store write it makes
 * (null for none) and Earth's spin hold. A travel carries the clock and
 * checks no stop on the way: a travel back past `until` isn't reaching it,
 * and the step's date is short of it anyway. Once landed, the clock runs on
 * from the step's date and stops at `until`. Updates `track`.
 */
export function demoClockFrame(
  track: DemoClockTrack,
  travel: TravelRun | null,
  timestamp: number | null,
  until: number | null,
  delta: number
): {
  write: { timestamp: number; timeScale?: number; demoTravel?: null } | null
  hold: EarthSpinHold | null
} {
  if (travel !== track.travel) {
    // Read before the hold moves on: a travel begun mid-travel (Prev, say)
    // turns on from the angle shown, not the true one.
    track.spinFrom = travel ? shownEarthSpin(travel.from) : 0
    track.travel = travel
    track.elapsed = 0
  }
  if (travel) {
    const step = stepTravel(travel, track.elapsed, delta, track.spinFrom)
    track.elapsed = step.elapsed
    track.previous = step.timestamp
    const write = step.done ? { timestamp: step.timestamp, demoTravel: null } : { timestamp: step.timestamp }
    return { write, hold: step.hold }
  }
  if (until != null && timestamp != null && reachedUntil(track.previous, timestamp, until)) {
    track.previous = until
    return { write: { timestamp: until, timeScale: 0 }, hold: null }
  }
  track.previous = timestamp
  return { write: null, hold: null }
}
