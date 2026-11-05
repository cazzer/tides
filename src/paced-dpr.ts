// Paced pixel ratio for the low tier (tides-0oi.13). Phones have no GPU timer
// (no EXT_disjoint_timer_query on the Adreno 660), so this reads the rAF
// interval instead: a frame that fits vsync arrives one vsync after the last,
// one that doesn't arrives two or more later. The S21 baseline (tides-0oi.1)
// has ~9 ms of headroom in the system view and none at close zoom, so the
// system view climbs toward the display's ratio (3 on the S21, 2 today) while
// close views stay at 2 and drop only when frames miss. Pure: the clock, the
// store and the canvas live in AdaptivePixelRatio.
//
// An interval also stretches when the main thread is late, which no
// resolution change fixes, so an interval after a frame whose CPU time took
// most of a vsync is left out, and a window that is mostly such intervals
// decides nothing.

import { dprLevels, maxDpr } from './adaptive-dpr'

export type ViewKind = 'system' | 'close' | 'ship' | 'demo'

export interface PacedDprConfig {
  /** The sliding window, stretched to hold minSamples when frames are slow. */
  windowMs: number
  /** Fewer kept intervals than this decide nothing. */
  minSamples: number
  /** Drop a level when the window's p95 interval is over this many vsyncs. */
  dropP95: number
  /** Raise only while the window's p99 interval is at most this many vsyncs. */
  raiseP99: number
  /** How long the raise must stay good before it's taken. */
  raiseDwellMs: number
  /** The dwell doubles on each raise undone within bounceMs, up to this. */
  dwellCapMs: number
  /** A drop this soon after a raise means the raise was wrong. */
  bounceMs: number
  /** A drop from a level held this long is heat, not the view (thermal). */
  heldMs: number
  /** After a thermal drop the next raise waits at least this long. */
  thermalDwellMs: number
  /** Intervals ignored after a change: the resize and the first frames at a new size. */
  settleMs: number
  /** An interval this long (a hidden tab, a stall) empties the window. */
  gapMs: number
  /** An interval after a frame whose CPU time is over this share of vsync is CPU-bound. */
  cpuBoundShare: number
  /** The lowest ratio the controller goes to. */
  floor: number
  /** The ceiling in the system view, under the display's ratio. */
  systemMax: number
  /** The ceiling in every other view. */
  otherMax: number
  /** A fixed ratio instead of the controller (dprctl=fixed:x), or null. */
  fixed: number | null
  /** dprctl=off: no controller, R3F's default ratio. */
  off: boolean
}

export const DEFAULT_PACED_DPR_CONFIG: PacedDprConfig = {
  windowMs: 1500,
  minSamples: 60,
  dropP95: 1.5,
  raiseP99: 1.2,
  raiseDwellMs: 4000,
  dwellCapMs: 64000,
  bounceMs: 3000,
  heldMs: 10000,
  thermalDwellMs: 60000,
  settleMs: 750,
  gapMs: 1000,
  cpuBoundShare: 0.75,
  floor: 1.5,
  systemMax: 3,
  otherMax: 2,
  fixed: null,
  off: false,
}

type NumericKey = Exclude<keyof PacedDprConfig, 'fixed' | 'off'>

/** What each dprctl key may be set to; out-of-range values are clamped. */
const RANGES: Record<NumericKey | 'fixed', [number, number]> = {
  windowMs: [250, 10000],
  minSamples: [5, 600],
  dropP95: [1.05, 4],
  raiseP99: [1, 3],
  raiseDwellMs: [0, 600000],
  dwellCapMs: [0, 3600000],
  bounceMs: [0, 60000],
  heldMs: [0, 600000],
  thermalDwellMs: [0, 3600000],
  settleMs: [0, 10000],
  gapMs: [100, 10000],
  cpuBoundShare: [0.1, 10],
  floor: [0.5, 4],
  systemMax: [0.5, 4],
  otherMax: [0.5, 4],
  fixed: [0.5, 4],
}

function warnInDev(message: string) {
  if (import.meta.env?.DEV) console.warn(message)
}

/**
 * The URL's ?dprctl=key:val,... over the defaults (also `off` and
 * `fixed:2.5`), or null when the URL has none. Values are clamped to RANGES;
 * unknown keys and unreadable values are skipped with a warning.
 */
