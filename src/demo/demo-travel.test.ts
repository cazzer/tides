import { describe, expect, it } from 'vitest'
import { TRAVEL_MAX_SECONDS, travelRun, travelTimestamp } from './demo-travel'

const DAY = 86_400_000
const from = Date.parse('2026-03-20T14:46:00Z')

describe('travelRun', () => {
  it('cuts where there is no journey to make', () => {
    expect(travelRun(undefined, from, from + DAY, false)).toBeNull()
    expect(travelRun({ seconds: 4 }, from, from + DAY, true)).toBeNull()
    expect(travelRun({ seconds: 4 }, null, from + DAY, false)).toBeNull()
    expect(travelRun({ seconds: 4 }, from, from, false)).toBeNull()
    expect(travelRun({ seconds: 0 }, from, from + DAY, false)).toBeNull()
    expect(travelRun({ seconds: -1 }, from, from + DAY, false)).toBeNull()
    expect(travelRun({ rate: 0 }, from, from + DAY, false)).toBeNull()
  })

  it('cuts a rate travel that would outlast the cap', () => {
    const rate = DAY / 1000 / (TRAVEL_MAX_SECONDS + 1)
    expect(travelRun({ rate }, from, from + DAY, false)).toBeNull()
    expect(travelRun({ rate: DAY / 1000 / TRAVEL_MAX_SECONDS }, from, from + DAY, false)?.seconds).toBeCloseTo(
      TRAVEL_MAX_SECONDS
    )
  })

  it('times a rate travel by the gap, either way', () => {
    // An hour a second over a day: 24 s, over the cap; 6 hours a second: 4 s.
    const rate = 6 * 3600
    expect(travelRun({ rate }, from, from + DAY, false)).toMatchObject({ seconds: 4, easing: 'linear' })
    expect(travelRun({ rate }, from + DAY, from, false)).toMatchObject({ seconds: 4, from: from + DAY, to: from })
  })

  it('eases a timed travel and takes its holds', () => {
    expect(travelRun({ seconds: 3, hold: ['spin', 'moon'] }, from, from + 90 * DAY, false)).toEqual({
      from,
      to: from + 90 * DAY,
      seconds: 3,
      easing: 'smooth',
      holdSpin: true,
      hideMoon: true,
    })
    expect(travelRun({ seconds: 3 }, from, from + DAY, false)).toMatchObject({ holdSpin: false, hideMoon: false })
  })
})

describe('travelTimestamp', () => {
  const smooth = travelRun({ seconds: 4 }, from, from + 90 * DAY, false)!
  const linear = travelRun({ rate: 6 * 3600 }, from, from + DAY, false)!

  it.each([
    ['smooth', smooth],
    ['linear', linear],
  ] as const)('%s runs from the start to exactly the end, never turning back', (_, run) => {
    expect(travelTimestamp(run, 0)).toBe(run.from)
    expect(travelTimestamp(run, run.seconds)).toBe(run.to)
    expect(travelTimestamp(run, run.seconds + 5)).toBe(run.to)
    let last = -Infinity
    for (let e = 0; e <= run.seconds; e += run.seconds / 50) {
      const t = travelTimestamp(run, e)
      expect(t).toBeGreaterThanOrEqual(last)
      last = t
    }
  })

  it('runs backward as well', () => {
    const back = travelRun({ seconds: 4 }, from + 90 * DAY, from, false)!
    expect(travelTimestamp(back, 0)).toBe(from + 90 * DAY)
    expect(travelTimestamp(back, 2)).toBeCloseTo(from + 45 * DAY)
    expect(travelTimestamp(back, 3)).toBeLessThan(travelTimestamp(back, 1))
    expect(travelTimestamp(back, 4)).toBe(from)
  })

  it('is halfway at the middle of a smooth travel, and slow at its ends', () => {
    expect(travelTimestamp(smooth, 2)).toBeCloseTo(from + 45 * DAY)
    expect(travelTimestamp(smooth, 0.4) - from).toBeLessThan(0.1 * 90 * DAY)
  })

  it('keeps a constant rate on a linear travel', () => {
    for (const e of [0.5, 1, 2.5, 3.9]) {
      expect(travelTimestamp(linear, e) - from).toBeCloseTo(e * 6 * 3600 * 1000)
    }
  })
})
