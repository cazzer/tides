import { describe, expect, test } from 'vitest'
import { GRID_DAYS, monthGrid } from './month-grid'

describe('monthGrid', () => {
  test('a month starting on Sunday has no leading days', () => {
    const cells = monthGrid(2026, 2)
    expect(cells[0]).toEqual({ year: 2026, month: 2, day: 1, inMonth: true })
    expect(cells.filter((c) => c.inMonth)).toHaveLength(28)
  })

  test('leading days come from the previous month', () => {
    const cells = monthGrid(2026, 10)
    expect(cells.slice(0, 4).map((c) => [c.month, c.day, c.inMonth])).toEqual([
      [9, 27, false],
      [9, 28, false],
      [9, 29, false],
      [9, 30, false],
    ])
    expect(cells[4]).toEqual({ year: 2026, month: 10, day: 1, inMonth: true })
  })

  test('always six weeks, rolling over the year', () => {
    const cells = monthGrid(2026, 12)
    expect(cells).toHaveLength(GRID_DAYS)
    expect(cells[GRID_DAYS - 1]).toEqual({ year: 2027, month: 1, day: 9, inMonth: false })
    expect(monthGrid(2027, 1)[0]).toEqual({ year: 2026, month: 12, day: 27, inMonth: false })
  })
})
