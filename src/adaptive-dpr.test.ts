import { describe, expect, it } from 'vitest'
import {
  createAdaptiveDprState,
  dprLevels,
  dropTarget,
  maxDpr,
  raiseTarget,
  stepAdaptiveDpr,
  type AdaptiveDprState,
  DPR_BUDGET_MS,
  DPR_RAISE_BELOW_MS,
  DPR_RAISE_DWELL_MS,
} from './adaptive-dpr'

const FRAME = 16.7

/** Feeds frames at 60 fps from `from`; ms(dpr) is the GPU time at a ratio. */
function run(
  state: AdaptiveDprState,
  { from, frames, ms, max = state.levels[0] }: { from: number; frames: number; ms: (dpr: number) => number; max?: number },
) {
  const changes: { at: number; dpr: number; frame: number }[] = []
  let at = from
  for (let i = 0; i < frames; i++) {
    at = from + i * FRAME
    const dpr = state.dpr
    state = stepAdaptiveDpr(state, { at, ms: ms(dpr), dpr }, max)
    if (state.dpr !== dpr) changes.push({ at, dpr: state.dpr, frame: i })
  }
  return { state, changes, end: at }
}

/** Steps frames until done(state) or limitMs passes; at is the last frame's time. */
function runUntil(
  state: AdaptiveDprState,
  { from, ms, done, limitMs }: { from: number; ms: (dpr: number) => number; done: (s: AdaptiveDprState) => boolean; limitMs: number },
) {
  let at = from
  for (; at < from + limitMs && !done(state); at += FRAME) {
    state = stepAdaptiveDpr(state, { at, ms: ms(state.dpr), dpr: state.dpr }, state.levels[0])
  }
  return { state, at }
}

/** Fill-bound: the cost at 2x scaled by pixel count. */
const fill = (msAt2: number) => (dpr: number) => msAt2 * (dpr / 2) ** 2

describe('maxDpr and dprLevels', () => {
  it('caps the display ratio to [1, 2]', () => {
    expect(maxDpr(3)).toBe(2)
    expect(maxDpr(0.9)).toBe(1)
    expect(maxDpr(1.5)).toBe(1.5)
    expect(maxDpr(0)).toBe(1)
  })

  it('steps down by 0.25 to 1', () => {
    expect(dprLevels(2)).toEqual([2, 1.75, 1.5, 1.25, 1])
    expect(dprLevels(1.5)).toEqual([1.5, 1.25, 1])
    expect(dprLevels(1.1)).toEqual([1.1, 1])
    expect(dprLevels(1)).toEqual([1])
  })
})

describe('dropTarget', () => {
  const levels = dprLevels(2)
  it('drops to the highest level predicted within budget (tides-4sy numbers)', () => {
    expect(dropTarget(levels, 2, 31.8, DPR_BUDGET_MS)).toBe(1)
    expect(dropTarget(levels, 2, 23.2, DPR_BUDGET_MS)).toBe(1.25)
    expect(dropTarget(levels, 2, 24.8, DPR_BUDGET_MS)).toBe(1.25)
  })

  it('keeps a frame already within budget', () => {
    expect(dropTarget(levels, 2, 9.1, DPR_BUDGET_MS)).toBe(2)
  })

  it('never goes below the last level', () => {
    expect(dropTarget(levels, 2, 200, DPR_BUDGET_MS)).toBe(1)
    expect(dropTarget(levels, 1, 40, DPR_BUDGET_MS)).toBe(1)
  })
})

describe('raiseTarget', () => {
  const levels = dprLevels(2)
  it('raises one step only when predicted under the raise threshold', () => {
    expect(raiseTarget(levels, 1.25, 5, DPR_RAISE_BELOW_MS)).toBe(1.5)
    expect(raiseTarget(levels, 1, 1, DPR_RAISE_BELOW_MS)).toBe(1.25)
    expect(raiseTarget(levels, 1.25, 9, DPR_RAISE_BELOW_MS)).toBeNull()
  })

  it('has nowhere to go at the max', () => {
    expect(raiseTarget(levels, 2, 1, DPR_RAISE_BELOW_MS)).toBeNull()
  })
})

describe('createAdaptiveDprState', () => {
  it('starts at the max, or at the highest level at or below a given ratio', () => {
    expect(createAdaptiveDprState(2).dpr).toBe(2)
    expect(createAdaptiveDprState(2, 1.25).dpr).toBe(1.25)
    expect(createAdaptiveDprState(2, 1.3).dpr).toBe(1.25)
    expect(createAdaptiveDprState(2, 3).dpr).toBe(2)
    expect(createAdaptiveDprState(2, 0.5).dpr).toBe(1)
    expect(createAdaptiveDprState(1.1, 1.05).dpr).toBe(1)
  })
})