export function parsePacedDprConfig(search: string, warn: (message: string) => void = warnInDev): PacedDprConfig | null {
  const raw = new URLSearchParams(search).get('dprctl')
  if (raw == null) return null
  const config: PacedDprConfig = { ...DEFAULT_PACED_DPR_CONFIG }
  for (const part of raw.split(',')) {
    const token = part.trim()
    if (!token) continue
    if (token === 'off') {
      config.off = true
      continue
    }
    const colon = token.indexOf(':')
    const key = colon < 0 ? token : token.slice(0, colon)
    const value = colon < 0 ? NaN : Number(token.slice(colon + 1))
    if (!Object.prototype.hasOwnProperty.call(RANGES, key)) {
      warn(`[render] dprctl: unknown key "${key}"`)
      continue
    }
    if (!Number.isFinite(value)) {
      warn(`[render] dprctl: "${token}" needs a number`)
      continue
    }
    const [lo, hi] = RANGES[key as NumericKey | 'fixed']
    const clamped = Math.min(Math.max(value, lo), hi)
    if (clamped !== value) warn(`[render] dprctl: ${key} ${value} clamped to ${clamped}`)
    config[key as NumericKey | 'fixed'] = key === 'minSamples' ? Math.round(clamped) : clamped
  }
  return config
}

/** The view the frame draws, from the store's flags (a demo wins over the rest). */
export function viewKindOf(view: { demo: unknown; shipMode: boolean; closeZoom: boolean }): ViewKind {
  if (view.demo) return 'demo'
  if (view.shipMode) return 'ship'
  if (view.closeZoom) return 'close'
  return 'system'
}

export interface PacedDprChange {
  at: number
  from: number
  to: number
  reason: 'raise' | 'drop' | 'thermal' | 'kind' | 'ceiling'
  /** The window's p95 / p99 interval and the vsync estimate, null for a kind or ceiling change. */
  p95: number | null
  p99: number | null
  vsyncMs: number
  /** The raise dwell after this change. */
  dwellMs: number
}

export interface PacedDprState {
  dpr: number
  kind: ViewKind | null
  /** The ratio each view last ran at, restored on coming back to it. */
  levelByKind: Partial<Record<ViewKind, number>>
  /** The shortest vsync seen (the p10 interval of a full window). */
  vsyncMs: number
  /** The window, oldest first: each interval's end, its length, and whether it was CPU-bound. */
  times: number[]
  intervals: number[]
  cpuBound: boolean[]
  /** Intervals ending before this are ignored (the last change settling). */
  settleUntil: number
  /** When the raise was first good, or null. */
  goodSince: number | null
  dwellMs: number
  /** The last raise, until it's undone or has held bounceMs. */
  lastRaiseAt: number | null
  /** When the ratio last changed. */
  levelSince: number
  /** The change that made the current ratio, for the log. */
  last: PacedDprChange | null
}

const VSYNC_START_MS = 1000 / 60
const VSYNC_FLOOR_MS = 6
/** The window never holds more than this many intervals, however many are CPU-bound. */
const MAX_WINDOW = 600

function ceilingOf(kind: ViewKind, nativeDpr: number, config: PacedDprConfig): number {
  return maxDpr(nativeDpr, kind === 'system' ? config.systemMax : config.otherMax)
}

/** The levels from the ceiling down to the floor (the floor no higher than the ceiling). */
function levelsUnder(ceiling: number, config: PacedDprConfig): number[] {
  const floor = Math.min(config.floor, ceiling)
  const levels = dprLevels(ceiling).filter((level) => level >= floor - 1e-9)
  return levels.length ? levels : [ceiling]
}

/** The highest level at or below `dpr`, else the lowest. */
function snap(levels: number[], dpr: number): number {
  return levels.find((level) => level <= dpr + 1e-9) ?? levels[levels.length - 1]
}

export function createPacedDprState(
  nativeDpr: number,
  startDpr: number,
  config: PacedDprConfig = DEFAULT_PACED_DPR_CONFIG,
): PacedDprState {
  return {
    dpr: startDpr,
    kind: null,
    levelByKind: {},
    vsyncMs: VSYNC_START_MS,
    times: [],
    intervals: [],
    cpuBound: [],
    settleUntil: -Infinity,
    goodSince: null,
    dwellMs: config.raiseDwellMs,
    lastRaiseAt: null,
    levelSince: 0,
    last: null,
  }
}

function clearWindow(state: PacedDprState) {
  state.times.length = 0
  state.intervals.length = 0
  state.cpuBound.length = 0
  state.goodSince = null
}

function change(
  state: PacedDprState,
  to: number,
  at: number,
  reason: PacedDprChange['reason'],
  config: PacedDprConfig,
  p95: number | null = null,
  p99: number | null = null,
) {
  state.last = { at, from: state.dpr, to, reason, p95, p99, vsyncMs: state.vsyncMs, dwellMs: state.dwellMs }
  state.dpr = to
  state.levelSince = at
  state.settleUntil = at + config.settleMs
  clearWindow(state)
}

/** Reused for the percentiles, so a frame sorts without allocating. */
let scratch = new Float64Array(MAX_WINDOW)

