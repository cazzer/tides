import { easeExpInOut } from 'd3'
import { interpolateValue } from './utils'

export const JUMP_DURATION_MS = 5000

export interface Jump {
  from: number
  /** Root clock time (s) when the jump began. */
  startedAt: number
}

export interface ClockState {
  timestamp: number | null
  jump: Jump | null
}

export interface ClockInput {
  /** Wall-clock epoch ms, used only when there is no timestamp yet. */
  now: number
  /** Root clock elapsed time, seconds. */
  elapsed: number
  /** Seconds since the previous frame. */
  delta: number
  /** Simulated seconds per real second; 0 pauses. */
  timeScale: number
  initialTimestamp: number | null
  jumpTo: number | null
}

export interface ClockStep {
  timestamp: number
  jump: Jump | null
  jumpDone: boolean
}

export function advanceClock(prev: ClockState, input: ClockInput): ClockStep {
  const current = prev.timestamp ?? input.initialTimestamp ?? input.now

  if (input.jumpTo == null) {
    return {
      timestamp: current + input.delta * 1000 * input.timeScale,
      jump: null,
      jumpDone: false,
    }
  }

  const jump = prev.jump ?? { from: current, startedAt: input.elapsed }
  const progress = Math.min(
    1,
    Math.max(0, ((input.elapsed - jump.startedAt) * 1000) / JUMP_DURATION_MS)
  )
  if (progress >= 1) {
    return { timestamp: input.jumpTo, jump: null, jumpDone: true }
  }
  return {
    timestamp: interpolateValue(jump.from, input.jumpTo, progress, easeExpInOut),
    jump,
    jumpDone: false,
  }
}