describe('stepAdaptiveDpr', () => {
  it('drops a steady 31.8 ms at 2x to 1 after about half a second', () => {
    const { state, changes } = run(createAdaptiveDprState(2), { from: 0, frames: 60, ms: () => 31.8 })
    expect(changes).toHaveLength(1)
    expect(changes[0].dpr).toBe(1)
    expect(changes[0].frame).toBeGreaterThanOrEqual(9)
    expect(changes[0].at).toBeGreaterThanOrEqual(400)
    expect(changes[0].at).toBeLessThan(550)
    expect(state.dpr).toBe(1)
    expect(state.lastMedianMs).toBe(31.8)
  })

  it('decides nothing on fewer than 10 samples', () => {
    const start = createAdaptiveDprState(2)
    // Nine samples 50 ms apart span the 400 ms a window needs.
    let state = start
    for (let i = 0; i < 9; i++) state = stepAdaptiveDpr(state, { at: i * 50, ms: 40, dpr: 2 }, 2)
    expect(state.dpr).toBe(2)
    state = stepAdaptiveDpr(state, { at: 9 * 50, ms: 40, dpr: 2 }, 2)
    expect(state.dpr).toBe(1)
  })

  it('leaves the cheap system view at full resolution', () => {
    const { changes, state } = run(createAdaptiveDprState(2), { from: 0, frames: 600, ms: () => 1.3 })
    expect(changes).toEqual([])
    expect(state.dpr).toBe(2)
  })

  it('ignores samples drawn at the old ratio and skips two after a change', () => {
    // The drop comes on frame 24, the first spanning 400 ms.
    let state = run(createAdaptiveDprState(2), { from: 0, frames: 25, ms: () => 31.8 }).state
    expect(state.dpr).toBe(1)
    expect(state.skip).toBe(2)
    // In flight from before the change: tagged 2.
    const late = stepAdaptiveDpr(state, { at: 600, ms: 31.8, dpr: 2 }, 2)
    expect(late).toBe(state)
    state = stepAdaptiveDpr(state, { at: 610, ms: 8, dpr: 1 }, 2)
    state = stepAdaptiveDpr(state, { at: 620, ms: 8, dpr: 1 }, 2)
    expect(state.skip).toBe(0)
    expect(state.samples).toEqual([])
    state = stepAdaptiveDpr(state, { at: 630, ms: 8, dpr: 1 }, 2)
    expect(state.samples).toHaveLength(1)
  })

  it('clears the window after a 300 ms gap', () => {
    const { state, end } = run(createAdaptiveDprState(2), { from: 0, frames: 20, ms: () => 5 })
    expect(state.samples.length).toBe(20)
    const after = stepAdaptiveDpr(state, { at: end + 300, ms: 5, dpr: 2 }, 2)
    expect(after.samples).toEqual([{ at: end + 300, ms: 5 }])
  })

  it('raises only after 2 s of good predictions; one bad window resets the wait', () => {
    // Settle at 1 from 31.8 ms at 2x, then the view gets cheap: 2 ms at 1x
    // predicts 3.1 ms at 1.25.
    const state = run(createAdaptiveDprState(2), { from: 0, frames: 30, ms: () => 31.8 }).state
    expect(state.dpr).toBe(1)
    const cheap = () => 2
    let r = run(state, { from: 1000, frames: 120, ms: cheap }) // 2 s, but the window fills ~0.4 s in
    expect(r.changes).toEqual([])
    expect(r.state.dpr).toBe(1)
    expect(r.state.goodSince).not.toBeNull()
    // A bad half second (over the raise threshold, under budget) resets goodSince.
    r = run(r.state, { from: r.end + FRAME, frames: 30, ms: () => 11 })
    expect(r.state.goodSince).toBeNull()
    expect(r.changes).toEqual([])
    const resumed = r.end + FRAME
    r = run(r.state, { from: resumed, frames: 200, ms: cheap })
    expect(r.changes).toHaveLength(1)
    expect(r.changes[0].dpr).toBe(1.25)
    // Good from when the window's median turns good again, plus 2 s.
    expect(r.changes[0].at - resumed).toBeGreaterThanOrEqual(2000)
    expect(r.changes[0].at - resumed).toBeLessThan(2400)
  })

  it('doubles the raise dwell when a raise is undone within 2 s, up to 32 s', () => {
    let state = createAdaptiveDprState(2)
    state = { ...state, dpr: 1.25 }
    // Cheap enough at 1.25 to predict a raise fits, but not fill-bound: over
    // budget at 1.5, so each raise is undone half a second later.
    const ms = (dpr: number) => (dpr <= 1.25 ? 3 : 15)
    const dwells: number[] = []
    let at = 0
    for (let i = 0; i < 6; i++) {
      const r = run(state, { from: at, frames: Math.ceil((state.raiseDwellMs + 2000) / FRAME), ms })
      state = r.state
      at = r.end + FRAME
      dwells.push(state.raiseDwellMs)
    }
    expect(dwells).toEqual([4000, 8000, 16000, 32000, 32000, 32000])
    expect(state.dpr).toBe(1.25)
  })

  it('clamps to a new display and stops adapting at 1x', () => {
    let state = createAdaptiveDprState(2)
    state = stepAdaptiveDpr(state, { at: 0, ms: 31.8, dpr: 2 }, 1)
    expect(state.dpr).toBe(1)
    expect(state.levels).toEqual([1])
    const { changes, state: after } = run(state, { from: 20, frames: 100, ms: () => 40 })
    expect(changes).toEqual([])
    expect(after).toBe(state)
  })

  it('returns the same object when nothing changed', () => {
    const state = createAdaptiveDprState(2)
    expect(stepAdaptiveDpr(state, { at: 0, ms: 5, dpr: 1.5 }, 2)).toBe(state)
    const fixed = createAdaptiveDprState(1)
    expect(stepAdaptiveDpr(fixed, { at: 0, ms: 50, dpr: 1 }, 1)).toBe(fixed)
  })

  it('holds a 1.25 dropped to from 23.2 ms at 2x: a raise would land over 9 ms', () => {
    const { changes, state } = run(createAdaptiveDprState(2), { from: 0, frames: 600, ms: fill(23.2) })
    expect(changes.map((c) => c.dpr)).toEqual([1.25])
    expect(state.dpr).toBe(1.25)
  })

  it('puts the dwell back to base once a raise holds 2 s', () => {
    const start = { ...createAdaptiveDprState(2, 1.25), raiseDwellMs: 4 * DPR_RAISE_DWELL_MS }
    const cheap = fill(1.3)
    const raised = runUntil(start, { from: 0, ms: cheap, done: (s) => s.dpr > 1.25, limitMs: 10000 })
    expect(raised.state.dpr).toBe(1.5)
    expect(raised.state.raiseDwellMs).toBe(4 * DPR_RAISE_DWELL_MS)
    const held = runUntil(raised.state, {
      from: raised.at + FRAME,
      ms: cheap,
      done: (s) => s.lastRaiseAt == null,
      limitMs: 3000,
    })
    expect(held.state.dpr).toBe(1.5)
    expect(held.state.raiseDwellMs).toBe(DPR_RAISE_DWELL_MS)
    expect(held.at - raised.at).toBeGreaterThan(2000)
    expect(held.at - raised.at).toBeLessThan(2100)
  })

  it('climbs back to 2x after each close zoom, the dwell staying at base', () => {
    const close = fill(24.8)
    const system = fill(1.3)
    let state = createAdaptiveDprState(2)
    let at = 0
    for (let cycle = 0; cycle < 5; cycle++) {
      // Zoom in for a second: drops to 1.25.
      let r = run(state, { from: at, frames: 60, ms: close })
      expect(r.state.dpr).toBe(1.25)
      expect(r.state.raiseDwellMs).toBe(DPR_RAISE_DWELL_MS)
      // Zoom out: three steps of a window and a 2 s dwell back to 2.
      const out = r.end + FRAME
      const back = runUntil(r.state, { from: out, ms: system, done: (s) => s.dpr === 2, limitMs: 20000 })
      expect(back.state.dpr).toBe(2)
      expect(back.at - out).toBeLessThan(3 * (DPR_RAISE_DWELL_MS + 500))
      // The raise to 2 holds before the next zoom in.
      r = run(back.state, { from: back.at, frames: 150, ms: system })
      expect(r.state.raiseDwellMs).toBe(DPR_RAISE_DWELL_MS)
      state = r.state
      at = r.end + FRAME
    }
  })

  it('recovers the base dwell after zooming in right after a raise', () => {
    const close = fill(24.8)
    const system = fill(1.3)
    let state = run(createAdaptiveDprState(2), { from: 0, frames: 60, ms: close }).state
    const back = runUntil(state, { from: 1000, ms: system, done: (s) => s.dpr === 2, limitMs: 20000 })
    // Zoom in within 2 s of the raise to 2: the raise counts as undone.
    let r = run(back.state, { from: back.at, frames: 60, ms: close })
    expect(r.state.dpr).toBe(1.25)
    expect(r.state.raiseDwellMs).toBe(2 * DPR_RAISE_DWELL_MS)
    // Zoomed out again, the first raise waits the doubled dwell and, held,
    // puts it back.
    r = run(r.state, { from: r.end + FRAME, frames: 900, ms: system })
    state = r.state
    expect(state.dpr).toBe(2)
    expect(state.raiseDwellMs).toBe(DPR_RAISE_DWELL_MS)
  })
})
