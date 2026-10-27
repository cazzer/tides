// When the ship's one-shot cues sound (tides-a4j.3): edges in state the
// flight already keeps, found by one watcher each frame, so the impact,
// approach, targeting and assist code never calls into audio. Pure: the
// frame hands it the signals and the wall clock, and it says which cues
// fire. Each fires once per event, never per frame; the klaxon is a fixed
// short sound, rate-limited, so it can't loop while a warning holds.

import type { ApproachStatus } from '../approach'

export type ShipCueKind = 'impact' | 'klaxon' | 'lock' | 'assistOn' | 'assistOff'

/** What the watcher reads each frame. */
export interface ShipCueSignals {
  /** shipImpacts.count: hits so far, only ever up. */
  impacts: number
  /** shipApproach.key and .status: the subject and how its approach stands. */
  subject: string | null
  status: ApproachStatus
  /** The locked target (getShipTarget). */
  target: string | null
  /** shipInput.flightAssist. */
  flightAssist: boolean
}

/** [TUNE] Least time between two impact thuds, ms (a scrape bouncing along the ground). */
export const IMPACT_CUE_COOLDOWN_MS = 300
/** [TUNE] Least time between two klaxons, ms, however the warning comes and goes. */
export const KLAXON_COOLDOWN_MS = 4000

/** The approach warning's level: 0 none, 1 too fast to stop, 2 overshooting. */
function warningLevel(subject: string | null, status: ApproachStatus): number {
  if (subject == null) return 0
  return status === 'over' ? 2 : status === 'fast' ? 1 : 0
}

export interface ShipCueWatch {
  primed: boolean
  impacts: number
  warning: number
  target: string | null
  flightAssist: boolean
  impactAt: number
  klaxonAt: number
}

export function createShipCueWatch(): ShipCueWatch {
  return {
    primed: false,
    impacts: 0,
    warning: 0,
    target: null,
    flightAssist: true,
    impactAt: -Infinity,
    klaxonAt: -Infinity,
  }
}

/**
 * Compares this frame's signals with the last and calls `fire` once for
 * each cue they call for. The first frame only takes the state in, so
 * entering the ship (Flight Assist on, say) sounds nothing.
 * - impact: the count went up, past the cooldown.
 * - klaxon: the approach warning rose (none to too fast, or to
 *   overshooting), past the cooldown.
 * - lock: a target was locked, or the lock moved to another.
 * - assistOn / assistOff: Flight Assist switched.
 */
export function watchShipCues(
  watch: ShipCueWatch,
  signals: ShipCueSignals,
  nowMs: number,
  fire: (kind: ShipCueKind) => void
): void {
  const warning = warningLevel(signals.subject, signals.status)
  if (watch.primed) {
    if (signals.impacts > watch.impacts && nowMs - watch.impactAt >= IMPACT_CUE_COOLDOWN_MS) {
      watch.impactAt = nowMs
      fire('impact')
    }
    if (warning > watch.warning && nowMs - watch.klaxonAt >= KLAXON_COOLDOWN_MS) {
      watch.klaxonAt = nowMs
      fire('klaxon')
    }
    if (signals.target != null && signals.target !== watch.target) fire('lock')
    if (signals.flightAssist !== watch.flightAssist) fire(signals.flightAssist ? 'assistOn' : 'assistOff')
  }
  watch.primed = true
  watch.impacts = signals.impacts
  watch.warning = warning
  watch.target = signals.target
  watch.flightAssist = signals.flightAssist
}
