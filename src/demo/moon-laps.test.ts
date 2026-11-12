import { describe, expect, it } from 'vitest'
import { DEMO_FLIGHT_SECONDS } from './demo-flight'
import { MIN_LAP_FRAMES, lapSeconds, stopLapSeconds } from './moon-laps'

describe('lapSeconds', () => {
  it('is the period in real seconds at the clock’s speed', () => {
    // A day at an hour a second: 24 s.
    expect(lapSeconds(1, 3600)).toBe(24)
    // Io (1.77 days) at eight hours a second.
    expect(lapSeconds(1.769138, 28_800)).toBeCloseTo(5.307, 3)
    // Real time: the period itself.
    expect(lapSeconds(2, 1)).toBe(172_800)
  })

  it('halves as the clock doubles', () => {
    expect(lapSeconds(7.154553, 57_600)).toBeCloseTo(lapSeconds(7.154553, 28_800) / 2, 12)
  })
})

describe('stopLapSeconds', () => {
  it('is the stop’s real length less the flight in', () => {
    const from = Date.parse('2027-09-05T00:00:00Z')
    // Three days at three hours a second: 24 s.
    expect(stopLapSeconds(from, from + 3 * 86_400_000, 10_800)).toBe(24 - DEMO_FLIGHT_SECONDS)
  })
})

describe('MIN_LAP_FRAMES', () => {
  it('keeps a lap to at most 12° a frame', () => {
    expect(360 / MIN_LAP_FRAMES).toBeLessThanOrEqual(12)
  })
})
