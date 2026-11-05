import { describe, expect, it, vi } from 'vitest'
import {
  createPacedDprState,
  DEFAULT_PACED_DPR_CONFIG,
  hasPacedTuning,
  parsePacedDprConfig,
  stepPacedDpr,
  viewKindOf,
  type PacedDprChange,
  type PacedDprConfig,
  type PacedDprState,
  type ViewKind,
} from './paced-dpr'
import { dprControllerMode } from './renderers/AdaptivePixelRatio'

const VSYNC = 1000 / 60

interface Run {
  /** Seconds to run. */
  s: number
  kind?: ViewKind
  native?: number
  /** The display's vsync at a time. */
  vsync?: (at: number) => number
  /** The GPU time at a ratio; the interval is the longest of GPU, CPU and lag, rounded up to whole vsyncs. */
  gpu?: (dpr: number, at: number) => number
  /** The frame's CPU time between the effects (timed). */
  cpu?: (at: number) => number
  /** Main-thread work before the frame's effects start (timed as lag). */
  lag?: (at: number) => number
  /** Main-thread work nothing times (a GC pause the lag misses). */
  hitch?: (at: number) => number
  config?: PacedDprConfig
}

/** Drives the controller frame by frame from `clock.at`, logging every change. */
function sim(state: PacedDprState, clock: { at: number }, log: PacedDprChange[], run: Run) {
  const { kind = 'system', native = 3, vsync = () => VSYNC, gpu = () => 5, cpu = () => 4, lag = () => 0.5, hitch = () => 0 } = run
  const config = run.config ?? DEFAULT_PACED_DPR_CONFIG
  const end = clock.at + run.s * 1000
  let lastCpu = cpu(clock.at)
  while (clock.at < end) {
    const v = vsync(clock.at)
    const lagMs = lag(clock.at)
    const busy = Math.max(gpu(state.dpr, clock.at), lastCpu + lagMs + hitch(clock.at))
    const intervalMs = Math.max(1, Math.ceil(busy / v - 1e-9)) * v
    clock.at += intervalMs
    const before = state.dpr
    stepPacedDpr(state, { at: clock.at, intervalMs, cpuMs: lastCpu, lagMs, kind, nativeDpr: native }, config)
    if (state.dpr !== before && state.last) log.push(state.last)
    lastCpu = cpu(clock.at)
  }
}

function setup(native = 3, start = 2) {
  return { state: createPacedDprState(native, start), clock: { at: 1000 }, log: [] as PacedDprChange[] }
}

/** Every nth call true: a periodic event at about 60/n per second. */
function every(n: number) {
  let i = 0
  return () => ++i % n === 0
}

