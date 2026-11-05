import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createIdleDriver,
  idleBusy,
  idleCapHeld,
  markActivity,
  registerIdleBusy,
  reportDprSettled,
  resetIdleState,
  type IdleView,
} from './idle-driver'
import { IDLE_AFTER_MS, IDLE_HZ, sizeActivity, storeActivity } from './idle-rate'

// R3F's global effects, captured so runPaced's before-effect can be stepped by hand.
const effects = vi.hoisted(() => ({ before: [] as ((ts: number) => void)[], after: [] as ((ts: number) => void)[] }))
vi.mock('@react-three/fiber', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-three/fiber')>()),
  addEffect: (cb: (ts: number) => void) => {
    effects.before.push(cb)
    return () => void effects.before.splice(effects.before.indexOf(cb), 1)
  },
  addAfterEffect: (cb: (ts: number) => void) => {
    effects.after.push(cb)
    return () => void effects.after.splice(effects.after.indexOf(cb), 1)
  },
}))

const VSYNC = 1000 / 60
const still: IdleView = { timeScale: 1, jumping: false, demo: false, ship: false, sceneReady: true, openingDone: true }

/** A driver on fake rAF ticks: each frame's (ms, sec) recorded, the clock's elapsedTime kept like R3F's advance. */
function setup(view: () => IdleView = () => still) {
  const clock = { elapsedTime: 0 }
  const frames: { ms: number; sec: number; delta: number }[] = []
  const driver = createIdleDriver({
    periodMs: 1000 / IDLE_HZ,
    view,
    elapsed: () => clock.elapsedTime,
    frame(ms, sec) {
      frames.push({ ms, sec, delta: sec - clock.elapsedTime })
      clock.elapsedTime = sec
    },
  })
  let ts = 10_000
  const run = (n: number) => {
    const drew: (boolean | null)[] = []
    for (let i = 0; i < n; i++) drew.push(driver.tick((ts += VSYNC)))
    return drew
  }
  return { driver, clock, frames, run, now: () => ts }
}

beforeEach(() => resetIdleState())
afterEach(() => resetIdleState())

describe('createIdleDriver', () => {
  it('draws every tick until idle, then every 2nd at 60 Hz', () => {
    const { run, now } = setup()
    markActivity('test', 10_000)
    const busy = run(Math.ceil(IDLE_AFTER_MS / VSYNC) - 1)
    expect(busy.every(Boolean)).toBe(true)
    expect(idleCapHeld()).toBe(false)
    const idle = run(60)
    expect(idle.filter(Boolean).length).toBe(30)
    expect(idleCapHeld()).toBe(true)
    expect(now()).toBeGreaterThan(10_000 + IDLE_AFTER_MS)
  })

  it("hands each frame a delta equal to the time since the last draw", () => {
    const { run, frames } = setup()
    run(120)
    for (const f of frames.slice(1)) expect(f.delta * 1000).toBeCloseTo(2 * VSYNC, 6)
    expect(frames[0].delta).toBe(0)
  })

  it('keeps elapsedTime continuous across setOn and hold, and from an earlier clock (a remount)', () => {
    const { driver, run, frames, clock } = setup()
    clock.elapsedTime = 42
    run(10)
    expect(frames[0].sec).toBe(42)
    driver.setOn(false)
    run(10)
    driver.setOn(true)
    run(10)
    driver.hold(true)
    expect(run(30).every((d) => d === null)).toBe(true)
    driver.hold(false)
    run(10)
    for (let i = 1; i < frames.length; i++) expect(frames[i].sec).toBeGreaterThan(frames[i - 1].sec)
    // Wall time throughout: the frame after the hold covers it in one delta.
    const last = frames[frames.length - 1]
    expect(last.sec - 42).toBeCloseTo((last.ms - frames[0].ms) / 1000, 9)
  })

  it('draws the tick right after an input, then holds full rate for 2 s', () => {
    const { run, now } = setup()
    run(200)
    expect(idleCapHeld()).toBe(true)
    markActivity('pointerdown', now() + 1)
    expect(run(1)).toEqual([true])
    expect(idleCapHeld()).toBe(false)
    expect(run(100).every(Boolean)).toBe(true)
  })

  it('stays at full rate while the paced dpr climbs or per-frame work is queued', () => {
    const { run } = setup()
    reportDprSettled(false)
    expect(run(200).every(Boolean)).toBe(true)
    reportDprSettled(true)
    let queued = 3
    const unregister = registerIdleBusy(() => queued > 0)
    expect(idleBusy()).toBe(true)
    expect(run(60).every(Boolean)).toBe(true)
    queued = 0
    expect(run(60).filter(Boolean).length).toBe(30)
    unregister()
    expect(idleBusy()).toBe(false)
  })

  it('drops the cap when stopped', () => {
    const { driver, run } = setup()
    run(200)
    expect(idleCapHeld()).toBe(true)
    driver.stop()
    expect(idleCapHeld()).toBe(false)
    expect(run(5).every((d) => d === null)).toBe(true)
  })
})

