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
  /**
   * The settle after a view switch, longer: the switch's own transition
   * (a zoom, new programs) runs heavy for a moment. The first decision after
   * it also needs a full window (no fast drop).
   */
  kindSettleMs: number
  /** A window mostly CPU-bound and missing this long tries one drop, in case the "CPU" is GPU backpressure. */
  cpuProbeMs: number
  /** The probe's drop stays only if the median CPU time fell by this share (the work scaled with pixels). */
  cpuProbeGain: number
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
  kindSettleMs: 1500,
  cpuProbeMs: 3000,
  cpuProbeGain: 0.15,
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
  minSamples: [5, 256],
  dropP95: [1.05, 4],
  missAt: [1, 3],
  raiseMaxMisses: [0, 100],
  fastMinSamples: [5, 256],
  fastSpanMs: [100, 5000],
  raiseDwellMs: [0, 600000],
  dwellCapMs: [0, 3600000],
  heldMs: [0, 600000],
  heatRise: [1, 4],
  heatMs: [1000, 600000],
  thermalDwellMs: [0, 3600000],
  settleMs: [0, 10000],
  kindSettleMs: [0, 10000],
  cpuProbeMs: [500, 600000],
  cpuProbeGain: [0, 0.9],
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
  /** The new ratio; the same as `from` for 'capped' with nothing to restore. */
  to: number
  /**
   * raise; drop (p95 over a full window); fast (the latest intervals' median);
   * held (a drop from a level held heldMs); thermal (a drop under heat);
   * kind (another view); ceiling (the display's ratio); probe (a drop tried
   * while the window is CPU-bound and missing); cpu (the probe didn't lower
   * the CPU time: restored); capped (dropping to the floor didn't shorten the
   * frames, as on a display capped at 30 Hz: restored, and held there).
   */
  reason: 'raise' | 'drop' | 'fast' | 'held' | 'thermal' | 'kind' | 'ceiling' | 'probe' | 'cpu' | 'capped'
  /** Whether a drop undid the raise before it (doubling the dwell). */
  bounced: boolean
  /** The window's kept intervals: count, median, p95 and misses; null for a kind or ceiling change. */
  n: number | null
  p50: number | null
  p95: number | null
  misses: number | null
  /** The window's share of CPU-bound intervals and median CPU time and start lag (all intervals), for the S21 logs. */
  cpuShare: number | null
  cpuMedian: number | null
  lagMedian: number | null
  budgetMs: number
  /** The display's vsync as the window's p10 interval, for the log only. */
  vsyncMs: number | null
  /** The raise dwell after this change. */
  dwellMs: number
}

/** The window never holds more than this many intervals, however many are CPU-bound (minSamples is at most half). */
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
  /**
   * The window, a ring of CAPACITY oldest first from head: each interval's
   * end and length, whether it was CPU-bound, and the CPU time and start lag
   * that came with it.
   */
  times: Float64Array
  intervals: Float64Array
  cpuBound: Uint8Array
  cpu: Float64Array
  lag: Float64Array
  head: number
  count: number
  /** Intervals in the window that aren't CPU-bound. */
  kept: number
  /** The previous frame's start lag: a late start stretches the interval after it. */
  lastLagMs: number
  /** Intervals ending before this are ignored (the last change settling). */
  settleUntil: number
  /** After a view switch: the first decision needs a full window. */
  needFull: boolean
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
  /** Drops that began with every interval long: the level they began at and its median interval, or null. */
  capFrom: number | null
  capP50: number
  /** Held at a level the floor didn't beat (a capped display), at this median interval. */
  capped: boolean
  cappedP50: number
  /** Since when the window has been mostly CPU-bound and missing, or null. */
  cpuMissSince: number | null
  /** A CPU probe in progress: the level it dropped from and the median CPU time before it, or null. */
  cpuProbeFrom: number | null
  cpuProbeMedian: number
  /** No CPU probe before this (thermalDwellMs after one that didn't help). */
  cpuHoldUntil: number
  /** The last change or event, for the log. */
  last: PacedDprChange | null
  /** Paused by capped samples (the idle cap's frames): the next uncapped one restarts the window. */
  paused: boolean
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
    cpu: new Float64Array(CAPACITY),
    lag: new Float64Array(CAPACITY),
    head: 0,
    count: 0,
    kept: 0,
    lastLagMs: 0,
    settleUntil: -Infinity,
    needFull: false,
    goodSince: null,
    dwellMs: config.raiseDwellMs,
    probation: false,
    levelSince: 0,
    cpuEwma: NaN,
    heatRefEwma: null,
    heatRefAt: 0,
    capFrom: null,
    capP50: 0,
    capped: false,
    cappedP50: 0,
    cpuMissSince: null,
    cpuProbeFrom: null,
    cpuProbeMedian: 0,
    cpuHoldUntil: -Infinity,
    last: null,
    paused: false,
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
  state.cpuMissSince = null
  // A raise is judged only by its own level's frames: a gap or a view switch
  // before its first decision leaves it unjudged, not bounced.
  state.probation = false
}

