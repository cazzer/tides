import { describe, expect, it } from 'vitest'
import {
  TRAIL_MAX_DEGREES,
  TRAIL_OPACITY,
  TRAIL_SAMPLES_PER_SECOND,
  TRAIL_SECONDS,
  TRAIL_SLOTS,
  beginTrailFrame,
  createTrailBuffer,
  fadeTrail,
  trailFade,
  writeTrailHead,
  type TrailBuffer,
} from './trail-buffer'

const RED = [1, 0, 0] as const
const BLUE = [0, 0, 1] as const
const DAY = 86_400_000

function alpha(buffer: TrailBuffer, vertex: number): number {
  return buffer.colors[vertex * 4 + 3]
}

function vertex(buffer: TrailBuffer, v: number): number[] {
  return Array.from(buffer.positions.subarray(v * 3, v * 3 + 3))
}

// Runs `seconds` of 60 fps frames; body b sits at x = b + where(sim).
function run(
  buffer: TrailBuffer,
  {
    from = 0,
    seconds,
    simPerSecond,
    periodDays = [365, 365],
    where = (sim: number) => sim / DAY,
    present = () => true,
  }: {
    from?: number
    seconds: number
    simPerSecond: number
    periodDays?: number[]
    where?: (sim: number) => number
    present?: (body: number, now: number) => boolean
  }
): number {
  const frames = Math.round(seconds * 60)
  let now = from
  for (let f = 1; f <= frames; f++) {
    now = from + f / 60
    const sim = now * simPerSecond
    beginTrailFrame(buffer, now, sim)
    for (let b = 0; b < buffer.bodies; b++) {
      if (present(b, now)) writeTrailHead(buffer, b, b + where(sim), 0, 0)
    }
    fadeTrail(buffer, now, sim, periodDays)
  }
  return now
}

describe('trailFade', () => {
  it('is 1 at the planet and 0 at either limit', () => {
    expect(trailFade(0, 0)).toBe(1)
    expect(trailFade(TRAIL_SECONDS, 0)).toBe(0)
    expect(trailFade(0, TRAIL_MAX_DEGREES)).toBe(0)
    expect(trailFade(TRAIL_SECONDS * 2, 0)).toBe(0)
  })

  it('fades by whichever limit is nearer', () => {
    expect(trailFade(TRAIL_SECONDS / 2, TRAIL_MAX_DEGREES / 4)).toBeCloseTo(0.5, 12)
    expect(trailFade(TRAIL_SECONDS / 4, (TRAIL_MAX_DEGREES * 3) / 4)).toBeCloseTo(0.25, 12)
  })
})