describe('activity', () => {
  it("doesn't count a timestamp-only store change; any other key counts", () => {
    const fn = () => {}
    const previous = { timestamp: 1, timeScale: 1, location: { lat: 0 }, setX: fn }
    expect(storeActivity({ ...previous, timestamp: 2 }, previous)).toBeNull()
    expect(storeActivity(previous, previous)).toBeNull()
    expect(storeActivity({ ...previous, timestamp: 2, timeScale: 0 }, previous)).toBe('timeScale')
    expect(storeActivity({ ...previous, location: { lat: 0 } }, previous)).toBe('location')
  })
  it('counts a canvas resize or a pixel ratio change', () => {
    const size = { width: 390, height: 844 }
    const base = { size, viewport: { dpr: 2 } }
    expect(sizeActivity({ size, viewport: { dpr: 2 } }, base)).toBe(false)
    expect(sizeActivity({ size: { ...size }, viewport: { dpr: 2 } }, base)).toBe(true)
    expect(sizeActivity({ size, viewport: { dpr: 2.25 } }, base)).toBe(true)
  })
})

describe("the paced dpr controller reads the driver's cap (sample.capped)", () => {
  beforeEach(() => {
    vi.stubGlobal('window', { devicePixelRatio: 3, location: { search: '' } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    effects.before.length = 0
    effects.after.length = 0
  })

  it('pauses while the cap holds and restarts its window on the first uncapped frame', async () => {
    const { runPaced } = await import('./renderers/AdaptivePixelRatio')
    const { DEFAULT_PACED_DPR_CONFIG } = await import('./paced-dpr')
    // At the system view's ceiling (3 at native 3), so the controller is settled and the cap may engage.
    const root = { viewport: { dpr: 3 }, setDpr: (dpr: number) => void (root.viewport.dpr = dpr) }
    ;(window as unknown as { __dprctl: unknown }).__dprctl = { config: DEFAULT_PACED_DPR_CONFIG, mode: 'paced', state: null, changes: [] }
    const stop = runPaced(() => root as never, DEFAULT_PACED_DPR_CONFIG)
    const state = () => (window as unknown as { __dprctl: { state: { paused: boolean; count: number } } }).__dprctl.state
    const { run } = setup()
    // The driver's frames run the effects, as R3F's flushGlobalEffects would.
    const drive = (n: number) => {
      for (let i = 0; i < n; i++) {
        const drawn = run(1)[0]
        if (!drawn) continue
        for (const cb of effects.before) cb(performance.now())
        for (const cb of effects.after) cb(performance.now())
      }
    }
    drive(Math.ceil(IDLE_AFTER_MS / VSYNC) + 10)
    expect(idleCapHeld()).toBe(true)
    expect(state().paused).toBe(true)
    markActivity('pointerdown', Infinity)
    drive(1)
    expect(idleCapHeld()).toBe(false)
    expect(state().paused).toBe(false)
    expect(state().count).toBe(0)
    stop()
  })
})
