import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import {
  applyEdit,
  formatDigits,
  formatMasked,
  isComplete,
  normalize,
  parseMasked,
  pasteText,
  type Masked,
} from './datetime-mask'

/** Types text one key at a time with the caret at the end. */
function type(text: string, from: Masked = { value: '', caret: 0 }): Masked {
  let state = from
  for (const ch of text) {
    state = applyEdit(state.value, state.caret, state.caret, { kind: 'insert', text: ch })
  }
  return state
}

const backspace = (s: Masked) => applyEdit(s.value, s.caret, s.caret, { kind: 'deleteBackward' })
const del = (s: Masked) => applyEdit(s.value, s.caret, s.caret, { kind: 'deleteForward' })
const at = (value: string, caret: number): Masked => ({ value, caret })

describe('typing at the end', () => {
  test('adds each separator as its segment fills', () => {
    expect(type('10').value).toBe('10/')
    expect(type('1020').value).toBe('10/20/')
    expect(type('10202026').value).toBe('10/20/2026 ')
    expect(type('1020202614').value).toBe('10/20/2026 14:')
    expect(type('102020261430')).toEqual({ value: '10/20/2026 14:30', caret: 16 })
  })

  test('stops at twelve digits with no trailing separator', () => {
    const full = type('1020202614305')
    expect(full.value).toBe('10/20/2026 14:30')
    expect(isComplete(full.value)).toBe(true)
    expect(isComplete('10/20/2026 14:3')).toBe(false)
  })

  test('pads a digit that cannot start its segment', () => {
    expect(type('3').value).toBe('03/')
    expect(type('104').value).toBe('10/04/')
    expect(type('10202026' + '3').value).toBe('10/20/2026 03:')
    expect(type('1020202614' + '7')).toEqual({ value: '10/20/2026 14:07', caret: 16 })
  })

  test('rejects second digits that make an impossible field', () => {
    expect(type('13').value).toBe('1')
    expect(type('00').value).toBe('0')
    expect(type('1032').value).toBe('10/3')
    expect(type('1000').value).toBe('10/0')
    expect(type('10202026' + '24').value).toBe('10/20/2026 2')
  })

  test('a typed separator closes a one-digit segment', () => {
    expect(type('1/').value).toBe('01/')
    expect(type('1/5-').value).toBe('01/05/')
    expect(type('1/5/2026 9:').value).toBe('01/05/2026 09:')
  })

  test('separators are ignored at a segment start, inside the year, and after a lone 0', () => {
    expect(type('/').value).toBe('')
    expect(type('10//').value).toBe('10/')
    expect(type('1020 20/26').value).toBe('10/20/2026 ')
    expect(type('0/').value).toBe('0')
  })

  test('letters are ignored', () => {
    expect(type('1a0').value).toBe('10/')
  })
})

describe('deleting', () => {
  test('backspace at the end walks back over separators', () => {
    let s = type('1020')
    expect(s.value).toBe('10/20/')
    s = backspace(s)
    expect(s).toEqual({ value: '10/2', caret: 4 })
    s = backspace(s)
    expect(s).toEqual({ value: '10/', caret: 3 })
    s = backspace(s)
    expect(s).toEqual({ value: '1', caret: 1 })
    s = backspace(s)
    expect(s).toEqual({ value: '', caret: 0 })
    expect(backspace(s)).toEqual({ value: '', caret: 0 })
  })

  test('backspace mid-string moves the caret without shifting fields', () => {
    const full = '10/20/2026 14:30'
    expect(backspace(at(full, 4))).toEqual({ value: full, caret: 3 })
    // From just past a separator it lands before the separator's digit.
    expect(backspace(at(full, 3))).toEqual({ value: full, caret: 1 })
  })

  test('forward delete removes the last digit or steps over the rest', () => {
    expect(del(at('10/20/2026 14:30', 15))).toEqual({ value: '10/20/2026 14:3', caret: 15 })
    expect(del(at('10/20/2026 14:30', 0))).toEqual({ value: '10/20/2026 14:30', caret: 1 })
    expect(del(at('10/2', 4))).toEqual({ value: '10/2', caret: 4 })
  })

  test('deleting a selection that reaches the end truncates it', () => {
    const full = '10/20/2026 14:30'
    expect(applyEdit(full, 6, 16, { kind: 'deleteBackward' })).toEqual({
      value: '10/20/',
      caret: 6,
    })
    expect(applyEdit(full, 0, 16, { kind: 'deleteBackward' })).toEqual({ value: '', caret: 0 })
  })
})

