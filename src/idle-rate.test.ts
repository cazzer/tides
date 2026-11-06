import { describe, expect, it } from 'vitest'
import {
  CAMERA_MOVE_PER_S,
  cameraMoving,
  createIdleSchedule,
  IDLE_AFTER_MS,
  IDLE_HZ,
  idleFrameloop,
  idleTick,
  isIdle,
  parseIdleRate,
  type IdleInput,
} from './idle-rate'

describe('parseIdleRate', () => {
  it('is on by default (tides-0oi.41)', () => {
    for (const search of ['', '?other=auto']) expect(parseIdleRate(search)).toEqual({ hz: IDLE_HZ })
  })
  it('is off for any other value', () => {
    for (const search of ['?idlehz=', '?idlehz=off', '?idlehz=60', '?idlehz=on']) expect(parseIdleRate(search)).toBeNull()
  })
  it('caps at 30 Hz with ?idlehz=auto', () => {
    expect(parseIdleRate('?idlehz=auto')).toEqual({ hz: IDLE_HZ })
    expect(IDLE_HZ).toBe(30)
  })
})

describe('idleFrameloop', () => {
  it("keeps R3F's loop ('always') with the cap off, on either tier", () => {
    expect(idleFrameloop(null, true)).toBe('always')
    expect(idleFrameloop(null, false)).toBe('always')
  })
  it("hands the loop to the driver ('never') on the low tier only", () => {
    expect(idleFrameloop(parseIdleRate('?idlehz=auto'), true)).toBe('never')
    expect(idleFrameloop(parseIdleRate('?idlehz=auto'), false)).toBe('always')
    expect(idleFrameloop(parseIdleRate(''), true)).toBe('never')
    expect(idleFrameloop(parseIdleRate(''), false)).toBe('always')
  })
})

describe('isIdle', () => {
  const still: IdleInput = {
    now: 100_000,
    activityAt: 100_000 - IDLE_AFTER_MS,
    timeScale: 1,
    jumping: false,
    demo: false,
    ship: false,
    sceneReady: true,
    openingDone: true,
    dprSettled: true,
    busy: false,
  }
  it('is idle 2 s after the last activity at real time, paused or reversed', () => {
    expect(isIdle(still)).toBe(true)
    expect(isIdle({ ...still, timeScale: 0 })).toBe(true)
    expect(isIdle({ ...still, timeScale: -1 })).toBe(true)
    expect(isIdle({ ...still, activityAt: -Infinity })).toBe(true)
  })
  const cases: [string, Partial<IdleInput>][] = [
    ['within 2 s of activity', { activityAt: still.now - IDLE_AFTER_MS + 1 }],
    ['faster than real time', { timeScale: 2 }],
    ['faster than real time, backwards', { timeScale: -60 }],
    ['while a jump eases', { jumping: true }],
    ['in a demo', { demo: true }],
    ['in ship mode', { ship: true }],
    ['before the scene is ready', { sceneReady: false }],
    ['during the opening move', { openingDone: false }],
    ['while the paced dpr can still climb', { dprSettled: false }],
    ['while per-frame work is queued', { busy: true }],
  ]
  for (const [name, change] of cases) {
    it(`is not idle ${name}`, () => expect(isIdle({ ...still, ...change })).toBe(false))
  }
})

/** Ticks at `hz` with ±4% jitter for `seconds`; returns which ticks drew. */
function ticks(hz: number, seconds: number, idle: (i: number) => boolean = () => true) {
  const schedule = createIdleSchedule()
  const drew: boolean[] = []
  let t = 1000
  for (let i = 0; i < hz * seconds; i++) {
    t += (1000 / hz) * (1 + 0.04 * Math.sin(i * 1.7))
    drew.push(idleTick(schedule, t, idle(i), 1000 / IDLE_HZ))
  }
  return drew
}

describe('idleTick', () => {
  it('draws every tick when not idle', () => {
    expect(ticks(60, 2, () => false).every(Boolean)).toBe(true)
  })
  for (const [hz, every] of [
    [60, 2],
    [120, 4],
  ]) {
    it(`draws exactly every ${every}th tick at ${hz} Hz, idle, under jitter`, () => {
      const drew = ticks(hz, 10)
      expect(drew[0]).toBe(true)
      drew.forEach((d, i) => expect(d).toBe(i % every === 0))
    })
  }
  it('draws the first tick after activity, then resumes the cap from it', () => {
    const drew = ticks(60, 2, (i) => i !== 31)
    expect(drew[30]).toBe(true)
    expect(drew[31]).toBe(true)
    expect(drew[32]).toBe(false)
    expect(drew[33]).toBe(true)
  })
  it('draws after a long gap (a hidden tab), then the next tick waits', () => {
    const schedule = createIdleSchedule()
    const period = 1000 / IDLE_HZ
    expect(idleTick(schedule, 1000, true, period)).toBe(true)
    expect(idleTick(schedule, 1000 + 1000 / 60, true, period)).toBe(false)
    expect(idleTick(schedule, 6000, true, period)).toBe(true)
    // The half tick is capped at a quarter period: the gap doesn't make the next tick due.
    expect(idleTick(schedule, 6000 + 1000 / 60, true, period)).toBe(false)
    expect(idleTick(schedule, 6000 + 2000 / 60, true, period)).toBe(true)
  })
  it('caps a 30 Hz display at its own rate (every tick)', () => {
    expect(ticks(30, 2).every(Boolean)).toBe(true)
  })
})

describe('cameraMoving', () => {
  const frame = 1000 / 30
  it("ignores Earth's spin (close zoom follows it), with room to spare", () => {
    const spin = (2 * Math.PI) / 86164 // rad/s
    expect(cameraMoving(spin * (frame / 1000), 2 * spin * (frame / 1000), frame)).toBe(false)
    expect(CAMERA_MOVE_PER_S).toBeGreaterThan(2e-4)
  })
  it('catches a slow turn or move', () => {
    const turn = ((0.1 * Math.PI) / 180) * (frame / 1000) // 0.1 deg/s
    expect(cameraMoving(turn, 0, frame)).toBe(true)
    expect(cameraMoving(0, 5e-4 * (frame / 1000), frame)).toBe(true)
  })
  it('is still with no time passed', () => {
    expect(cameraMoving(1, 1, 0)).toBe(false)
  })
})
