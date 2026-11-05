import { describe, expect, it, vi } from 'vitest'
import {
  createPacedDprState,
  DEFAULT_PACED_DPR_CONFIG,
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
  vsync?: number
  /** The GPU time at a ratio; the interval is that rounded up to whole vsyncs. */
  gpu?: (dpr: number, at: number) => number
  /** The frame's CPU time. */
  cpu?: (at: number) => number
  config?: PacedDprConfig
}

/** Drives the controller frame by frame from `clock.at`, logging every change. */
function sim(state: PacedDprState, clock: { at: number }, log: PacedDprChange[], run: Run) {
  const { kind = 'system', native = 3, vsync = VSYNC, gpu = () => 5, cpu = () => 4, config = DEFAULT_PACED_DPR_CONFIG } = run
  const end = clock.at + run.s * 1000
  let lastCpu = cpu(clock.at)
  while (clock.at < end) {
    const intervalMs = Math.max(1, Math.ceil(Math.max(gpu(state.dpr, clock.at), lastCpu) / vsync - 1e-9)) * vsync
    clock.at += intervalMs
    const before = state.dpr
    stepPacedDpr(state, { at: clock.at, intervalMs, cpuMs: lastCpu, kind, nativeDpr: native }, config)
    if (state.dpr !== before && state.last) log.push(state.last)
    lastCpu = cpu(clock.at)
  }
}

function setup(native = 3, start = 2) {
  return { state: createPacedDprState(native, start), clock: { at: 1000 }, log: [] as PacedDprChange[] }
}

describe('paced dpr', () => {
  it('climbs 2 -> 3 a step at a time in the system view while frames hold vsync', () => {
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

  it('drops a level at a time on 33 ms frames, down to the floor', () => {
    const { state, clock, log } = setup()
    sim(state, clock, log, { s: 20, kind: 'close', gpu: () => 20 })
    expect(log.map((c) => [c.to, c.reason])).toEqual([
      [1.75, 'drop'],
      [1.5, 'drop'],
    ])
    expect(log[0].at - 1000).toBeLessThan(2500)
    expect(log[0].p95).toBeCloseTo(2 * VSYNC)
    expect(state.dpr).toBe(1.5)
  })

  it('climbs back to the ceiling once frames fit again', () => {
    const { state, clock, log } = setup()
    const heavyUntil = 1000 + 6000
    sim(state, clock, log, { s: 30, kind: 'close', gpu: (_, at) => (at < heavyUntil ? 20 : 5) })
    expect(log.map((c) => c.to)).toEqual([1.75, 1.5, 1.75, 2])
    expect(state.dpr).toBe(2)
  })

  it('doubles the dwell each time a raise bounces straight back', () => {
    const { state, clock, log } = setup(3, 2.25)
    // Fill-bound: from 2.5 up the frame misses vsync.
    sim(state, clock, log, { s: 60, gpu: (dpr) => (dpr >= 2.5 ? 20 : 8) })
    const raises = log.filter((c) => c.reason === 'raise')
    const drops = log.filter((c) => c.reason === 'drop')
    expect(raises.length).toBeGreaterThanOrEqual(3)
    expect(drops.length).toBeGreaterThanOrEqual(3)
    expect(log.every((c) => c.to <= 2.5)).toBe(true)
    // The dwell before each raise after a bounce: 8 s, 16 s, ...
    expect(raises[1].at - drops[0].at).toBeGreaterThanOrEqual(8000)
    expect(raises[2].at - drops[1].at).toBeGreaterThanOrEqual(16000)
    expect(drops[1].dwellMs).toBe(16000)
  })

  it('caps the doubled dwell', () => {
    const { state, clock, log } = setup(3, 2.25)
    const config = { ...DEFAULT_PACED_DPR_CONFIG, raiseDwellMs: 1000, dwellCapMs: 4000 }
    sim(state, clock, log, { s: 120, config, gpu: (dpr) => (dpr >= 2.5 ? 20 : 8) })
    expect(Math.max(...log.map((c) => c.dwellMs))).toBe(4000)
  })

  it('treats a drop from a level held 10 s as heat and waits a minute to raise again', () => {
    const { state, clock, log } = setup(3, 3)
    // At 3 the phone holds 60 fps for 20 s, then heats and misses at 3 for good.
    const hotAt = 1000 + 20000
    sim(state, clock, log, { s: 120, gpu: (dpr, at) => (at > hotAt && dpr >= 3 ? 20 : 8) })
    expect(log[0]).toMatchObject({ from: 3, to: 2.75, reason: 'thermal' })
    const raise = log.find((c) => c.reason === 'raise')!
    expect(raise.at - log[0].at).toBeGreaterThanOrEqual(60000)
    // Creep, not a 4 s oscillation: at most one more round trip in the 100 s after the heat.
    expect(log.length).toBeLessThanOrEqual(3)
  })

  it('ignores misses after CPU-bound frames', () => {
    const { state, clock, log } = setup()
    sim(state, clock, log, { s: 20, kind: 'close', gpu: () => 5, cpu: () => 20 })
    expect(log).toEqual([])
    expect(state.dpr).toBe(2)
  })

  it('holds (no raise) while most intervals are CPU-bound', () => {
    const { state, clock, log } = setup()
    let n = 0
    // 2 of 3 frames run long on the CPU; the rest hold vsync.
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

  it('finds a 120 Hz vsync and judges frames against it', () => {
    const { state, clock, log } = setup()
    sim(state, clock, log, { s: 40, vsync: 1000 / 120, gpu: () => 4 })
    expect(state.vsyncMs).toBeCloseTo(1000 / 120, 6)
    expect(state.dpr).toBe(3)
    // 60 fps on a 120 Hz display is a miss.
    sim(state, clock, log, { s: 4, vsync: 1000 / 120, gpu: () => 12 })
    expect(state.dpr).toBeLessThan(3)
  })

  it('empties the window across a gap (a hidden tab)', () => {
    const state = createPacedDprState(3, 2)
    stepPacedDpr(state, { at: 0, intervalMs: VSYNC, cpuMs: 1, kind: 'system', nativeDpr: 3 })
    for (let i = 1; i <= 70; i++) stepPacedDpr(state, { at: i * VSYNC, intervalMs: VSYNC, cpuMs: 1, kind: 'system', nativeDpr: 3 })
    expect(state.times.length).toBeGreaterThan(0)
    stepPacedDpr(state, { at: 5000, intervalMs: 3000, cpuMs: 1, kind: 'system', nativeDpr: 3 })
    expect(state.times).toEqual([])
    expect(state.goodSince).toBeNull()
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