describe('the trail ring buffer', () => {
  it('has room for a whole trail before it wraps', () => {
    expect(TRAIL_SLOTS).toBeGreaterThan(TRAIL_SECONDS * TRAIL_SAMPLES_PER_SECOND)
  })

  it('gives each body its colour and starts empty', () => {
    const buffer = createTrailBuffer([RED, BLUE])
    expect(buffer.positions).toHaveLength(2 * TRAIL_SLOTS * 2 * 3)
    expect(Array.from(buffer.colors.subarray(0, 4))).toEqual([1, 0, 0, 0])
    const blue = TRAIL_SLOTS * 2
    expect(Array.from(buffer.colors.subarray(blue * 4, blue * 4 + 4))).toEqual([0, 0, 1, 0])
    fadeTrail(buffer, 0, 0, [365, 365])
    expect(buffer.colors.every((c, i) => i % 4 !== 3 || c === 0)).toBe(true)
  })

  it('joins consecutive samples into one unbroken line', () => {
    const buffer = createTrailBuffer([RED, BLUE])
    run(buffer, { seconds: 3, simPerSecond: DAY })
    for (let b = 0; b < 2; b++) {
      for (let j = 0; j < TRAIL_SLOTS; j++) {
        const end = (b * TRAIL_SLOTS + j) * 2 + 1
        const nextStart = (b * TRAIL_SLOTS + ((j + 1) % TRAIL_SLOTS)) * 2
        expect(vertex(buffer, end)).toEqual(vertex(buffer, nextStart))
      }
    }
  })

  it('keeps the head on the planet at full opacity and fades toward the tail', () => {
    const buffer = createTrailBuffer([RED, BLUE])
    const now = run(buffer, { seconds: 3, simPerSecond: DAY })
    const head = buffer.head
    // The head is the end of the segment before it, at the latest position.
    const into = (TRAIL_SLOTS + ((head - 1 + TRAIL_SLOTS) % TRAIL_SLOTS)) * 2 + 1
    expect(vertex(buffer, into)[0]).toBeCloseTo(1 + now, 3)
    expect(alpha(buffer, into)).toBeCloseTo(TRAIL_OPACITY, 6)
    // Walking back from the head, each sample is fainter than the last.
    let previous = Infinity
    for (let k = 1; k < TRAIL_SLOTS; k++) {
      const slot = (head - k + TRAIL_SLOTS) % TRAIL_SLOTS
      const start = (TRAIL_SLOTS + slot) * 2
      const a = alpha(buffer, start)
      expect(a).toBeLessThanOrEqual(previous)
      previous = a
      if (k === TRAIL_SLOTS - 1) expect(a).toBe(0)
    }
  })

  it('never draws the segment that closes the ring', () => {
    const buffer = createTrailBuffer([RED])
    for (let s = 1; s <= 8; s++) {
      run(buffer, { from: (s - 1) * 0.37, seconds: 0.37, simPerSecond: DAY })
      const v = buffer.head * 2
      expect(alpha(buffer, v)).toBe(0)
      expect(alpha(buffer, v + 1)).toBe(0)
    }
  })

  it('spans TRAIL_SECONDS of wall time at most', () => {
    const buffer = createTrailBuffer([RED])
    const now = run(buffer, { seconds: 5, simPerSecond: DAY })
    for (let slot = 0; slot < TRAIL_SLOTS; slot++) {
      if (now - buffer.wallAt[slot] >= TRAIL_SECONDS) {
        expect(alpha(buffer, slot * 2)).toBe(0)
      }
    }
    // ...and, with the clock paused, fades away to the planet.
    run(buffer, { from: now, seconds: TRAIL_SECONDS + 0.1, simPerSecond: 0, where: () => 5 })
    const lit = Array.from({ length: TRAIL_SLOTS }, (_, s) => buffer.positions[s * 6])
      .filter((_, s) => alpha(buffer, s * 2) > 0)
    expect(new Set(lit.map((x) => x.toFixed(6)))).toEqual(new Set([(5).toFixed(6)]))
  })

  it('caps the arc on a fast planet', () => {
    // Mercury at a month a second sweeps ~120° a second.
    const buffer = createTrailBuffer([RED])
    const now = run(buffer, { seconds: 3, simPerSecond: 30 * DAY, periodDays: [88] })
    const sim = now * 30 * DAY
    for (let slot = 0; slot < TRAIL_SLOTS; slot++) {
      const arc = ((sim - buffer.simAt[slot]) / (88 * DAY)) * 360
      if (arc >= TRAIL_MAX_DEGREES) expect(alpha(buffer, slot * 2)).toBe(0)
    }
    const visible = Array.from({ length: TRAIL_SLOTS }, (_, s) => alpha(buffer, s * 2) > 0)
    expect(visible.filter(Boolean).length).toBeLessThan(TRAIL_SECONDS * TRAIL_SAMPLES_PER_SECOND / 4)
  })

  it('draws nothing from before a planet first appears', () => {
    const buffer = createTrailBuffer([RED, BLUE])
    // Blue registers a second in; its unwritten slots sit at the origin.
    run(buffer, { seconds: 1.5, simPerSecond: DAY, present: (b, now) => b === 0 || now > 1 })
    for (let slot = 0; slot < TRAIL_SLOTS; slot++) {
      const start = (TRAIL_SLOTS + slot) * 2
      if (buffer.wallAt[slot] <= 1) expect(alpha(buffer, start)).toBe(0)
    }
    expect(alpha(buffer, (TRAIL_SLOTS + ((buffer.head - 1 + TRAIL_SLOTS) % TRAIL_SLOTS)) * 2 + 1)).toBeGreaterThan(0)
  })
})
