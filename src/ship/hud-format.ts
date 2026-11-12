// Text for the HUD's approach indicator and speed readout (tides-2hv.12),
// kept out of ShipHud so it can be tested without a DOM.

import type { ApproachStatus } from './approach'
import { bodyName, formatEta } from './ship-distances'
import { V_TOP } from './flight'

/**
 * formatSpeed's output split into number and unit, so the HUD can dim the
 * unit as it does "km/s": "15,500 km/s" → ["15,500", "km/s"], "540 km/h"
 * → ["540", "km/h"], "16c" → ["16", "c"], "—" → ["—", ""].
 */
export function speedParts(text: string): [string, string] {
  const match = /^(.*?)\s*(km\/s|km\/h|c)$/.exec(text)
  return match ? [match[1], match[2]] : [text, '']
}

/**
 * The cap is set by a well once it is this share of V_TOP or less; above it
 * the ship is in open space and the speed label names no well.
 */
export const WELL_LABEL_SHARE = 0.98

/** " · Sun's well" while a well holds the speed cap down, else "". */
export function wellSuffix(wellKey: string | null, speedCap: number): string {
  if (wellKey == null || !(speedCap < WELL_LABEL_SHARE * V_TOP)) return ''
  return ` · ${bodyName(wellKey)}'s well`
}

/** The tail of the approach cell: the ETA, or the warning in its place. */
export function approachTail(status: ApproachStatus, eta: number): string {
  if (status === 'over') return 'Overshooting'
  if (status === 'fast') return 'Too fast'
  return Number.isFinite(eta) ? `ETA ${formatEta(eta)}` : ''
}

/** What the announcer says on entering a warning state for `key`, or null. */
export function approachAnnouncement(status: ApproachStatus, key: string): string | null {
  if (status === 'over') return `Overshooting ${bodyName(key)}`
  if (status === 'fast') return `Too fast to stop at ${bodyName(key)}`
  return null
}

/** How long the moon-system cue shows after the ship crosses a system's edge. */
export const SYSTEM_CUE_MS = 2500

/** The cue's line: the ranges and speed just changed scale (ship-distances.ts). */
export function systemEdgeCue(parent: string, entering: boolean): string {
  return `${entering ? 'Entering' : 'Leaving'} ${bodyName(parent)}’s moons: distances rescaled`
}

/** What the announcer says for the cue. */
export function systemEdgeAnnouncement(parent: string, entering: boolean): string {
  return `${entering ? 'Entering' : 'Leaving'} ${bodyName(parent)}’s moon system. Distances rescaled.`
}

/**
 * The cue's state: the crossings seen, and its line and announcement until
 * `until` (ms, rAF clock).
 */
export interface SystemCue {
  seen: number
  text: string
  spoken: string
  until: number
}

/** A cue that has seen the `count` crossings so far, so it fires only on the next. */
export function createSystemCue(count: number): SystemCue {
  return { seen: count, text: '', spoken: '', until: -Infinity }
}

/**
 * Steps `cue` to the ship's last edge crossing (ShipRanges.edgeCrossing) at
 * `now`: a new one shows its text for SYSTEM_CUE_MS. True when it fires.
 */
export function stepSystemCue(
  cue: SystemCue,
  crossing: { parent: string | null; entering: boolean; count: number },
  now: number
): boolean {
  if (crossing.count === cue.seen) return false
  cue.seen = crossing.count
  if (crossing.parent == null) return false
  cue.text = systemEdgeCue(crossing.parent, crossing.entering)
  cue.spoken = systemEdgeAnnouncement(crossing.parent, crossing.entering)
  cue.until = now + SYSTEM_CUE_MS
  return true
}

/** Whether the cue is showing at `now`. */
export function systemCueShowing(cue: SystemCue, now: number): boolean {
  return now < cue.until
}
