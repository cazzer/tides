import { describe, expect, test } from 'vitest'
import { advanceClock, JUMP_DURATION_MS, type ClockInput, type ClockState } from './sim-clock'

const T0 = Date.UTC(2026, 9, 17, 12)
const DAY = 86_400_000
const FRAME = 1 / 60

const fresh: ClockState = { timestamp: null, jump: null }

function input(overrides: Partial<ClockInput> = {}): ClockInput {
  return {
    now: T0,
    elapsed: 0,
    delta: FRAME,
    timeScale: 1,
    initialTimestamp: null,
    jumpTo: null,
    ...overrides,
  }
}

describe('advanceClock', () => {
  test('first frame starts from initialTimestamp', () => {
    const start = Date.UTC(2000, 0, 1)
    const step = advanceClock(fresh, input({ initialTimestamp: start, delta: 0 }))
    expect(step.timestamp).toBe(start)
  })

  test('first frame falls back to now without initialTimestamp', () => {
    const step = advanceClock(fresh, input({ delta: 0 }))
    expect(step.timestamp).toBe(T0)
  })

  test('frames with delta 0 hold at initialTimestamp', () => {
    const start = Date.UTC(2030, 0, 1)
    let state: ClockState = fresh
    for (let i = 0; i < 10; i++) {
      state = advanceClock(
        state,
        input({ initialTimestamp: start, delta: 0, now: T0 + i * 1000, elapsed: i, timeScale: 2_592_000 })
      )
      expect(state.timestamp).toBe(start)
    }
  })

  test('frames with delta 0 hold at the first frame\'s now', () => {
    let state: ClockState = fresh
    for (let i = 0; i < 10; i++) {
      state = advanceClock(
        state,
        input({ delta: 0, now: T0 + i * 1000, elapsed: i, timeScale: 2_592_000 })
      )
      expect(state.timestamp).toBe(T0)
    }
  })

  test('advances by delta scaled by timeScale', () => {
    const step = advanceClock(
      { timestamp: T0, jump: null },
      input({ delta: 0.5, timeScale: 3600, now: 0, initialTimestamp: 1 })
    )
    expect(step.timestamp).toBe(T0 + 0.5 * 1000 * 3600)
    expect(step.jump).toBeNull()
    expect(step.jumpDone).toBe(false)
  })

  test('timeScale 0 pauses', () => {
    let state: ClockState = { timestamp: T0, jump: null }
    for (let i = 0; i < 10; i++) {
      state = advanceClock(state, input({ timeScale: 0, elapsed: i * FRAME }))
    }
    expect(state.timestamp).toBe(T0)
  })

  describe('jump', () => {
    const target = T0 + 365 * DAY
    const startedAt = 2

    test('starts from the current time, ignoring timeScale', () => {
      const step = advanceClock(
        { timestamp: T0, jump: null },
        input({ jumpTo: target, elapsed: startedAt, timeScale: 2_592_000 })
      )
      expect(step.timestamp).toBe(T0)
      expect(step.jump).toEqual({ from: T0, to: target, startedAt })
      expect(step.jumpDone).toBe(false)
    })

    test('is halfway, eased, at half the duration', () => {
      const step = advanceClock(
        { timestamp: T0 + 123, jump: { from: T0, to: target, startedAt } },
        input({
          jumpTo: target,
          elapsed: startedAt + JUMP_DURATION_MS / 2000,
          timeScale: 2_592_000,
        })
      )
      // easeExpInOut(0.5) = 0.5
      expect(step.timestamp).toBeCloseTo(T0 + (target - T0) / 2, 0)
      expect(step.jumpDone).toBe(false)
    })

    test('is eased: slow start relative to linear', () => {
      const step = advanceClock(
        { timestamp: T0, jump: { from: T0, to: target, startedAt } },
        input({ jumpTo: target, elapsed: startedAt + JUMP_DURATION_MS / 4000 })
      )
      // easeExpInOut(0.25) = (2^-5 - 2^-10) * 1.0009775... / 2 ~= 0.0151
      const progress = (step.timestamp - T0) / (target - T0)
      expect(progress).toBeCloseTo(0.0151, 3)
    })

    test('a new target mid-jump restarts from the current time, with no snap', () => {
      const firstTarget = T0 + 4 * 365 * DAY
      const secondTarget = T0 - 36 * 365 * DAY
      let elapsed = startedAt
      let state: ClockState = { timestamp: T0, jump: null }
      while (elapsed - startedAt < JUMP_DURATION_MS / 2000) {
        state = advanceClock(state, input({ jumpTo: firstTarget, elapsed }))
        elapsed += FRAME
      }
      const midway = state.timestamp as number
      expect(midway).toBeGreaterThan(T0 + DAY)

      const retargeted = advanceClock(state, input({ jumpTo: secondTarget, elapsed }))
      expect(retargeted.jump).toEqual({ from: midway, to: secondTarget, startedAt: elapsed })
      expect(retargeted.timestamp).toBe(midway)

      // One frame later it has barely moved (eased start), not leapt toward 1990.
      const next = advanceClock(retargeted, input({ jumpTo: secondTarget, elapsed: elapsed + FRAME }))
      expect(Math.abs((next.timestamp - midway) / (secondTarget - midway))).toBeLessThan(0.001)

      // The new jump takes the full duration from the retarget.
      const almost = advanceClock(retargeted, input({
        jumpTo: secondTarget,
        elapsed: elapsed + JUMP_DURATION_MS / 1000 - FRAME,
      }))
      expect(almost.jumpDone).toBe(false)
      const done = advanceClock(retargeted, input({
        jumpTo: secondTarget,
        elapsed: elapsed + JUMP_DURATION_MS / 1000,
      }))
      expect(done.jumpDone).toBe(true)
      expect(done.timestamp).toBe(secondTarget)
    })

    test('the same target mid-jump keeps the running tween', () => {
      const jump = { from: T0, to: target, startedAt }
      const step = advanceClock(
        { timestamp: T0 + DAY, jump },
        input({ jumpTo: target, elapsed: startedAt + 1 })
      )
      expect(step.jump).toBe(jump)
    })

    test('lands exactly on jumpTo after the duration, then resumes', () => {
      const from = T0 + 0.37 // fractional ms, as the running clock produces
      let state: ClockState = { timestamp: from, jump: null }
      let elapsed = startedAt
      let step = advanceClock(state, input({ jumpTo: target, elapsed }))
      while (!step.jumpDone) {
        expect(elapsed - startedAt).toBeLessThan(JUMP_DURATION_MS / 1000 + FRAME)
        state = step
        elapsed += FRAME
        step = advanceClock(state, input({ jumpTo: target, elapsed }))
      }
      expect(elapsed - startedAt).toBeGreaterThanOrEqual(JUMP_DURATION_MS / 1000)
      expect(step.timestamp).toBe(target)
      expect(step.jump).toBeNull()

      const after = advanceClock(
        step,
        input({ elapsed: elapsed + FRAME, timeScale: 3600 })
      )
      expect(after.timestamp).toBe(target + FRAME * 1000 * 3600)
      expect(after.jumpDone).toBe(false)
    })
  })
})