describe('typing mid-string', () => {
  const full = '10/20/2026 14:30'

  test('overwrites in place and skips separators', () => {
    let s = type('1999', at(full, 6))
    expect(s).toEqual({ value: '10/20/1999 14:30', caret: 11 })
    s = type('0', at(full, 1))
    expect(s).toEqual({ value: '10/20/2026 14:30', caret: 3 })
  })

  test('pads and jumps a segment when the digit cannot start it', () => {
    expect(type('5', at(full, 3))).toEqual({ value: '10/05/2026 14:30', caret: 6 })
  })

  test('a selected segment is overwritten from its start', () => {
    const s = applyEdit(full, 6, 10, { kind: 'insert', text: '1' })
    expect(s).toEqual({ value: '10/20/1026 14:30', caret: 7 })
  })

  test('a selection reaching the end is replaced', () => {
    expect(applyEdit(full, 0, 16, { kind: 'insert', text: '4' })).toEqual({
      value: '04/',
      caret: 3,
    })
  })
})

describe('pasteText', () => {
  test('digits and separated text type in', () => {
    expect(pasteText('', 0, 0, '102020261430').value).toBe('10/20/2026 14:30')
    expect(pasteText('', 0, 0, '3/7/2026 9:05').value).toBe('03/07/2026 09:05')
  })

  test('an ISO date replaces the whole value in the given zone', () => {
    expect(pasteText('01/01/2000 00:00', 3, 3, '2026-10-20T14:30', 'UTC')).toEqual({
      value: '10/20/2026 14:30',
      caret: 16,
    })
    expect(pasteText('', 0, 0, '2026-10-20T14:30:00Z', 'America/New_York').value).toBe(
      '10/20/2026 10:30'
    )
    expect(pasteText('', 0, 0, '2026-10-20', 'UTC').value).toBe('10/20/2026 ')
  })

  test('a space before the time works like T', () => {
    expect(pasteText('', 0, 0, '2026-10-20 14:30', 'UTC').value).toBe('10/20/2026 14:30')
  })

  test('an ISO-looking date that does not parse, or has no four-digit year, changes nothing', () => {
    expect(pasteText('10/', 3, 3, '2026-13-45', 'UTC')).toEqual({ value: '10/', caret: 3 })
    expect(pasteText('10/', 3, 3, '+002026-10-20', 'UTC').value).toBe('10/20/2026 ')
    expect(pasteText('10/', 3, 3, '+012026-10-20', 'UTC')).toEqual({ value: '10/', caret: 3 })
  })

  test('garbage leaves the value alone', () => {
    expect(pasteText('10/', 3, 3, 'hello')).toEqual({ value: '10/', caret: 3 })
  })
})

describe('normalize', () => {
  test('reformats raw text and keeps the caret by digit index', () => {
    expect(normalize('10/209/2026', 6)).toEqual({ value: '10/20/9202 6', caret: 7 })
    expect(normalize('1020', 4)).toEqual({ value: '10/20/', caret: 6 })
  })
})

describe('parseMasked', () => {
  const fallback = DateTime.fromObject({ year: 2026, month: 1, day: 1, hour: 9, minute: 45 }, { zone: 'UTC' })

  test('parses a full value in the fallback zone', () => {
    const p = parseMasked('10/20/2026 14:30', fallback)
    expect(p.ok && p.dt.toISO()).toBe('2026-10-20T14:30:00.000Z')
  })

  test('a date alone or a date and hour take the rest from the fallback', () => {
    const date = parseMasked('10/20/2026 ', fallback)
    expect(date.ok && date.dt.toISO()).toBe('2026-10-20T09:45:00.000Z')
    const hour = parseMasked('10/20/2026 14:', fallback)
    expect(hour.ok && hour.dt.toISO()).toBe('2026-10-20T14:45:00.000Z')
  })

  test('half-typed fields are errors', () => {
    expect(parseMasked('10/20/202', fallback)).toEqual({ ok: false, kind: 'incomplete', reason: 'Finish the date' })
    expect(parseMasked('10/20/2026 1', fallback)).toEqual({ ok: false, kind: 'incomplete', reason: 'Finish the time' })
    expect(parseMasked('10/20/2026 14:3', fallback)).toEqual({ ok: false, kind: 'incomplete', reason: 'Finish the time' })
  })

  test('days that do not exist are errors', () => {
    expect(parseMasked('02/30/2026 00:00', fallback)).toEqual({ ok: false, kind: 'impossible', reason: 'No such date' })
    expect(parseMasked('02/29/2026 00:00', fallback).ok).toBe(false)
    expect(parseMasked('02/29/2028 00:00', fallback).ok).toBe(true)
  })

  test('times that do not exist are errors', () => {
    expect(parseMasked('10/20/2026 29:00', fallback)).toEqual({ ok: false, kind: 'impossible', reason: 'No such time' })
  })

  test('a time in a DST gap shifts forward', () => {
    const ny = fallback.setZone('America/New_York')
    const p = parseMasked('03/08/2026 02:30', ny)
    expect(p.ok && p.dt.toFormat('HH:mm')).toBe('03:30')
  })

  test('round-trips formatMasked', () => {
    const ms = Date.UTC(1999, 11, 31, 23, 59)
    const p = parseMasked(formatMasked(ms, 'UTC'), fallback)
    expect(p.ok && p.dt.toMillis()).toBe(ms)
  })
})

test('formatDigits caps at twelve digits', () => {
  expect(formatDigits('1020202614309999')).toBe('10/20/2026 14:30')
})
