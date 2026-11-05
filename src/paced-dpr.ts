// Paced pixel ratio for the low tier (tides-0oi.13). Phones have no GPU timer
// (no EXT_disjoint_timer_query on the Adreno 660), so this reads the rAF
// interval instead: a frame that fits the frame budget (1000 / targetHz)
// arrives within it, one that doesn't arrives a vsync or more later. The S21
// baseline (tides-0oi.1) has ~9 ms of headroom in the system view and none at
// close zoom, so the system view climbs toward the display's ratio (3 on the
// S21, 2 today) while close views stay at 2 and drop only when frames miss.
// Pure: the clock, the store and the canvas live in AdaptivePixelRatio.
//
// Intervals are judged against the fixed budget, not a measured vsync: an
// adaptive-refresh display moving between 120 and 60 Hz doesn't change what
// counts as a miss. An interval also stretches when the main thread is late,
// which no resolution change fixes, so an interval after a frame whose CPU
// time plus start lag took most of the budget is left out, and a window that
// is mostly such intervals decides nothing.

import { dprLevels, maxDpr } from './adaptive-dpr'

export type ViewKind = 'system' | 'close' | 'ship' | 'demo'

export interface PacedDprConfig {
  /** The frame rate frames are judged against: the budget is 1000 / targetHz ms. */
  targetHz: number
  /** The sliding window, stretched to hold minSamples when frames are slow. */
  windowMs: number
  /** Fewer kept intervals than this decide no raise and no ordinary drop. */
  minSamples: number
  /**
   * Drop a level when the window's p95 interval is over this many budgets.
   * Between interval multiples (1 and 1.5 vsyncs at 60 and 120 Hz), so jitter
   * on a whole number of vsyncs can't flip it.
   */
  dropP95: number
  /** An interval over this many budgets is a miss, for the raise. */
  missAt: number
  /** Raise only while a full window holds at most this many misses. */
  raiseMaxMisses: number
  /** The fast drop: the latest kept intervals, at least this many... */
  fastMinSamples: number
  /** ...spanning at least this long, with a median over dropP95 budgets, drop at once. */
  fastSpanMs: number
  /** How long the raise must stay good before it's taken. */
  raiseDwellMs: number
  /** The dwell doubles on each raise undone at its first decision, up to this. */
  dwellCapMs: number
  /** A drop from a level held this long is 'held' (logged; the dwell is unchanged unless it's heat). */
  heldMs: number
  /** Heat: the CPU time's moving average at one ratio and view has risen by this factor... */
  heatRise: number
  /** ...over at least this long. */
  heatMs: number
  /** After a drop under heat the next raise waits at least this long. */
  thermalDwellMs: number
  /** Intervals ignored after a change or a gap: the resize and the first frames at a new size. */
  settleMs: number
  /** An interval this long (a hidden tab, a stall) empties the window. */
  gapMs: number
  /** An interval after a frame whose CPU time plus start lag is over this share of the budget is CPU-bound. */
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
  targetHz: 60,
  windowMs: 1500,
  minSamples: 60,
  dropP95: 1.45,
  missAt: 1.2,
  raiseMaxMisses: 1,
  fastMinSamples: 20,
  fastSpanMs: 500,
  raiseDwellMs: 4000,
  dwellCapMs: 64000,
  heldMs: 10000,
  heatRise: 1.25,
  heatMs: 20000,
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
const INTEGER_KEYS = new Set(['minSamples', 'raiseMaxMisses', 'fastMinSamples'])

/** What each dprctl key may be set to; out-of-range values are clamped. */
const RANGES: Record<NumericKey | 'fixed', [number, number]> = {
  targetHz: [15, 240],
  windowMs: [250, 10000],
  minSamples: [5, 500],
  dropP95: [1.05, 4],
  missAt: [1, 3],
  raiseMaxMisses: [0, 100],
  fastMinSamples: [5, 500],
  fastSpanMs: [100, 5000],
  raiseDwellMs: [0, 600000],
  dwellCapMs: [0, 3600000],
  heldMs: [0, 600000],
  heatRise: [1, 4],
  heatMs: [1000, 600000],
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
    config[key as NumericKey | 'fixed'] = INTEGER_KEYS.has(key) ? Math.round(clamped) : clamped
  }
  return config
}

