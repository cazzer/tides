// Lunar-phase and zodiac rings around the month ring (tides-28u). Both place
// a date at Earth's scene angle on that date, like the months, so the glyphs
// and signs line up against the calendar.
import { SearchMoonQuarter, type MoonQuarter } from 'astronomy-engine'
import { earthAngle } from './ephemeris'

const DAY_MS = 24 * 60 * 60 * 1000

// Between the clock (ends ~37.5) and Earth's orbit (50).
export const LUNAR_RADIUS = 44
export const GLYPH_RADIUS = 1.2
// Outside the Moon's band around Earth's orbit (40–60).
export const ZODIAC_INNER = 62.5
export const ZODIAC_TICK_OUTER = 66
export const ZODIAC_TEXT_RADIUS = 63.5
export const ZODIAC_SCALE = 2.2

// A year wraps the ring once, so events half a year either side of now meet
// on the far side; stopping short of 182.6 days keeps the two from stacking.
export const LUNAR_WINDOW_MS = 178 * DAY_MS
const LUNAR_FADE_MS = 6 * DAY_MS
// The cache holds a little more than the window, so small steps back and
// forth near its edges don't search again.
const CACHE_MARGIN_MS = 200 * DAY_MS
// Past this, extending one quarter at a time costs more than starting over.
const CACHE_REBUILD_MS = 400 * DAY_MS
// Quarters fall 6.5–8.3 days apart, so a search from 9 days before one
// finds exactly the quarter before it; from 6 days after, the one after.
const PREVIOUS_SEARCH_MS = 9 * DAY_MS
const NEXT_SEARCH_MS = 6 * DAY_MS

export const ZODIAC_SIGNS = [
  'Aries',
  'Taurus',
  'Gemini',
  'Cancer',
  'Leo',
  'Virgo',
  'Libra',
  'Scorpio',
  'Sagittarius',
  'Capricorn',
  'Aquarius',
  'Pisces',
] as const

export const SIGN_ANGLE = Math.PI / 6

/** 0 (new), 1 (first quarter), 2 (full) or 3 (last quarter). */
export type MoonQuarterIndex = 0 | 1 | 2 | 3

export interface LunarEvent {
  quarter: MoonQuarterIndex
  /** Epoch ms. */
  t: number
  /** Earth's scene angle at t. */
  angle: number
}

/**
 * The tropical sign at a scene angle. Earth's scene angle is the Sun's
 * geocentric longitude (ephemeris.ts), so the segment beside Earth is the
 * sign the Sun is "in", the calendar convention the months follow. The
 * constellation of that name lies 180° across the scene, behind the Sun as
 * seen from Earth.
 */
export function zodiacSignIndex(angle: number): number {
  const turn = 2 * Math.PI
  const a = ((angle % turn) + turn) % turn
  // Rounding can land a hair under a full turn on 12.
  return Math.min(11, Math.floor(a / SIGN_ANGLE))
}

function toEvent(mq: MoonQuarter): LunarEvent {
  const t = mq.time.date.getTime()
  return { quarter: mq.quarter as MoonQuarterIndex, t, angle: earthAngle(t) }
}

function quarterAfter(t: number): LunarEvent {
  return toEvent(SearchMoonQuarter(new Date(t)))
}

/** Quarters with startMs < t <= endMs, in time order. */
export function moonQuartersBetween(
  startMs: number,
  endMs: number
): LunarEvent[] {
  const events: LunarEvent[] = []
  for (
    let event = quarterAfter(startMs);
    event.t <= endMs;
    event = quarterAfter(event.t + NEXT_SEARCH_MS)
  ) {
    events.push(event)
  }
  return events
}

function smoothstep(x: number, edge0: number, edge1: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** Glyph opacity for an event dtMs from now: fades out at the far-side seam. */
export function glyphOpacity(dtMs: number): number {
  return smoothstep(LUNAR_WINDOW_MS - Math.abs(dtMs), 0, LUNAR_FADE_MS)
}

/**
 * Moon quarters within ±200 days of the last update, kept in time order.
 * Following the clock it only searches for quarters entering the range, so
 * most frames do no work; a date jump of over 400 days starts over.
 */
export class QuarterCache {
  readonly events: LunarEvent[] = []
  // The quarters just outside each end of `events`, so the next ones to enter.
  private before: LunarEvent | null = null
  private after: LunarEvent | null = null
  private lastNow = Number.NaN

  update(now: number): void {
    const start = now - CACHE_MARGIN_MS
    const end = now + CACHE_MARGIN_MS
    const events = this.events
    if (!(Math.abs(now - this.lastNow) <= CACHE_REBUILD_MS)) {
      events.length = 0
      events.push(...moonQuartersBetween(start, end))
      this.before = quarterAfter(events[0].t - PREVIOUS_SEARCH_MS)
      this.after = quarterAfter(events[events.length - 1].t + NEXT_SEARCH_MS)
    }
    this.lastNow = now

    let before = this.before!
    let after = this.after!
    while (after.t <= end) {
      events.push(after)
      after = quarterAfter(after.t + NEXT_SEARCH_MS)
    }
    // A long step back can empty the list here; the unshifts below refill it.
    while (events.length > 0 && events[events.length - 1].t > end) {
      after = events.pop()!
    }
    while (before.t > start) {
      events.unshift(before)
      before = quarterAfter(before.t - PREVIOUS_SEARCH_MS)
    }
    while (events.length > 0 && events[0].t <= start) before = events.shift()!
    this.before = before
    this.after = after
  }
}