describe('paced dpr', () => {
  it('climbs 2 -> 3 a step at a time in the system view while frames hold the budget', () => {
    const { state, clock, log } = setup()
    sim(state, clock, log, { s: 40 })
    expect(state.dpr).toBe(3)
    expect(log.map((c) => [c.to, c.reason])).toEqual([
      [2.25, 'raise'],
      [2.5, 'raise'],
      [2.75, 'raise'],
      [3, 'raise'],
    ])
    // Each step waits the settle, a full window and the dwell.
    for (let i = 1; i < log.length; i++) expect(log[i].at - log[i - 1].at).toBeGreaterThanOrEqual(4000 + 750)
  })

  it('stays under the display ratio', () => {
    const { state, clock, log } = setup(2.5, 2)
    sim(state, clock, log, { s: 60, native: 2.5 })
    expect(state.dpr).toBe(2.5)
  })

  it.each<ViewKind>(['close', 'ship', 'demo'])('never raises over 2 in the %s view', (kind) => {
    const { state, clock, log } = setup()
    sim(state, clock, log, { s: 60, kind })
    expect(state.dpr).toBe(2)
    expect(log).toEqual([])
  })

  it('drops fast on sustained 30 fps, a level at a time, down to the floor', () => {
    const { state, clock, log } = setup()
    sim(state, clock, log, { s: 20, kind: 'close', gpu: () => 20 })
    expect(log.map((c) => [c.to, c.reason])).toEqual([
      [1.75, 'fast'],
      [1.5, 'fast'],
    ])
    // 20 intervals of 33 ms, not a 60-sample window.
    expect(log[0].at - 1000).toBeLessThan(1000)
    expect(log[1].at - log[0].at).toBeLessThan(750 + 1000)
    expect(log[0].p50).toBeCloseTo(2 * VSYNC)
    expect(state.dpr).toBe(1.5)
  })

  it('drops on a full window when only some frames miss', () => {
    const { state, clock, log } = setup()
    const miss = every(10)
    sim(state, clock, log, { s: 4, kind: 'close', gpu: () => (miss() ? 20 : 5) })
    expect(log[0]).toMatchObject({ from: 2, to: 1.75, reason: 'drop' })
  })

  it('climbs back to the ceiling once frames fit again', () => {
    const { state, clock, log } = setup()
    const heavyUntil = 1000 + 6000
    sim(state, clock, log, { s: 30, kind: 'close', gpu: (_, at) => (at < heavyUntil ? 20 : 5) })
    expect(log.map((c) => c.to)).toEqual([1.75, 1.5, 1.75, 2])
    expect(state.dpr).toBe(2)
  })

  it('doubles the dwell each time a raise into a 3-vsync level bounces, however slow the frames', () => {
    const { state, clock, log } = setup(3, 2.25)
    // 2.25 fits 60 fps; 2.5 runs at 20 fps.
    sim(state, clock, log, { s: 120, gpu: (dpr) => (dpr >= 2.5 ? 38 : 12) })
    const drops = log.filter((c) => c.from > c.to)
    expect(drops.length).toBeGreaterThanOrEqual(3)
    expect(drops.every((c) => c.bounced && c.to === 2.25)).toBe(true)
    expect(drops.map((c) => c.dwellMs).slice(0, 4)).toEqual([8000, 16000, 32000, 64000].slice(0, Math.min(4, drops.length)))
    // Four bounces at most in two minutes, not one every ~10 s.
    expect(drops.length).toBeLessThanOrEqual(4)
  })

  it('does not count a drop after a gap as the raise bouncing', () => {
    const { state, clock, log } = setup(3, 2.75)
    sim(state, clock, log, { s: 6 })
    expect(state.dpr).toBe(3)
    // Hidden right after the raise, then heavy at 3 when it comes back.
    clock.at += 5000
    stepPacedDpr(state, { at: clock.at, intervalMs: 5000, cpuMs: 4, lagMs: 0.5, kind: 'system', nativeDpr: 3 })
    sim(state, clock, log, { s: 4, gpu: (dpr) => (dpr >= 3 ? 20 : 5) })
    expect(log[1]).toMatchObject({ from: 3, to: 2.75, bounced: false, dwellMs: 4000 })
  })

  it('does not count a drop as a bounce when the raised level ran heldMs without a decision', () => {
    const { state, clock, log } = setup(3, 2.75)
    sim(state, clock, log, { s: 6 })
    expect(state.dpr).toBe(3)
    // 15 s all CPU-bound (no decision), then heavy at 3.
    sim(state, clock, log, { s: 15, cpu: () => 20 })
    sim(state, clock, log, { s: 4, gpu: (dpr) => (dpr >= 3 ? 20 : 5) })
    expect(log[1]).toMatchObject({ from: 3, to: 2.75, reason: 'held', bounced: false, dwellMs: 4000 })
  })

  it('caps the doubled dwell', () => {
    const { state, clock, log } = setup(3, 2.25)
    const config = { ...DEFAULT_PACED_DPR_CONFIG, raiseDwellMs: 1000, dwellCapMs: 4000 }
    sim(state, clock, log, { s: 120, config, gpu: (dpr) => (dpr >= 2.5 ? 20 : 8) })
    expect(Math.max(...log.map((c) => c.dwellMs))).toBe(4000)
  })

  it('reads a drop under creeping CPU time as heat and waits a minute to raise again', () => {
    const { state, clock, log } = setup(3, 3)
    // Fine at 3; from 20 s the CPU slows (4 -> 8 ms over 30 s), and from 50 s frames miss at 3.
    const t = (at: number) => (at - 1000) / 1000
    sim(state, clock, log, {
      s: 150,
      cpu: (at) => 4 + 4 * Math.min(1, Math.max(0, (t(at) - 20) / 30)),
      gpu: (dpr, at) => (t(at) > 50 && dpr >= 3 ? 20 : 8),
    })
    expect(log[0]).toMatchObject({ from: 3, to: 2.75, reason: 'thermal', dwellMs: 60000 })
    const raise = log.find((c) => c.reason === 'raise')!
    expect(raise.at - log[0].at).toBeGreaterThanOrEqual(60000)
  })

  it('labels a drop from a long-held level without heat as held, at the base dwell', () => {
    const { state, clock, log } = setup(3, 3)
    sim(state, clock, log, { s: 30, gpu: (dpr, at) => (at > 21000 && dpr >= 3 ? 20 : 8) })
    expect(log[0]).toMatchObject({ from: 3, to: 2.75, reason: 'held', dwellMs: 4000 })
  })

  it('ignores misses after CPU-bound frames', () => {
    const { state, clock, log } = setup()
    sim(state, clock, log, { s: 20, kind: 'close', gpu: () => 5, cpu: () => 20 })
    expect(log).toEqual([])
    expect(state.dpr).toBe(2)
  })

  it('ignores stalls before the effects (lag) at ~3 a second, and still raises', () => {
    const { state, clock, log } = setup()
    const stall = every(20)
    sim(state, clock, log, { s: 40, lag: () => (stall() ? 25 : 0.5) })
    expect(log.every((c) => c.reason === 'raise')).toBe(true)
    expect(state.dpr).toBe(3)
  })

  it('lets an untimed hitch (GC) under once a window through: no drop, raises still happen', () => {
    const { state, clock, log } = setup()
    const hitch = every(100)
    sim(state, clock, log, { s: 40, hitch: () => (hitch() ? 25 : 0) })
    expect(log.every((c) => c.reason === 'raise')).toBe(true)
    expect(state.dpr).toBe(3)
  })

  it('holds (no raise) while most intervals are CPU-bound', () => {
    const { state, clock, log } = setup()
    let n = 0
    // 2 of 3 frames run long on the CPU; the rest hold the budget.
    sim(state, clock, log, { s: 30, cpu: () => (n++ % 3 ? 20 : 4) })
    expect(log).toEqual([])
  })

  it('goes from 3 in the system view to 2 at close zoom in one step, and back', () => {
    const { state, clock, log } = setup(3, 3)
    sim(state, clock, log, { s: 5 })
    expect(state.dpr).toBe(3)
    sim(state, clock, log, { s: 5, kind: 'close' })
    expect(log).toEqual([expect.objectContaining({ from: 3, to: 2, reason: 'kind' })])
    sim(state, clock, log, { s: 5 })
    expect(state.dpr).toBe(3)
    expect(log[1]).toMatchObject({ from: 2, to: 3, reason: 'kind' })
  })

  it('holds its level when an adaptive display goes from 120 to 60 Hz', () => {
    const { state, clock, log } = setup(3, 3)
    sim(state, clock, log, { s: 120, vsync: (at) => (at < 4000 ? 1000 / 120 : VSYNC) })
    expect(log).toEqual([])
    expect(state.dpr).toBe(3)
  })

  it('judges a 120 Hz display against the 60 fps budget', () => {
    const { state, clock, log } = setup(3, 2)
    // Two 120 Hz vsyncs a frame is 60 fps: it climbs.
    sim(state, clock, log, { s: 40, vsync: () => 1000 / 120, gpu: () => 12 })
    expect(state.dpr).toBe(3)
    // Three (40 fps) is a miss.
    sim(state, clock, log, { s: 3, vsync: () => 1000 / 120, gpu: () => 20 })
    expect(state.dpr).toBeLessThan(3)
    // dprctl=targetHz:120 judges against 120.
    const s120 = setup(3, 2)
    sim(s120.state, s120.clock, s120.log, { s: 5, vsync: () => 1000 / 120, gpu: () => 12, config: { ...DEFAULT_PACED_DPR_CONFIG, targetHz: 120 } })
    expect(s120.log[0]).toMatchObject({ to: 1.75, reason: 'fast' })
  })

  it('empties the window across a gap (a hidden tab) and settles again', () => {
    const state = createPacedDprState(3, 2)
    const at = (i: number) => ({ at: i * VSYNC, intervalMs: VSYNC, cpuMs: 1, lagMs: 0, kind: 'system' as const, nativeDpr: 3 })
    for (let i = 0; i <= 70; i++) stepPacedDpr(state, at(i))
    expect(state.count).toBeGreaterThan(0)
    stepPacedDpr(state, { ...at(0), at: 5000, intervalMs: 3000 })
    expect(state.count).toBe(0)
    expect(state.goodSince).toBeNull()
    expect(state.levelSince).toBe(5000)
    stepPacedDpr(state, { ...at(0), at: 5000 + VSYNC })
    expect(state.count).toBe(0)
  })
})

