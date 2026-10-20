import { DateTime } from 'luxon'

/**
 * A masked `MM/DD/YYYY HH:MM` (local, 24-hour) field modeled as up to 12
 * digits. Typing at the end appends, padding a digit that can't start its
 * segment ("4" in the day becomes "04") and adding the next separator as soon
 * as a segment fills. Typing mid-string overwrites in place so the other
 * segments never shift; backspace mid-string only walks the caret back.
 */
export const MASK = 'MM/DD/YYYY HH:MM'
export const MAX_DIGITS = 12

export type Masked = { value: string; caret: number }
export type Edit =
  | { kind: 'insert'; text: string }
  | { kind: 'deleteBackward' }
  | { kind: 'deleteForward' }

type SegmentKind = 'month' | 'day' | 'year' | 'hour' | 'minute'
const SEGMENTS: { kind: SegmentKind; start: number; length: number }[] = [
  { kind: 'month', start: 0, length: 2 },
  { kind: 'day', start: 2, length: 2 },
  { kind: 'year', start: 4, length: 4 },
  { kind: 'hour', start: 8, length: 2 },
  { kind: 'minute', start: 10, length: 2 },
]
/** Digit counts after which a separator follows, and the separator itself. */
const BOUNDARIES: [number, string][] = [
  [2, '/'],
  [4, '/'],
  [8, ' '],
  [10, ':'],
]
const SEPARATOR = /[/\-.:\s,T]/
/** Highest first digit each two-digit segment can start with. */
const MAX_FIRST: Record<SegmentKind, string> = {
  month: '1',
  day: '3',
  year: '9',
  hour: '2',
  minute: '5',
}

const digitsOf = (text: string) => text.replace(/\D/g, '')

const segmentAt = (k: number) =>
  SEGMENTS.find((s) => k >= s.start && k < s.start + s.length) ??
  SEGMENTS[SEGMENTS.length - 1]

/** Whether the two digits make a possible month, day, hour or minute. */
function validPair(kind: SegmentKind, first: string, second: string): boolean {
  const n = Number(first + second)
  switch (kind) {
    case 'month':
      return n >= 1 && n <= 12
    case 'day':
      return n >= 1 && n <= 31
    case 'hour':
      return n <= 23
    default:
      return true
  }
}

/** Formats digits, with the next separator added once a segment fills. */
export function formatDigits(digits: string): string {
  let out = ''
  for (let k = 0; k < Math.min(digits.length, MAX_DIGITS); k++) {
    out += digits[k]
    const boundary = BOUNDARIES.find(([at]) => at === k + 1)
    if (boundary) out += boundary[1]
  }
  return out
}

/** Caret position just after the nth digit (past any separator that follows). */
function caretAfter(n: number): number {
  return n + BOUNDARIES.filter(([at]) => at <= n).length
}

/** Digits before a caret position in a formatted value. */
const digitIndex = (value: string, pos: number) =>
  digitsOf(value.slice(0, pos)).length

function result(digits: string, k: number): Masked {
  const value = formatDigits(digits)
  return { value, caret: Math.min(caretAfter(k), value.length) }
}

/** Writes slot k, appending when k is just past the end. */
const put = (digits: string, k: number, ch: string) =>
  digits.slice(0, k) + ch + digits.slice(k + 1)

function insertChar(digits: string, k: number, ch: string): [string, number] {
  if (k >= MAX_DIGITS) return [digits, k]
  const seg = segmentAt(k)
  const pos = k - seg.start
  const twoDigit = seg.length === 2

  if (/\d/.test(ch)) {
    if (twoDigit && pos === 0 && ch > MAX_FIRST[seg.kind]) {
      return [put(put(digits, k, '0'), k + 1, ch), k + 2]
    }
    if (twoDigit && pos === 1 && !validPair(seg.kind, digits[k - 1], ch)) {
      return [digits, k]
    }
    return [put(digits, k, ch), k + 1]
  }
  // A separator after one digit closes the segment: "1/" means "01/".
  if (SEPARATOR.test(ch) && twoDigit && pos === 1) {
    const first = digits[k - 1]
    if (first === '0') return [digits, k]
    return [put(put(digits, seg.start, '0'), seg.start + 1, first), k + 1]
  }
  return [digits, k]
}