/** True when the config sets anything only the paced controller reads (for a warning on the high tier). */
export function hasPacedTuning(config: PacedDprConfig): boolean {
  return (Object.keys(RANGES) as (NumericKey | 'fixed')[]).some(
    (key) => key !== 'fixed' && config[key] !== DEFAULT_PACED_DPR_CONFIG[key],
  )
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
  /**
   * raise; drop (p95 over a full window); fast (the latest intervals' median);
   * held (a drop from a level held heldMs); thermal (a drop under heat);
   * kind (another view); ceiling (the display's ratio).
   */
  reason: 'raise' | 'drop' | 'fast' | 'held' | 'thermal' | 'kind' | 'ceiling'
  /** Whether a drop undid the raise before it (doubling the dwell). */
  bounced: boolean
  /** The window's kept intervals: count, median, p95 and misses; null for a kind or ceiling change. */
  n: number | null
  p50: number | null
  p95: number | null
  misses: number | null
  budgetMs: number
  /** The display's vsync as the window's p10 interval, for the log only. */
  vsyncMs: number | null
  /** The raise dwell after this change. */
  dwellMs: number
}

/** The window never holds more than this many intervals, however many are CPU-bound. */
const CAPACITY = 512

export interface PacedDprState {
  dpr: number
  kind: ViewKind | null
  /** The ratio each view last ran at, restored on coming back to it. */
  levelByKind: Partial<Record<ViewKind, number>>
  /** The levels for levelsKind at levelsNative, descending. */
  levels: number[]
  levelsKind: ViewKind | null
  levelsNative: number
  /** The window, a ring of CAPACITY oldest first from head: each interval's end, length and CPU-bound flag. */
  times: Float64Array
  intervals: Float64Array
  cpuBound: Uint8Array
  head: number
  count: number
  /** Intervals in the window that aren't CPU-bound. */
  kept: number
  /** Intervals ending before this are ignored (the last change settling). */
  settleUntil: number
  /** When the raise was first good, or null. */
  goodSince: number | null
  dwellMs: number
  /** A raise not yet judged: its first decision after the settle says whether it bounced. */
  probation: boolean
  /** When the ratio last changed, or the view or a gap reset it. */
  levelSince: number
  /** A moving average of the CPU time per frame at this ratio and view (NaN until a sample)... */
  cpuEwma: number
  /** ...and its value and time at the first full window, the heat reference (null until then). */
  heatRefEwma: number | null
  heatRefAt: number
  /** The change that made the current ratio, for the log. */
  last: PacedDprChange | null
}

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
  for (const level of levels) if (level <= dpr + 1e-9) return level
  return levels[levels.length - 1]
}

export function createPacedDprState(
  _nativeDpr: number,
  startDpr: number,
  config: PacedDprConfig = DEFAULT_PACED_DPR_CONFIG,
): PacedDprState {
  return {
    dpr: startDpr,
    kind: null,
    levelByKind: {},
    levels: [startDpr],
    levelsKind: null,
    levelsNative: NaN,
    times: new Float64Array(CAPACITY),
    intervals: new Float64Array(CAPACITY),
    cpuBound: new Uint8Array(CAPACITY),
    head: 0,
    count: 0,
    kept: 0,
    settleUntil: -Infinity,
    goodSince: null,
    dwellMs: config.raiseDwellMs,
    probation: false,
    levelSince: 0,
    cpuEwma: NaN,
    heatRefEwma: null,
    heatRefAt: 0,
    last: null,
  }
}