/** Nearest-rank percentile of the first n values of a sorted array. */
function percentile(sorted: Float64Array, n: number, q: number): number {
  return sorted[Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1))]
}

export interface PacedDprSample {
  /** The rAF timestamp of the frame that ends the interval. */
  at: number
  /** at minus the previous frame's timestamp. */
  intervalMs: number
  /** The previous frame's CPU time (its effects, useFrame and draws). */
  cpuMs: number
  kind: ViewKind
  nativeDpr: number
}

/**
 * Folds one rAF interval into the state, in place (it runs every frame on a
 * phone, so it allocates nothing in the steady state), and returns it.
 * state.dpr is the ratio to draw at; state.last says why it last changed.
 */
export function stepPacedDpr(
  state: PacedDprState,
  sample: PacedDprSample,
  config: PacedDprConfig = DEFAULT_PACED_DPR_CONFIG,
): PacedDprState {
  const { at, intervalMs, cpuMs, kind } = sample
  const ceiling = ceilingOf(kind, sample.nativeDpr, config)
  const levels = levelsUnder(ceiling, config)

  if (state.kind !== kind) {
    // Another view: its own last ratio, at once and never over its ceiling.
    if (state.kind != null) state.levelByKind[state.kind] = state.dpr
    const first = state.kind == null
    state.kind = kind
    state.lastRaiseAt = null
    const to = snap(levels, state.levelByKind[kind] ?? state.dpr)
    if (to !== state.dpr) change(state, to, at, first ? 'ceiling' : 'kind', config)
    else if (first) state.levelSince = at
    else {
      clearWindow(state)
      state.settleUntil = at + config.settleMs
    }
    return state
  }
  const snapped = snap(levels, state.dpr)
  if (snapped !== state.dpr) {
    // The display's ratio changed under the ceiling (another screen).
    change(state, snapped, at, 'ceiling', config)
    return state
  }

  if (intervalMs > config.gapMs) {
    clearWindow(state)
    return state
  }
  if (at < state.settleUntil) return state

  if (state.lastRaiseAt != null && at - state.lastRaiseAt > config.bounceMs) {
    // The raise held: the next one waits the base dwell again.
    state.dwellMs = config.raiseDwellMs
    state.lastRaiseAt = null
  }

  const { times, intervals, cpuBound } = state
  times.push(at)
  intervals.push(intervalMs)
  cpuBound.push(cpuMs > config.cpuBoundShare * state.vsyncMs)
  let kept = 0
  for (const bound of cpuBound) if (!bound) kept++
  // Trim to the window, but keep minSamples kept intervals when frames are slow.
  while (
    times.length > MAX_WINDOW ||
    (times.length > 0 && times[0] < at - config.windowMs && kept - (cpuBound[0] ? 0 : 1) >= config.minSamples)
  ) {
    if (!cpuBound[0]) kept--
    times.shift()
    intervals.shift()
    cpuBound.shift()
  }
  if (kept < config.minSamples) return state
  if (times.length - kept > kept) {
    // Mostly CPU-bound: the intervals say nothing about the pixel count.
    state.goodSince = null
    return state
  }

  if (scratch.length < kept) scratch = new Float64Array(kept)
  let n = 0
  for (let i = 0; i < intervals.length; i++) if (!cpuBound[i]) scratch[n++] = intervals[i]
  const sorted = scratch.subarray(0, n).sort()
  state.vsyncMs = Math.max(VSYNC_FLOOR_MS, Math.min(state.vsyncMs, percentile(sorted, n, 0.1)))
  const p95 = percentile(sorted, n, 0.95)
  const p99 = percentile(sorted, n, 0.99)

  const index = levels.indexOf(state.dpr)
  if (p95 > config.dropP95 * state.vsyncMs) {
    const down = levels[index + 1]
    if (down == null) {
      state.goodSince = null
      return state
    }
    const bounced = state.lastRaiseAt != null && at - state.lastRaiseAt <= config.bounceMs
    const thermal = at - state.levelSince >= config.heldMs
    if (bounced) state.dwellMs = Math.min(state.dwellMs * 2, config.dwellCapMs)
    if (thermal) state.dwellMs = Math.max(state.dwellMs, config.thermalDwellMs)
    state.lastRaiseAt = null
    change(state, down, at, thermal ? 'thermal' : 'drop', config, p95, p99)
    return state
  }

  const up = index > 0 ? levels[index - 1] : null
  if (up != null && p99 <= config.raiseP99 * state.vsyncMs) {
    state.goodSince ??= at
    if (at - state.goodSince >= state.dwellMs) {
      change(state, up, at, 'raise', config, p95, p99)
      state.lastRaiseAt = at
    }
  } else {
    state.goodSince = null
  }
  return state
}