/** Applies one cancelled input event to the masked value. */
export function applyEdit(
  value: string,
  selStart: number,
  selEnd: number,
  edit: Edit
): Masked {
  const digits = digitsOf(value)
  const kStart = digitIndex(value, selStart)
  const kEnd = digitIndex(value, selEnd)
  const hasSelection = selEnd > selStart
  // A selection or caret reaching the last digit truncates; anywhere else the
  // slots stay put.
  const reachesEnd = kEnd >= digits.length

  if (edit.kind === 'insert') {
    let next = reachesEnd ? digits.slice(0, kStart) : digits
    let k = kStart
    for (const ch of edit.text) [next, k] = insertChar(next, k, ch)
    return result(next, k)
  }

  if (hasSelection) {
    return reachesEnd ? result(digits.slice(0, kStart), kStart) : result(digits, kStart)
  }

  if (edit.kind === 'deleteBackward') {
    if (kStart === 0) return result(digits, 0)
    if (kStart >= digits.length) return result(digits.slice(0, -1), kStart - 1)
    return result(digits, kStart - 1)
  }

  if (kStart >= digits.length) return result(digits, kStart)
  if (kStart === digits.length - 1) return result(digits.slice(0, -1), kStart)
  return result(digits, kStart + 1)
}

/** Fallback for edits that couldn't be cancelled: keep digits, keep the caret's digit index. */
export function normalize(raw: string, rawCaret: number): Masked {
  const digits = digitsOf(raw).slice(0, MAX_DIGITS)
  return result(digits, Math.min(digitIndex(raw, rawCaret), digits.length))
}

const ISO_DATE = /^\s*[+-]?\d{4,6}-\d{2}-\d{2}/

/**
 * Pastes text: an ISO date (or SQL-style, with a space before the time)
 * replaces the whole value, anything else is typed in.
 */
export function pasteText(
  value: string,
  selStart: number,
  selEnd: number,
  text: string,
  zone?: string
): Masked {
  if (ISO_DATE.test(text)) {
    const iso = text.trim().replace(/^([+-]?\d+-\d{2}-\d{2})\s+/, '$1T')
    const dt = DateTime.fromISO(iso, { zone })
    // Typed in, an ISO date's digits would land in the wrong fields.
    if (!dt.isValid || dt.year < 0 || dt.year > 9999) return { value, caret: selEnd }
    const digits = dt.toFormat(iso.includes('T') ? 'MMddyyyyHHmm' : 'MMddyyyy')
    return result(digits, digits.length)
  }
  return applyEdit(value, selStart, selEnd, { kind: 'insert', text })
}

export const isComplete = (value: string) => digitsOf(value).length === MAX_DIGITS

export type Parsed =
  | { ok: true; dt: DateTime; kind?: never; reason?: never }
  | { ok: false; kind: 'incomplete' | 'impossible'; reason: string; dt?: never }

/**
 * Parses a masked value. A date alone, or a date and hour, takes the missing
 * fields from `fallback`, which also supplies the zone.
 */
export function parseMasked(value: string, fallback: DateTime): Parsed {
  const digits = digitsOf(value)
  if (digits.length < 8) return { ok: false, kind: 'incomplete', reason: 'Finish the date' }
  if (digits.length === 9 || digits.length === 11) {
    return { ok: false, kind: 'incomplete', reason: 'Finish the time' }
  }
  const field = (start: number, length: number) =>
    Number(digits.slice(start, start + length))
  const dt = DateTime.fromObject(
    {
      month: field(0, 2),
      day: field(2, 2),
      year: field(4, 4),
      hour: digits.length >= 10 ? field(8, 2) : fallback.hour,
      minute: digits.length >= 12 ? field(10, 2) : fallback.minute,
    },
    { zone: fallback.zone }
  )
  if (!dt.isValid) {
    const time = dt.invalidExplanation?.match(/hour|minute/)
    return { ok: false, kind: 'impossible', reason: time ? 'No such time' : 'No such date' }
  }
  return { ok: true, dt }
}

export function formatMasked(ms: number, zone?: string): string {
  return DateTime.fromMillis(ms, { zone }).toFormat('MM/dd/yyyy HH:mm')
}
