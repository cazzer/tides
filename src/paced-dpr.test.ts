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
  /** Main-thread work before the frame's effects start (timed as lag; Chrome: it stretches the next interval). */
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
  let lastLag = 0.5
  while (clock.at < end) {
    const v = vsync(clock.at)
    // The previous frame started lastLag late and ran lastCpu: this interval is the longer of that and the GPU.
    const busy = Math.max(gpu(state.dpr, clock.at), lastCpu + lastLag + hitch(clock.at))
    const intervalMs = Math.max(1, Math.ceil(busy / v - 1e-9)) * v
    clock.at += intervalMs
    const lagMs = lag(clock.at)
    const before = state.last
    stepPacedDpr(state, { at: clock.at, intervalMs, cpuMs: lastCpu, lagMs, kind, nativeDpr: native }, config)
    if (state.last !== before && state.last) log.push(state.last)
    lastCpu = cpu(clock.at)
    lastLag = lagMs
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
    // Fill-bound: 28 ms at 2, 21 at 1.75, 16 at 1.5.
    sim(state, clock, log, { s: 20, kind: 'close', gpu: (dpr) => 28 * (dpr / 2) ** 2 })
    expect(log.slice(0, 2).map((c) => [c.to, c.reason])).toEqual([
      [1.75, 'fast'],
      [1.5, 'fast'],
    ])
    // Raises back to 1.75 bounce.
    expect(log.slice(2).filter((c) => c.to === 1.5).every((c) => c.bounced)).toBe(true)
    // 20 intervals of 33 ms, not a 60-sample window.
    expect(log[0].at - 1000).toBeLessThan(1000)
    expect(log[1].at - log[0].at).toBeLessThan(750 + 1000)
    expect(log[0].p50).toBeCloseTo(2 * VSYNC)
    expect(log[log.length - 1].to).toBe(log[log.length - 1].reason === 'raise' ? 1.75 : 1.5)
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
    sim(state, clock, log, { s: 30, kind: 'close', gpu: (dpr, at) => (at < heavyUntil ? 28 * (dpr / 2) ** 2 : 5) })
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
    // 15 s all CPU-bound (no decision, no probe), then heavy at 3.
    const config = { ...DEFAULT_PACED_DPR_CONFIG, cpuProbeMs: 600000 }
    sim(state, clock, log, { s: 15, cpu: () => 20, config })
    sim(state, clock, log, { s: 4, gpu: (dpr) => (dpr >= 3 ? 20 : 5), config })
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

  it('ignores misses after CPU-bound frames: one probe, restored, then a long hold', () => {
    const { state, clock, log } = setup()
    sim(state, clock, log, { s: 60, kind: 'close', gpu: () => 5, cpu: () => 20 })
    expect(log.map((c) => [c.from, c.to, c.reason])).toEqual([
      [2, 1.75, 'probe'],
      [1.75, 2, 'cpu'],
    ])
    expect(log[1].cpuShare).toBeGreaterThan(0.5)
    expect(log[1].cpuMedian).toBeCloseTo(20)
    expect(state.dpr).toBe(2)
  })

  it('keeps a probe drop when the "CPU" time scales with pixels (GPU backpressure)', () => {
    const { state, clock, log } = setup()
    // The main thread blocks in WebGL calls for the GPU: 20 ms at 2, 15.3 at 1.75.
    sim(state, clock, log, { s: 30, kind: 'close', gpu: () => 5, cpu: () => 20 * (state.dpr / 2) ** 2 })
    expect(log.map((c) => c.reason)).toEqual(['probe'])
    expect(state.dpr).toBe(1.75)
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
    expect(log.every((c) => c.reason === 'probe' || c.reason === 'cpu')).toBe(true)
    expect(state.dpr).toBe(2)
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

  it('restores and holds on a display capped at 30 Hz (iOS Low Power Mode), cheap frames', () => {
    const { state, clock, log } = setup()
    sim(state, clock, log, { s: 120, vsync: () => 2 * VSYNC, gpu: () => 3 })
    expect(log.map((c) => [c.to, c.reason])).toEqual([
      [1.75, 'fast'],
      [1.5, 'fast'],
      [2, 'capped'],
    ])
    expect(log[2].at - 1000).toBeLessThan(5000)
    expect(state.capped).toBe(true)
    // The cap lifts: frames fit again and it climbs.
    sim(state, clock, log, { s: 30 })
    expect(state.capped).toBe(false)
    expect(state.dpr).toBeGreaterThan(2)
  })

  it('keeps the floor when it shortened the frames (pixels were the limit)', () => {
    const { state, clock, log } = setup()
    // 50 ms at 2 (3 vsyncs), 33 at 1.5: still missing at the floor, but faster.
    sim(state, clock, log, { s: 20, kind: 'close', gpu: (dpr) => 45 * (dpr / 2) ** 2 })
    expect(log.map((c) => c.reason)).toEqual(['fast', 'fast'])
    expect(state.dpr).toBe(1.5)
  })

  it('rides out a view switch\'s heavy transition without a drop', () => {
    const { state, clock, log } = setup(3, 3)
    sim(state, clock, log, { s: 5 })
    const switchAt = clock.at
    // 1.3 s of 30 fps right after zooming in, then fine.
    sim(state, clock, log, { s: 15, kind: 'close', gpu: (_, at) => (at - switchAt < 1300 ? 20 : 5) })
    expect(log.map((c) => [c.to, c.reason])).toEqual([[2, 'kind']])
  })

  it('needs a full window for the first decision after a view switch', () => {
    const { state, clock, log } = setup(3, 3)
    sim(state, clock, log, { s: 5 })
    const switchAt = clock.at
    sim(state, clock, log, { s: 10, kind: 'close', gpu: (dpr) => 28 * (dpr / 2) ** 2 })
    expect(log[1]).toMatchObject({ to: 1.75, reason: 'drop', n: 60 })
    expect(log[1].at - switchAt).toBeGreaterThan(1500 + 60 * VSYNC)
  })

  it('clears a raise\'s probation on a view switch', () => {
    const { state, clock, log } = setup(3, 2.75)
    sim(state, clock, log, { s: 6 })
    expect(state.probation).toBe(true)
    sim(state, clock, log, { s: 0.2, kind: 'close' })
    expect(state.probation).toBe(false)
    sim(state, clock, log, { s: 6, kind: 'close', gpu: (dpr) => 28 * (dpr / 2) ** 2 })
    expect(log.find((c) => c.reason === 'drop' || c.reason === 'fast')).toMatchObject({ bounced: false })
  })

  it('raises past an untimed hitch a second only with raiseMaxMisses 2', () => {
    for (const [misses, climbs] of [
      [1, false],
      [2, true],
    ] as const) {
      const { state, clock, log } = setup()
      const hitch = every(60)
      const config = { ...DEFAULT_PACED_DPR_CONFIG, raiseMaxMisses: misses }
      sim(state, clock, log, { s: 30, config, hitch: () => (hitch() ? 25 : 0) })
      expect(log.some((c) => c.reason === 'raise')).toBe(climbs)
      expect(log.every((c) => c.reason === 'raise')).toBe(true)
    }
  })

  it('fast-drops only when more than half the latest intervals miss', () => {
    const state = createPacedDprState(3, 2)
    const config = { ...DEFAULT_PACED_DPR_CONFIG, settleMs: 0 }
    let at = 1000
    const step = (intervalMs: number) => {
      at += intervalMs
      stepPacedDpr(state, { at, intervalMs, cpuMs: 2, lagMs: 0, kind: 'close', nativeDpr: 3 }, config)
    }
    step(VSYNC)
    // 20 intervals over 500 ms, exactly half over the drop line.
    for (let i = 0; i < 10; i++) {
      step(2 * VSYNC)
      step(VSYNC)
    }
    expect(state.dpr).toBe(2)
    step(2 * VSYNC)
    step(2 * VSYNC)
    expect(state.dpr).toBe(1.75)
    expect(state.last?.reason).toBe('fast')
  })

  it('keeps the ring consistent at capacity', () => {
    const state = createPacedDprState(3, 2)
    let at = 1000
    for (let i = 0; i < 3000; i++) {
      at += 1000 / 120
      const cpuMs = i % 10 < 9 ? 14 : 3
      stepPacedDpr(state, { at, intervalMs: 1000 / 120, cpuMs, lagMs: 0, kind: 'system', nativeDpr: 3 })
    }
    expect(state.count).toBe(512)
    let kept = 0
    for (let k = 0; k < state.count; k++) if (!state.cpuBound[(state.head + k) % 512]) kept++
    expect(kept).toBe(state.kept)
    for (let k = 1; k < state.count; k++) {
      expect(state.times[(state.head + k) % 512]).toBeGreaterThan(state.times[(state.head + k - 1) % 512])
    }
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

describe('paced dpr under the idle cap (tides-0oi.31)', () => {
  const sample = (at: number, intervalMs: number, capped: boolean) => ({
    at,
    intervalMs,
    cpuMs: 4,
    lagMs: 0.5,
    kind: 'system' as ViewKind,
    nativeDpr: 3,
    capped,
  })

  it('leaves the state unchanged for capped samples, however long they run', () => {
    const { state, clock, log } = setup(3, 2)
    sim(state, clock, log, { s: 30, gpu: () => 6 })
    const dpr = state.dpr
    const count = state.count
    const settleUntil = state.settleUntil
    // 60 s of 30 Hz frames, every one a 'miss' at the 60 Hz target.
    for (let i = 0; i < 1800; i++) {
      clock.at += 1000 / 30
      stepPacedDpr(state, sample(clock.at, 1000 / 30, true))
    }
    expect(state.dpr).toBe(dpr)
    expect(state.count).toBe(count)
    expect(state.settleUntil).toBe(settleUntil)
    expect(state.paused).toBe(true)
  })

  it('restarts the window on the first uncapped sample, then settles and keeps the ratio at 60 Hz', () => {
    const { state, clock, log } = setup(3, 2)
    sim(state, clock, log, { s: 30, gpu: () => 6 })
    const dpr = state.dpr
    for (let i = 0; i < 300; i++) {
      clock.at += 1000 / 30
      stepPacedDpr(state, sample(clock.at, 1000 / 30, true))
    }
    clock.at += 1000 / 60
    stepPacedDpr(state, sample(clock.at, 1000 / 60, false))
    expect(state.paused).toBe(false)
    expect(state.count).toBe(0)
    expect(state.settleUntil).toBe(clock.at + DEFAULT_PACED_DPR_CONFIG.settleMs)
    const changes = log.length
    sim(state, clock, log, { s: 30, gpu: () => 6 })
    expect(state.dpr).toBe(dpr)
    expect(log.slice(changes).filter((c) => c.reason === 'drop' || c.reason === 'fast')).toEqual([])
    expect(state.count).toBeGreaterThan(0)
  })

  it('would drop at 30 Hz frames without the flag', () => {
    const { state, clock, log } = setup(3, 2)
    sim(state, clock, log, { s: 30, gpu: () => 6 })
    const dpr = state.dpr
    for (let i = 0; i < 1800; i++) {
      clock.at += 1000 / 30
      stepPacedDpr(state, sample(clock.at, 1000 / 30, false))
    }
    expect(state.dpr).toBeLessThan(dpr)
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
    expect(parsePacedDprConfig('?dprctl=minSamples:1000', vi.fn())?.minSamples).toBe(256)
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
