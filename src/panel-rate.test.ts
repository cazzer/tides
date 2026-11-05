import { describe, expect, it } from 'vitest'
import {
  createPanelSchedule,
  PANEL_FULL_RATE_SPEED,
  PANEL_INPUT_MS,
  panelDrawDue,
  panelPeriodMs,
  panelsPaced,
  parsePanelRate,
  type PanelRateInput,
} from './panel-rate'

const AUTO = parsePanelRate('')
const still: PanelRateInput = { timeScale: 1, jumping: false, demo: false, interactingAt: null, now: 10_000 }

describe('parsePanelRate', () => {
  it('is auto at 15 Hz by default and for unreadable values', () => {
    for (const search of ['', '?panelhz=auto', '?panelhz=7', '?panelhz=abc', '?panelhz=']) {
      expect(parsePanelRate(search)).toEqual({ mode: 'auto', hz: 15 })
    }
  })
  it('takes the fixed rates', () => {
    for (const hz of [60, 30, 20, 15]) expect(parsePanelRate(`?panelhz=${hz}`)).toEqual({ mode: 'fixed', hz })
  })
  it('paces at all only below 60', () => {
    expect(panelsPaced(parsePanelRate('?panelhz=60'))).toBe(false)
    expect(panelsPaced(parsePanelRate('?panelhz=30'))).toBe(true)
    expect(panelsPaced(AUTO)).toBe(true)
  })
})

describe('panelPeriodMs', () => {
  it('is 15 Hz at real time and paused', () => {
    expect(panelPeriodMs(still, AUTO)).toBeCloseTo(1000 / 15)
    expect(panelPeriodMs({ ...still, timeScale: 0 }, AUTO)).toBeCloseTo(1000 / 15)
  })
  it('goes to the full rate from x3600 up, either way', () => {
    expect(panelPeriodMs({ ...still, timeScale: PANEL_FULL_RATE_SPEED - 1 }, AUTO)).toBeGreaterThan(0)
    for (const timeScale of [3600, 86400, 2592000, -3600]) {
      expect(panelPeriodMs({ ...still, timeScale }, AUTO)).toBe(0)
    }
  })
  it('goes to the full rate while a jump eases or a demo runs', () => {
    expect(panelPeriodMs({ ...still, jumping: true }, AUTO)).toBe(0)
    expect(panelPeriodMs({ ...still, demo: true }, AUTO)).toBe(0)
  })
  it('goes to the full rate for 500 ms after an input', () => {
    expect(panelPeriodMs({ ...still, interactingAt: still.now }, AUTO)).toBe(0)
    expect(panelPeriodMs({ ...still, interactingAt: still.now - PANEL_INPUT_MS + 1 }, AUTO)).toBe(0)
    expect(panelPeriodMs({ ...still, interactingAt: still.now - PANEL_INPUT_MS }, AUTO)).toBeGreaterThan(0)
  })
  it('holds a fixed rate whatever the speed', () => {
    const fixed15 = parsePanelRate('?panelhz=15')
    expect(panelPeriodMs({ ...still, timeScale: 86400, interactingAt: still.now }, fixed15)).toBeCloseTo(1000 / 15)
    expect(panelPeriodMs({ ...still, timeScale: 86400 }, parsePanelRate('?panelhz=20'))).toBe(50)
    expect(panelPeriodMs(still, parsePanelRate('?panelhz=60'))).toBe(0)
  })
})

/** Runs two panels over `seconds` at `hz` with jittered frame times; returns the draws per frame. */
function run(hz: number, seconds: number, periodMs: number, ids = ['top', 'bottom'], forcedOn = new Set<number>()) {
  const schedule = createPanelSchedule()
  const frames: string[][] = []
  const counts = new Map(ids.map((id) => [id, 0]))
  let t = 0
  for (let i = 0; i < hz * seconds; i++) {
    t += (1000 / hz) * (1 + 0.04 * Math.sin(i * 1.7))
    const drew = ids.filter((id) => panelDrawDue(schedule, id, t / 1000, periodMs, forcedOn.has(i)))
    for (const id of drew) counts.set(id, counts.get(id)! + 1)
    frames.push(drew)
  }
  return { frames, counts }
}

describe('panelDrawDue', () => {
  const period = 1000 / 15
  for (const hz of [60, 120]) {
    it(`draws each panel about 15 times a second at ${hz} Hz`, () => {
      const { counts } = run(hz, 10, period)
      for (const n of counts.values()) expect(n / 10).toBeGreaterThanOrEqual(14.5)
      for (const n of counts.values()) expect(n / 10).toBeLessThanOrEqual(15.5)
    })
    it(`never draws both panels in one frame at ${hz} Hz`, () => {
      const { frames } = run(hz, 10, period)
      expect(frames.slice(1).every((drew) => drew.length <= 1)).toBe(true)
    })
  }
  it('draws both on the first frame (nothing held yet)', () => {
    expect(run(60, 1, period).frames[0]).toEqual(['top', 'bottom'])
  })
  it('draws both every frame at the full rate', () => {
    const { frames } = run(60, 1, 0)
    expect(frames.every((drew) => drew.length === 2)).toBe(true)
  })
  it('draws a forced panel at once, alongside the other', () => {
    const forced = new Set([30, 31, 32, 33])
    const { frames } = run(60, 2, period, ['top', 'bottom'], forced)
    for (const i of forced) expect(frames[i]).toEqual(['top', 'bottom'])
    // and the stagger resumes afterwards
    expect(frames.slice(34).every((drew) => drew.length <= 1)).toBe(true)
  })
  it('keeps a panel held after a gap in frames when it has just drawn', () => {
    const schedule = createPanelSchedule()
    panelDrawDue(schedule, 'a', 1, period, false)
    expect(panelDrawDue(schedule, 'a', 100, period, true)).toBe(true)
    expect(panelDrawDue(schedule, 'a', 100, period, false)).toBe(false)
    expect(panelDrawDue(schedule, 'a', 100 + 1 / 60, period, false)).toBe(false)
  })
  it('calls the same frame time one frame', () => {
    const schedule = createPanelSchedule()
    expect(panelDrawDue(schedule, 'a', 1, period, false)).toBe(true)
    expect(panelDrawDue(schedule, 'a', 1, period, false)).toBe(false)
  })
})
