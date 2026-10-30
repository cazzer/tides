// Adaptive canvas pixel ratio (tides-nlk). A Retina window renders at 2x, and
// the heavy views (flight, close zoom) are fill-bound: GPU time scales with
// pixels, so 31.8 ms at 2x is ~8 ms at 1x on an M4 Pro (tides-4sy), while the
// system view costs 1.3 ms at 2x. So the ratio drops only while the measured
// GPU frame is over budget and climbs back only when a step up is predicted
// to fit well under it, after a dwell that doubles each time a raise has to
// be undone. Pure: the GPU timer and the canvas live in AdaptivePixelRatio.

/** The GPU frame budget: over it (median of the window) the ratio drops. */
export const DPR_BUDGET_MS = 12
/** A step up must be predicted under this, so a raise doesn't land over budget. */
export const DPR_RAISE_BELOW_MS = 9
/** The sliding window the median is taken over. */
export const DPR_WINDOW_MS = 500
/** Fewer samples than this in a window decide nothing. */
export const DPR_MIN_SAMPLES = 10
/** How long the step up must stay predicted to fit before it's taken. */
export const DPR_RAISE_DWELL_MS = 2000
/**
 * The dwell doubles on each raise undone within 2 s, up to this, and goes
 * back to DPR_RAISE_DWELL_MS once a raise holds 2 s.
 */
export const DPR_RAISE_DWELL_CAP_MS = 32000
/** Samples ignored after a change: the first frames at a new size run cold. */
export const DPR_SETTLE_FRAMES = 2
export const DPR_STEP = 0.25
export const DPR_FLOOR = 1

/** A gap this long (a hidden tab, a stall) makes the window stale. */
const GAP_MS = 250
/** A full window spans at least this much of DPR_WINDOW_MS. */
const MIN_SPAN_MS = 400
/** A drop this soon after a raise means the raise was wrong. */
const BOUNCE_MS = 2000

export interface AdaptiveDprConfig {
  budgetMs: number
  raiseBelowMs: number
  windowMs: number
  minSamples: number
  raiseDwellMs: number
  raiseDwellCapMs: number
  settleFrames: number
}

export const DEFAULT_DPR_CONFIG: AdaptiveDprConfig = {
  budgetMs: DPR_BUDGET_MS,
  raiseBelowMs: DPR_RAISE_BELOW_MS,
  windowMs: DPR_WINDOW_MS,
  minSamples: DPR_MIN_SAMPLES,
  raiseDwellMs: DPR_RAISE_DWELL_MS,
  raiseDwellCapMs: DPR_RAISE_DWELL_CAP_MS,
  settleFrames: DPR_SETTLE_FRAMES,
}

export interface DprSample {
  /** performance.now() when the result was read. */
  at: number
  ms: number
}

export interface AdaptiveDprState {
  dpr: number
  /** Descending, levels[0] the display's ratio (capped at 2). */
  levels: number[]
  /** GPU frame times at the current dpr only, oldest first. */
  samples: DprSample[]
  /** Samples still to ignore after the last change. */
  skip: number
  /** When the step up was first predicted to fit, or null. */
  goodSince: number | null
  raiseDwellMs: number
  /** The last raise, until it's undone or has held BOUNCE_MS. */
  lastRaiseAt: number | null
  /** The window median that decided the last change, for the log. */
  lastMedianMs: number | null
}

/** The ceiling: R3F's default [1, 2] applied to the display's ratio. */
export function maxDpr(devicePixelRatio: number): number {
  return Math.min(Math.max(devicePixelRatio || 1, 1), 2)
}

/** max, then each multiple of DPR_STEP below it down to DPR_FLOOR. */
export function dprLevels(max: number): number[] {
  const levels = [max]
  // The epsilon keeps an exact multiple (2) from listing itself twice.
  for (let k = Math.ceil(max / DPR_STEP - 1e-9) - 1; k * DPR_STEP >= DPR_FLOOR; k--) {
    levels.push(k * DPR_STEP)
  }
  return levels
}

/** Fill-bound: the frame's cost goes as the pixel count, (dpr ratio)^2. */
function predictMs(medianMs: number, from: number, to: number): number {
  return medianMs * (to / from) ** 2
}

