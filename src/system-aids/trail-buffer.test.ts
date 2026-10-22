import { describe, expect, it } from 'vitest'
import {
  COLORS_CHANGED,
  SEGMENTS_CHANGED,
  TRAIL_ARC_DEGREES,
  TRAIL_OPACITY,
  TRAIL_SAMPLES,
  TRAIL_SLOTS,
  createTrailBuffer,
  sampleStep,
  trailFade,
  updateTrails,
  type TrailBuffer,
  type TrailPositionAt,
} from './trail-buffer'

const DAY = 86_400_000
const RED = [1, 0, 0] as const
const BLUE = [0, 0, 1] as const
// A fast inner body and a slow outer one, on circles in the XZ plane.
const PERIODS = [88, 365]
const RADII = [20, 50]
const T0 = Date.parse('2026-10-22T12:00:00Z')

function angle(body: number, t: number): number {
  return (2 * Math.PI * t) / (PERIODS[body] * DAY)
}

// Counts calls, as the ephemeris costs.
function circles() {
  const calls = [0, 0]
  const positionAt: TrailPositionAt = (body, t) => {
    calls[body]++
    const a = angle(body, t)
    return [RADII[body] * Math.cos(a), 0, -RADII[body] * Math.sin(a)]
  }
  return { calls, positionAt }
}

function trail(t: number) {
  const { calls, positionAt } = circles()
  const buffer = createTrailBuffer(PERIODS, [RED, BLUE])
  updateTrails(buffer, t, positionAt)
  return { buffer, calls, positionAt }
}

function endpoint(buffer: TrailBuffer, body: number, i: number, end: 0 | 1): number[] {
  const o = (body * TRAIL_SAMPLES + i) * 6 + end * 3
  return Array.from(buffer.segments.subarray(o, o + 3))
}

function brightness(buffer: TrailBuffer, body: number, i: number, end: 0 | 1): number {
  const o = (body * TRAIL_SAMPLES + i) * 6 + end * 3
  return Math.max(...buffer.colors.subarray(o, o + 3))
}

// Angle of a scene point on the test circles, unwrapped near `near`.
function angleOf([x, , z]: number[], near: number): number {
  const a = Math.atan2(-z, x)
  return a + 2 * Math.PI * Math.round((near - a) / (2 * Math.PI))
}

describe('sampleStep', () => {
  it('splits the trail arc of an orbit into TRAIL_SAMPLES steps', () => {
    expect(sampleStep(360) * TRAIL_SAMPLES).toBeCloseTo(TRAIL_ARC_DEGREES * DAY, 3)
  })
})

describe('trailFade', () => {
  it('is 1 at the planet and 0 from the tail on', () => {
    expect(trailFade(0)).toBe(1)
    expect(trailFade(0.25)).toBe(0.75)
    expect(trailFade(1)).toBe(0)
    expect(trailFade(2)).toBe(0)
  })
})

