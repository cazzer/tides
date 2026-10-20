import { DateTime } from 'luxon'

export type DayCell = { year: number; month: number; day: number; inMonth: boolean }

export const GRID_DAYS = 42

/** Six Sunday-first weeks covering the month (1-12), padded from its neighbors. */
export function monthGrid(year: number, month: number): DayCell[] {
  const first = DateTime.utc(year, month, 1)
  const start = first.minus({ days: first.weekday % 7 })
  return Array.from({ length: GRID_DAYS }, (_, i) => {
    const d = start.plus({ days: i })
    return { year: d.year, month: d.month, day: d.day, inMonth: d.month === month }
  })
}