/** Empties the window and restarts the level's clocks: after a change, a view switch or a gap. */
function restart(state: PacedDprState, at: number, config: PacedDprConfig) {
  state.head = 0
  state.count = 0
  state.kept = 0
  state.goodSince = null
  state.settleUntil = at + config.settleMs
  state.levelSince = at
  state.cpuEwma = NaN
  state.heatRefEwma = null
  // A raise is judged only by its own level's frames: a gap or a view switch
  // before its first decision leaves it unjudged, not bounced.
  state.probation = false
}

function shift(state: PacedDprState) {
  if (!state.cpuBound[state.head]) state.kept--
  state.head = (state.head + 1) % CAPACITY
  state.count--
}

function push(state: PacedDprState, at: number, intervalMs: number, cpuBound: boolean) {
  if (state.count === CAPACITY) shift(state)
  const i = (state.head + state.count) % CAPACITY
  state.times[i] = at
  state.intervals[i] = intervalMs
  state.cpuBound[i] = cpuBound ? 1 : 0
  state.count++
  if (!cpuBound) state.kept++
}

/** Kept intervals over `ms` in the whole window. */
function keptOver(state: PacedDprState, ms: number): number {
  let n = 0
  for (let k = 0; k < state.count; k++) {
    const i = (state.head + k) % CAPACITY
    if (!state.cpuBound[i] && state.intervals[i] > ms) n++
  }
  return n
}

/**
 * The fast drop's test: walking back from the newest kept interval until
 * fastMinSamples of them span fastSpanMs, are more than half over `ms`?
 * False when the window doesn't reach that far.
 */
function recentMostlyOver(state: PacedDprState, at: number, ms: number, config: PacedDprConfig): boolean {
  let n = 0
  let over = 0
  for (let k = state.count - 1; k >= 0; k--) {
    const i = (state.head + k) % CAPACITY
    if (state.cpuBound[i]) continue
    n++
    if (state.intervals[i] > ms) over++
    if (n >= config.fastMinSamples && at - state.times[i] + state.intervals[i] >= config.fastSpanMs) return over * 2 > n
  }
  return false
}

/** The window's kept intervals, sorted: only for the log, when the ratio changes. */
function keptSorted(state: PacedDprState): number[] {
  const out: number[] = []
  for (let k = 0; k < state.count; k++) {
    const i = (state.head + k) % CAPACITY
    if (!state.cpuBound[i]) out.push(state.intervals[i])
  }
  return out.sort((a, b) => a - b)
}

function rank(sorted: number[], q: number): number | null {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null
}

function change(
  state: PacedDprState,
  to: number,
  at: number,
  reason: PacedDprChange['reason'],
  config: PacedDprConfig,
  bounced = false,
) {
  const budgetMs = 1000 / config.targetHz
  const windowed = reason !== 'kind' && reason !== 'ceiling'
  const sorted = windowed ? keptSorted(state) : []
  state.last = {
    at,
    from: state.dpr,
    to,
    reason,
    bounced,
    n: windowed ? sorted.length : null,
    p50: windowed ? rank(sorted, 0.5) : null,
    p95: windowed ? rank(sorted, 0.95) : null,
    misses: windowed ? sorted.filter((ms) => ms > config.missAt * budgetMs).length : null,
    budgetMs,
    vsyncMs: windowed ? rank(sorted, 0.1) : null,
    dwellMs: state.dwellMs,
  }
  state.dpr = to
  restart(state, at, config)
}

export interface PacedDprSample {
  /** The rAF timestamp of the frame that ends the interval. */
  at: number
  /** at minus the previous frame's timestamp. */
  intervalMs: number
  /** The previous frame's CPU time (its effects, useFrame and draws). */
  cpuMs: number
  /** How late this frame's effects started after its rAF timestamp (other main-thread work). */
  lagMs: number
  kind: ViewKind
  nativeDpr: number
}

/**
 * Folds one rAF interval into the state, in place, and returns it. It runs
 * every frame on a phone, so it allocates nothing unless the ratio changes.
 * state.dpr is the ratio to draw at; state.last says why it last changed.
 */