describe('viewKindOf', () => {
  it('ranks a demo over ship mode over close zoom', () => {
    expect(viewKindOf({ demo: {}, shipMode: true, closeZoom: true })).toBe('demo')
    expect(viewKindOf({ demo: null, shipMode: true, closeZoom: true })).toBe('ship')
    expect(viewKindOf({ demo: null, shipMode: false, closeZoom: true })).toBe('close')
    expect(viewKindOf({ demo: null, shipMode: false, closeZoom: false })).toBe('system')
  })
})

describe('parsePacedDprConfig', () => {
  it('is null without the param', () => {
    expect(parsePacedDprConfig('?quality=low')).toBeNull()
  })

  it('reads off, fixed and tuned keys over the defaults', () => {
    expect(parsePacedDprConfig('?dprctl=targetHz:120')?.targetHz).toBe(120)
    expect(parsePacedDprConfig('?dprctl=off', vi.fn())).toEqual({ ...DEFAULT_PACED_DPR_CONFIG, off: true })
    expect(parsePacedDprConfig('?dprctl=fixed:2.5')?.fixed).toBe(2.5)
    expect(parsePacedDprConfig('?dprctl=raiseDwellMs:1000,heldMs:30000')).toEqual({
      ...DEFAULT_PACED_DPR_CONFIG,
      raiseDwellMs: 1000,
      heldMs: 30000,
    })
    expect(parsePacedDprConfig('?dprctl=')).toEqual(DEFAULT_PACED_DPR_CONFIG)
  })

  it('clamps out-of-range values and skips garbage with a warning', () => {
    const warn = vi.fn()
    const config = parsePacedDprConfig('?dprctl=floor:9,minSamples:2.7,fixed:-1,bogus:3,windowMs:abc,,:,dropP95,%00', warn)
    expect(config).toEqual({ ...DEFAULT_PACED_DPR_CONFIG, floor: 4, minSamples: 5, fixed: 0.5 })
    expect(warn).toHaveBeenCalledTimes(8)
  })
})