describe('the trail ring buffer', () => {
  it('fills a whole trail of ephemeris samples on the first update', () => {
    const { buffer, calls } = trail(T0)
    expect(calls).toEqual([TRAIL_SLOTS, TRAIL_SLOTS])
    expect(buffer.segments).toHaveLength(2 * TRAIL_SAMPLES * 6)
  })

  it('joins its samples into one unbroken line', () => {
    const { buffer } = trail(T0)
    for (let b = 0; b < 2; b++) {
      for (let i = 0; i + 1 < TRAIL_SAMPLES; i++) {
        expect(endpoint(buffer, b, i, 1)).toEqual(endpoint(buffer, b, i + 1, 0))
      }
    }
  })

  it('runs TRAIL_ARC_DEGREES back along the orbit from the body', () => {
    const { buffer } = trail(T0)
    for (let b = 0; b < 2; b++) {
      const now = angle(b, T0)
      const head = angleOf(endpoint(buffer, b, 0, 0), now)
      const tail = angleOf(endpoint(buffer, b, TRAIL_SAMPLES - 1, 1), now)
      const step = (TRAIL_ARC_DEGREES / TRAIL_SAMPLES) * (Math.PI / 180)
      // Behind the body (it moves to larger angles) by under one step...
      expect(now - head).toBeGreaterThanOrEqual(0)
      expect(now - head).toBeLessThan(step + 1e-9)
      // ...and the tail one trail arc further back.
      expect(((head - tail) * 180) / Math.PI).toBeCloseTo(TRAIL_ARC_DEGREES, 4)
    }
  })

  it('is brightest at the body and fades to nothing at the tail', () => {
    const { buffer } = trail(T0)
    expect(brightness(buffer, 0, 0, 0)).toBeGreaterThan(TRAIL_OPACITY * 0.98)
    expect(brightness(buffer, 0, 0, 0)).toBeLessThanOrEqual(TRAIL_OPACITY)
    expect(brightness(buffer, 1, TRAIL_SAMPLES - 1, 1)).toBe(0)
    let previous = Infinity
    for (let i = 0; i < TRAIL_SAMPLES; i++) {
      const b = brightness(buffer, 1, i, 0)
      expect(b).toBeLessThan(previous)
      expect(brightness(buffer, 1, i, 1)).toBeLessThan(b)
      previous = b
    }
    // In the body's own colour.
    const o = (1 * TRAIL_SAMPLES) * 6
    expect(buffer.colors[o]).toBe(0)
    expect(buffer.colors[o + 2]).toBeGreaterThan(0)
  })

  it('stays put and lit while the clock is paused', () => {
    const { buffer, calls, positionAt } = trail(T0)
    const segments = buffer.segments.slice()
    const colors = buffer.colors.slice()
    expect(updateTrails(buffer, T0, positionAt)).toBe(0)
    expect(calls).toEqual([TRAIL_SLOTS, TRAIL_SLOTS])
    expect(buffer.segments).toEqual(segments)
    expect(buffer.colors).toEqual(colors)
    expect(brightness(buffer, 0, 0, 0)).toBeGreaterThan(0)
  })

  it('only refades within a step, and samples once per step crossed', () => {
    const { buffer, calls, positionAt } = trail(T0)
    const step = buffer.step[1]
    const k = Math.floor(T0 / step)
    const inStep = (k + 0.5) * step === T0 ? (k + 0.25) * step : (k + 0.5) * step
    // Within the same step for the slow body (the fast one may cross).
    calls.fill(0)
    updateTrails(buffer, inStep, positionAt)
    expect(calls[1]).toBe(0)
    calls.fill(0)
    expect(updateTrails(buffer, (k + 1) * step, positionAt)).toBe(SEGMENTS_CHANGED | COLORS_CHANGED)
    expect(calls[1]).toBe(1)
  })

  it('matches a fresh trail after running forward, backward or jumping', () => {
    const { buffer, calls, positionAt } = trail(T0)
    const check = (t: number) => {
      const fresh = trail(t).buffer
      for (let v = 0; v < buffer.segments.length; v++) {
        expect(buffer.segments[v]).toBeCloseTo(fresh.segments[v], 3)
      }
      for (let v = 0; v < buffer.colors.length; v++) {
        expect(buffer.colors[v]).toBeCloseTo(fresh.colors[v], 6)
      }
    }
    // Forward a day a frame, as at 1 day/s.
    let t = T0
    for (let f = 0; f < 120; f++) updateTrails(buffer, (t += DAY / 60), positionAt)
    check(t)
    // Back a little, as a scrub does: only the new tail is sampled.
    calls.fill(0)
    t -= 3 * buffer.step[1]
    updateTrails(buffer, t, positionAt)
    expect(calls[1]).toBeLessThanOrEqual(4)
    check(t)
    // A jump of years refills, with no chord across the gap.
    calls.fill(0)
    t += 5 * 365 * DAY
    updateTrails(buffer, t, positionAt)
    expect(calls).toEqual([TRAIL_SLOTS, TRAIL_SLOTS])
    check(t)
  })
})