function shift(state: PacedDprState) {
  if (!state.cpuBound[state.head]) state.kept--
  state.head = (state.head + 1) % CAPACITY
  state.count--
}

function push(state: PacedDprState, at: number, intervalMs: number, cpuBound: boolean, cpuMs: number, lagMs: number) {
  if (state.count === CAPACITY) shift(state)
  const i = (state.head + state.count) % CAPACITY
  state.times[i] = at
  state.intervals[i] = intervalMs
  state.cpuBound[i] = cpuBound ? 1 : 0
  state.cpu[i] = cpuMs
  state.lag[i] = lagMs
  state.count++
  if (!cpuBound) state.kept++
}

/** Intervals in the window over `ms`: the kept ones, or all of them. */
function countOver(state: PacedDprState, ms: number, keptOnly: boolean): number {
  let n = 0
  for (let k = 0; k < state.count; k++) {
    const i = (state.head + k) % CAPACITY
    if ((!keptOnly || !state.cpuBound[i]) && state.intervals[i] > ms) n++
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

/** One ring array's values, sorted (kept intervals only, or all): for rare decisions and the log. */
function sortedOf(state: PacedDprState, values: Float64Array, keptOnly: boolean): number[] {
  const out: number[] = []
  for (let k = 0; k < state.count; k++) {
    const i = (state.head + k) % CAPACITY
    if (!keptOnly || !state.cpuBound[i]) out.push(values[i])
  }
  return out.sort((a, b) => a - b)
}

function rank(sorted: number[], q: number): number | null {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null
}

/** Records the window behind a change or event in state.last. */
function record(
  state: PacedDprState,
  to: number,
  at: number,
  reason: PacedDprChange['reason'],
  config: PacedDprConfig,
  bounced = false,
) {
  const budgetMs = 1000 / config.targetHz
  const windowed = reason !== 'kind' && reason !== 'ceiling'
  const sorted = windowed ? sortedOf(state, state.intervals, true) : []
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
    cpuShare: windowed && state.count ? (state.count - state.kept) / state.count : null,
    cpuMedian: windowed ? rank(sortedOf(state, state.cpu, false), 0.5) : null,
    lagMedian: windowed ? rank(sortedOf(state, state.lag, false), 0.5) : null,
    budgetMs,
    vsyncMs: windowed ? rank(sorted, 0.1) : null,
    dwellMs: state.dwellMs,
  }
}

function change(
  state: PacedDprState,
  to: number,
  at: number,
  reason: PacedDprChange['reason'],
  config: PacedDprConfig,
  bounced = false,
) {
  record(state, to, at, reason, config, bounced)
  state.dpr = to
  restart(state, at, config)
}

const DROP_REASONS: ReadonlySet<PacedDprChange['reason']> = new Set(['drop', 'fast', 'held', 'thermal', 'probe'])

/**
 * Whether the controller has stopped climbing, so frames held to the idle
 * cap (tides-0oi.31), which it can't judge, cost it nothing: off or fixed;
 * at the current view's ceiling once the raise there has held a window; after a raise bounced or heat lengthened
 * the dwell (dwellMs over the base); held after a CPU probe or on a capped
 * display; or after a drop, with a full window since that isn't good enough
 * to start a raise. Until then it needs uncapped frames to climb, and the
 * cap waits.
 */
export function pacedDprSettled(state: PacedDprState, config: PacedDprConfig = DEFAULT_PACED_DPR_CONFIG): boolean {
  if (config.off || config.fixed != null) return true
  // A raise not yet judged (its first full window) could still bounce.
  if (state.kind == null || state.levelsKind !== state.kind || state.probation) return false
  if (state.dpr >= state.levels[0] - 1e-9) return true
  if (state.dwellMs > config.raiseDwellMs || state.capped) return true
  const reason = state.last?.reason
  if (reason === 'cpu' || reason === 'capped') return true
  return (
    reason != null &&
    DROP_REASONS.has(reason) &&
    state.kept >= config.minSamples &&
    state.goodSince === null
  )
}

export interface PacedDprSample {
  /** The rAF timestamp of the frame that ends the interval. */
  at: number
  /** at minus the previous frame's timestamp. */
  intervalMs: number
  /** The previous frame's CPU time (its effects, useFrame and draws). */
  cpuMs: number
  /**
   * How late this frame's effects started after its rAF timestamp (other
   * main-thread work). Chrome keeps the timestamp on vsync, so a late start
   * stretches the NEXT interval: the state pairs it with the one after too.
   */
  lagMs: number
  kind: ViewKind
  nativeDpr: number
  /**
   * The idle cap holds this frame (tides-0oi.31): its intervals are the
   * cap's, not the GPU's, so the sample is ignored and the ratio kept.
   */
  capped?: boolean
}

/**
 * Folds one rAF interval into the state, in place, and returns it. It runs
 * every frame on a phone, so it allocates nothing unless the ratio changes
 * or a rare decision (a CPU probe's verdict, a capped display) reads medians.
 * state.dpr is the ratio to draw at; state.last says why it last changed.
 */
export function stepPacedDpr(
  state: PacedDprState,
  sample: PacedDprSample,
  config: PacedDprConfig = DEFAULT_PACED_DPR_CONFIG,
): PacedDprState {
  const { at, intervalMs, cpuMs, kind } = sample
  if (sample.capped) {
    state.paused = true
    return state
  }
  if (state.paused) {
    // Back from the cap: the window starts again from this frame (a view
    // switch at the same time takes the switch's own restart below).
    state.paused = false
    state.lastLagMs = sample.lagMs
    if (kind === state.kind) {
      restart(state, at, config)
      return state
    }
  }
  const lagMs = Math.max(state.lastLagMs, sample.lagMs)
  state.lastLagMs = sample.lagMs
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
    state.capFrom = null
    state.cpuProbeFrom = null
    const to = snap(levels, state.levelByKind[kind] ?? state.dpr)
    if (to !== state.dpr) change(state, to, at, first ? 'ceiling' : 'kind', config)
    else restart(state, at, config)
    if (first) state.settleUntil = -Infinity
    else {
      state.settleUntil = at + config.kindSettleMs
      state.needFull = true
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
    restart(state, at, config)
    return state
  }
  if (at < state.settleUntil) return state

  const cpuBound = cpuMs + lagMs > config.cpuBoundShare * budgetMs
  push(state, at, intervalMs, cpuBound, cpuMs, sample.lagMs)
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

  const index = levels.indexOf(state.dpr)
  const down = index + 1 < levels.length ? levels[index + 1] : null
  const dropMs = config.dropP95 * budgetMs

  if (state.cpuProbeFrom != null && state.count >= config.minSamples) {
    // The probe's verdict: did a level down cut the "CPU" time?
    const median = rank(sortedOf(state, state.cpu, false), 0.5) ?? 0
    const from = state.cpuProbeFrom
    state.cpuProbeFrom = null
    if (median > (1 - config.cpuProbeGain) * state.cpuProbeMedian) {
      // Real CPU work: back to the level, and no probe for a while.
      state.cpuHoldUntil = at + config.thermalDwellMs
      change(state, from, at, 'cpu', config)
      return state
    }
  }

  if (state.count - state.kept > state.kept) {
    // Mostly CPU-bound: the intervals say nothing about the pixel count,
    // unless the CPU time is the GPU pushing back. Missing that long tries
    // one level down.
    state.goodSince = null
    const missing = state.count >= config.minSamples && countOver(state, dropMs, false) > 0.05 * state.count
    if (!missing) state.cpuMissSince = null
    else state.cpuMissSince ??= at
    if (
      missing &&
      down != null &&
      state.cpuProbeFrom == null &&
      at >= state.cpuHoldUntil &&
      at - state.cpuMissSince! >= config.cpuProbeMs
    ) {
      state.cpuProbeFrom = state.dpr
      state.cpuProbeMedian = rank(sortedOf(state, state.cpu, false), 0.5) ?? 0
      change(state, down, at, 'probe', config)
    }
    return state
  }
  state.cpuMissSince = null

  const full = state.kept >= config.minSamples
  const notOver = state.kept - countOver(state, dropMs, true)
  // Every interval long (p10 over the drop line): a display capped below the target, or a view too heavy throughout.
  const allLong = state.kept >= config.fastMinSamples && notOver < 0.1 * state.kept
  if (state.capped) {
    // Held at a capped display's level: stay while frames are no slower than the cap.
    if (!allLong && state.kept >= config.fastMinSamples) state.capped = false
    else if (countOver(state, state.cappedP50 * 1.3, true) * 2 <= state.kept) {
      state.goodSince = null
      return state
    } else state.capped = false
  }

  const fast = !state.needFull && recentMostlyOver(state, at, dropMs, config)
  // p95 over dropMs: more than 5% of the kept intervals are.
  const slow = full && state.kept - notOver > 0.05 * state.kept
  if ((fast || slow) && down == null) {
    if (state.capFrom != null && allLong) {
      // At the floor and no faster than where the drops began: the pixels
      // weren't the limit (a capped display), so take them back and hold.
      const improved = state.kept - countOver(state, state.capP50 - 1, true) > state.kept / 2
      if (!improved) {
        state.capped = true
        state.cappedP50 = state.capP50
        const from = state.capFrom
        state.capFrom = null
        change(state, from, at, 'capped', config)
        return state
      }
    }
    state.capFrom = null
    state.goodSince = null
    return state
  }
  if (fast || slow) {
    if (state.capFrom == null && allLong) {
      state.capFrom = state.dpr
      state.capP50 = rank(sortedOf(state, state.intervals, true), 0.5) ?? 0
    }
    const held = at - state.levelSince >= config.heldMs
    // The raise's first decision, unless the level ran heldMs without one
    // (all CPU-bound): a drop that late isn't the raise's doing.
    const bounced = state.probation && !held
    if (bounced) state.dwellMs = Math.min(state.dwellMs * 2, config.dwellCapMs)
    const heat =
      state.heatRefEwma != null &&
      at - state.heatRefAt >= config.heatMs &&
      state.cpuEwma > state.heatRefEwma * config.heatRise
    if (heat) state.dwellMs = Math.max(state.dwellMs, config.thermalDwellMs)
    state.needFull = false
    change(state, down!, at, heat ? 'thermal' : held ? 'held' : fast ? 'fast' : 'drop', config, bounced)
    return state
  }
  if (!full) return state

  // A full window that doesn't drop: frames fit at this level.
  state.needFull = false
  state.capFrom = null
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
  if (up != null && countOver(state, config.missAt * budgetMs, true) <= config.raiseMaxMisses) {
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