describe('hasPacedTuning', () => {
  it('is true only for keys the paced controller reads', () => {
    expect(hasPacedTuning(DEFAULT_PACED_DPR_CONFIG)).toBe(false)
    expect(hasPacedTuning({ ...DEFAULT_PACED_DPR_CONFIG, fixed: 2 })).toBe(false)
    expect(hasPacedTuning({ ...DEFAULT_PACED_DPR_CONFIG, targetHz: 30 })).toBe(true)
  })
})

describe('dprControllerMode', () => {
  it('paces the low tier and keeps the GPU timer path on high', () => {
    expect(dprControllerMode({ low: true, hasTimer: false, config: null })).toBe('paced')
    expect(dprControllerMode({ low: true, hasTimer: true, config: null })).toBe('paced')
    expect(dprControllerMode({ low: false, hasTimer: true, config: null })).toBe('gpu')
    expect(dprControllerMode({ low: false, hasTimer: false, config: null })).toBe('fixed')
  })

  it('fixes the ratio under dprctl=off or fixed:x on either tier', () => {
    const off = { ...DEFAULT_PACED_DPR_CONFIG, off: true }
    const fixed = { ...DEFAULT_PACED_DPR_CONFIG, fixed: 3 }
    expect(dprControllerMode({ low: true, hasTimer: false, config: off })).toBe('fixed')
    expect(dprControllerMode({ low: true, hasTimer: false, config: fixed })).toBe('fixed')
    expect(dprControllerMode({ low: false, hasTimer: true, config: fixed })).toBe('fixed')
    expect(dprControllerMode({ low: true, hasTimer: false, config: DEFAULT_PACED_DPR_CONFIG })).toBe('paced')
  })
})