/** The highest level at or below current predicted within budget, else the lowest. */
export function dropTarget(levels: number[], current: number, medianMs: number, budgetMs: number): number {
  for (const level of levels) {
    if (level <= current && predictMs(medianMs, current, level) <= budgetMs) return level
  }
  return levels[levels.length - 1]
}

/** One step up, if it's predicted under raiseBelowMs; else null. */
export function raiseTarget(levels: number[], current: number, medianMs: number, raiseBelowMs: number): number | null {
  let up: number | null = null
  for (const level of levels) if (level > current) up = level
  if (up == null) return null
  return predictMs(medianMs, current, up) < raiseBelowMs ? up : null
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Starts at the highest level at or below `start` (the ratio the canvas has
 * now, so a remount doesn't jump back to the max).
 */
export function createAdaptiveDprState(
  max: number,
  start: number = max,
  config: AdaptiveDprConfig = DEFAULT_DPR_CONFIG,
): AdaptiveDprState {
  const levels = dprLevels(max)
  return {
    dpr: levels.find((level) => level <= start) ?? levels[levels.length - 1],
    levels,
    samples: [],
    skip: 0,
    goodSince: null,
    raiseDwellMs: config.raiseDwellMs,
    lastRaiseAt: null,
    lastMedianMs: null,
  }
}

/**
 * Folds one GPU frame time, measured at sample.dpr, into the state. Returns
 * the same object when nothing changed (a sample from before the last change,
 * or a display that can't adapt).
 */
export function stepAdaptiveDpr(
  state: AdaptiveDprState,
  sample: DprSample & { dpr: number },
  max: number,
  config: AdaptiveDprConfig = DEFAULT_DPR_CONFIG,
): AdaptiveDprState {
  let next = state
  if (max !== state.levels[0]) {
    // The window moved to another display.
    const dpr = Math.min(state.dpr, max)
    next = {
      ...state,
      dpr,
      levels: dprLevels(max),
      samples: [],
      skip: dpr === state.dpr ? state.skip : config.settleFrames,
      goodSince: null,
      raiseDwellMs: config.raiseDwellMs,
      lastRaiseAt: null,
    }
  }
  if (next.levels.length === 1 || sample.dpr !== next.dpr) return next
  const { at } = sample
  if (next.lastRaiseAt != null && at - next.lastRaiseAt > BOUNCE_MS) {
    // The raise held: the next one waits the base dwell again, so a drop
    // when the view turns heavy doesn't count against it.
    next = { ...next, raiseDwellMs: config.raiseDwellMs, lastRaiseAt: null }
  }
  if (next.skip > 0) return { ...next, skip: next.skip - 1 }

  const last = next.samples[next.samples.length - 1]
  const kept = last && at - last.at > GAP_MS ? [] : next.samples.filter((s) => s.at >= at - config.windowMs)
  const samples = [...kept, { at, ms: sample.ms }]
  const full = samples.length >= config.minSamples && at - samples[0].at >= MIN_SPAN_MS
  const medianMs = full ? median(samples.map((s) => s.ms)) : NaN

  if (full && medianMs > config.budgetMs) {
    const target = dropTarget(next.levels, next.dpr, medianMs, config.budgetMs)
    if (target < next.dpr) {
      const bounced = next.lastRaiseAt != null && at - next.lastRaiseAt <= BOUNCE_MS
      return {
        ...next,
        dpr: target,
        samples: [],
        skip: config.settleFrames,
        goodSince: null,
        raiseDwellMs: bounced ? Math.min(next.raiseDwellMs * 2, config.raiseDwellCapMs) : next.raiseDwellMs,
        lastRaiseAt: null,
        lastMedianMs: medianMs,
      }
    }
  } else if (full) {
    const up = raiseTarget(next.levels, next.dpr, medianMs, config.raiseBelowMs)
    if (up != null) {
      const goodSince = next.goodSince ?? at
      if (at - goodSince >= next.raiseDwellMs) {
        return {
          ...next,
          dpr: up,
          samples: [],
          skip: config.settleFrames,
          goodSince: null,
          lastRaiseAt: at,
          lastMedianMs: medianMs,
        }
      }
      return { ...next, samples, goodSince }
    }
  }
  return { ...next, samples, goodSince: null }
}