export function stepPacedDpr(
  state: PacedDprState,
  sample: PacedDprSample,
  config: PacedDprConfig = DEFAULT_PACED_DPR_CONFIG,
): PacedDprState {
  const { at, intervalMs, cpuMs, kind } = sample
  if (kind !== state.levelsKind || sample.nativeDpr !== state.levelsNative) {
    state.levels = levelsUnder(ceilingOf(kind, sample.nativeDpr, config), config)
    state.levelsKind = kind
    state.levelsNative = sample.nativeDpr
  }
  const { levels } = state
  const budgetMs = 1000 / config.targetHz

  if (state.kind !== kind) {
    // Another view: its own last ratio, at once and never over its ceiling.
    if (state.kind != null) state.levelByKind[state.kind] = state.dpr
    const first = state.kind == null
    state.kind = kind
    const to = snap(levels, state.levelByKind[kind] ?? state.dpr)
    if (to !== state.dpr) change(state, to, at, first ? 'ceiling' : 'kind', config)
    else restart(state, at, config)
    if (first) state.settleUntil = -Infinity
    return state
  }
  const snapped = snap(levels, state.dpr)
  if (snapped !== state.dpr) {
    // The display's ratio changed under the ceiling (another screen).
    change(state, snapped, at, 'ceiling', config)
    return state
  }

  if (intervalMs > config.gapMs) {
    restart(state, at, config)
    return state
  }
  if (at < state.settleUntil) return state

  const cpuBound = cpuMs + sample.lagMs > config.cpuBoundShare * budgetMs
  push(state, at, intervalMs, cpuBound)
  if (!cpuBound) {
    const alpha = Math.min(1, intervalMs / 2000)
    state.cpuEwma = Number.isNaN(state.cpuEwma) ? cpuMs : state.cpuEwma + alpha * (cpuMs - state.cpuEwma)
  }
  // Trim to the window, but keep minSamples kept intervals when frames are slow.
  while (
    state.count > 0 &&
    state.times[state.head] < at - config.windowMs &&
    state.kept - (state.cpuBound[state.head] ? 0 : 1) >= config.minSamples
  ) {
    shift(state)
  }
  if (state.count - state.kept > state.kept) {
    // Mostly CPU-bound: the intervals say nothing about the pixel count.
    state.goodSince = null
    return state
  }

  const index = levels.indexOf(state.dpr)
  const down = index + 1 < levels.length ? levels[index + 1] : null
  const dropMs = config.dropP95 * budgetMs
  const full = state.kept >= config.minSamples
  const fast = down != null && recentMostlyOver(state, at, dropMs, config)
  // p95 over dropMs: more than 5% of the kept intervals are.
  const slow = full && down != null && keptOver(state, dropMs) > 0.05 * state.kept
  if (fast || slow) {
    const bounced = state.probation
    if (bounced) state.dwellMs = Math.min(state.dwellMs * 2, config.dwellCapMs)
    const heat =
      state.heatRefEwma != null &&
      at - state.heatRefAt >= config.heatMs &&
      state.cpuEwma > state.heatRefEwma * config.heatRise
    if (heat) state.dwellMs = Math.max(state.dwellMs, config.thermalDwellMs)
    const held = at - state.levelSince >= config.heldMs
    state.probation = false
    change(state, down!, at, heat ? 'thermal' : held ? 'held' : fast ? 'fast' : 'drop', config, bounced)
    return state
  }
  if (!full) return state

  if (state.heatRefEwma == null) {
    state.heatRefEwma = state.cpuEwma
    state.heatRefAt = at
  }
  if (state.probation) {
    // The raise's first full window held: the next one waits the base dwell.
    state.probation = false
    state.dwellMs = config.raiseDwellMs
  }
  const up = index > 0 ? levels[index - 1] : null
  if (up != null && keptOver(state, config.missAt * budgetMs) <= config.raiseMaxMisses) {
    state.goodSince ??= at
    if (at - state.goodSince >= state.dwellMs) {
      change(state, up, at, 'raise', config)
      state.probation = true
    }
  } else {
    state.goodSince = null
  }
  return state
}
