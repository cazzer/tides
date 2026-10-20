import { describe, expect, test } from 'vitest'
import {
  cadenceFor,
  frameAfter,
  frameAtOrBefore,
  HOLD_REFRESH_MS,
  initialPlanState,
  isSteady,
  pickBlend,
  planCloudFrames,
  SETTLE_MS,
  stepCloudPlan,
  type CloudPlan,
  type FrameView,
  type PlanState,
} from './cloud-frames'
import { DAY_MS, type CloudSource } from './real-clouds'

// Latest published slot 14:50; the archive starts 2026-07-21T15:30.
const NOW = Date.UTC(2026, 9, 18, 15, 30)
const MIN = 60_000
const HOUR = 60 * MIN
const VIIRS = 'VIIRS_SNPP_CorrectedReflectance_TrueColor'
const VIIRS_SNOW = 'VIIRS_SNPP_CorrectedReflectance_BandsM11-I2-I1'
const viirs = (date: string) =>
  ({ kind: 'gibs', layer: VIIRS, snowLayer: VIIRS_SNOW, date }) as const
const geo = (time: string, date: string) => ({ kind: 'geo', time, fallback: viirs(date) }) as const

const at = (iso: string) => Date.parse(iso)

describe('cadenceFor', () => {
  test.each([
    [0, 10 * MIN],
    [1, 10 * MIN],
    [3600, 3 * HOUR],
    [86_400, null],
    [2_592_000, null],
  ])('%s', (timeScale, expected) => {
    expect(cadenceFor(timeScale)).toBe(expected)
  })

  test('slow builds stretch the shortest frame', () => {
    expect(cadenceFor(3600, 8400)).toBe(12 * HOUR)
    expect(cadenceFor(1, 8400)).toBe(10 * MIN)
  })
})

describe('isSteady', () => {
  const prev = { simMs: 0, wallMs: 0 }
  test('playback at the clock rate is steady', () => {
    expect(isSteady(prev, 16 * 3600, 16, 3600)).toBe(true)
    expect(isSteady(prev, 16, 16, 1)).toBe(true)
    expect(isSteady(prev, 0, 16, 0)).toBe(true)
  })
  test('a scrub or a jump is not', () => {
    expect(isSteady(prev, 10 * MIN, 16, 0)).toBe(false)
    expect(isSteady(prev, -HOUR, 16, 3600)).toBe(false)
    expect(isSteady(null, 0, 16, 0)).toBe(false)
  })
})

describe('frameAtOrBefore / frameAfter', () => {
  test('geostationary frames on a 3-hour grid', () => {
    const t = at('2026-10-17T12:05:00Z')
    expect(frameAtOrBefore(t, 3 * HOUR, NOW)).toMatchObject({
      timeMs: at('2026-10-17T12:00:00Z'),
      source: geo('2026-10-17T12:00:00Z', '2026-10-17'),
    })
    expect(frameAfter(t, 3 * HOUR, NOW)).toMatchObject({
      timeMs: at('2026-10-17T15:00:00Z'),
      source: geo('2026-10-17T15:00:00Z', '2026-10-17'),
    })
  })

  test('daily composites at noon before the archive', () => {
    const t = at('2024-10-09T06:00:00Z')
    expect(frameAtOrBefore(t, 10 * MIN, NOW)).toMatchObject({
      timeMs: at('2024-10-08T12:00:00Z'),
      source: viirs('2024-10-08'),
    })
    expect(frameAfter(t, 10 * MIN, NOW)).toMatchObject({
      timeMs: at('2024-10-09T12:00:00Z'),
      source: viirs('2024-10-09'),
    })
  })

  test('the archive edge fades from a daily composite to the first slot', () => {
    const t = at('2026-07-21T13:00:00Z')
    expect(frameAtOrBefore(t, 3 * HOUR, NOW).source).toEqual(viirs('2026-07-21'))
    expect(frameAfter(t, 3 * HOUR, NOW)).toMatchObject({
      timeMs: at('2026-07-21T18:00:00Z'),
      source: geo('2026-07-21T18:00:00Z', '2026-07-21'),
    })
  })

  test('past the latest published slot there is nothing to blend towards', () => {
    const t = at('2026-10-18T15:10:00Z')
    expect(frameAtOrBefore(t, 10 * MIN, NOW)).toMatchObject({
      timeMs: at('2026-10-18T14:50:00Z'),
      source: geo('2026-10-18T14:50:00Z', '2026-10-17'),
    })
    expect(frameAfter(t, 10 * MIN, NOW)).toBeNull()
  })

  test('the next frame clamps to the latest slot, and the prefetch dedupes', () => {
    const t = at('2026-10-18T13:00:00Z')
    expect(frameAfter(t, 3 * HOUR, NOW)).toMatchObject({ timeMs: at('2026-10-18T14:50:00Z') })
    const plan = planCloudFrames(t, 3600, NOW)
    expect(plan.frames.map((f) => f.timeMs)).toEqual([
      at('2026-10-18T12:00:00Z'),
      at('2026-10-18T14:50:00Z'),
    ])
  })

  test('never blends towards the static clouds after today', () => {
    expect(frameAfter(at('2026-10-18T22:00:00Z'), 3 * HOUR, NOW)).toBeNull()
    const tomorrow = at('2026-10-19T01:00:00Z')
    expect(frameAtOrBefore(tomorrow, 3 * HOUR, NOW).source).toEqual({
      kind: 'static',
      reason: 'after-latest',
    })
    expect(frameAfter(tomorrow, 3 * HOUR, NOW)).toBeNull()
  })

  test('static before MODIS, with nothing after it', () => {
    const t = at('1999-12-31T12:00:00Z')
    expect(frameAtOrBefore(t, 10 * MIN, NOW).source).toEqual({
      kind: 'static',
      reason: 'before-coverage',
    })
    expect(frameAfter(t, 10 * MIN, NOW)).toBeNull()
  })

  test('a 1-day cadence in the archive uses the midnight slots', () => {
    const t = at('2026-10-17T05:00:00Z')
    expect(frameAtOrBefore(t, DAY_MS, NOW).source).toEqual(geo('2026-10-17T00:00:00Z', '2026-10-17'))
    expect(frameAfter(t, DAY_MS, NOW)?.source).toEqual(geo('2026-10-18T00:00:00Z', '2026-10-17'))
  })
})

describe('planCloudFrames', () => {
  const t = at('2026-10-17T12:05:00Z')

  test('paused: the bracket, no prefetch', () => {
    const plan = planCloudFrames(t, 0, NOW)
    expect(plan).toMatchObject({ mode: 'bracket', cadenceMs: 10 * MIN })
    expect(plan.frames.map((f) => f.timeMs)).toEqual([
      at('2026-10-17T12:00:00Z'),
      at('2026-10-17T12:10:00Z'),
    ])
  })

  test('real time: the bracket and one prefetch', () => {
    const plan = planCloudFrames(t, 1, NOW)
    expect(new Set(plan.frames.map((f) => f.key)).size).toBe(3)
    expect(plan.frames[2].timeMs).toBe(at('2026-10-17T12:20:00Z'))
  })

  test('a day per second holds the frame of the moment', () => {
    expect(planCloudFrames(t, 86_400, NOW)).toEqual({
      mode: 'hold',
      frames: [
        {
          key: expect.any(String),
          timeMs: t,
          source: geo('2026-10-17T12:00:00Z', '2026-10-17'),
        },
      ],
    })
  })
})

describe('stepCloudPlan', () => {
  const plan = (iso: string, timeScale = 0) => planCloudFrames(at(iso), timeScale, NOW)
  const idle = { jumping: false, settled: false, steady: true }
  const committed = (p: CloudPlan, wall = 0): PlanState =>
    stepCloudPlan(initialPlanState, p, wall, idle).state

  test('the first plan commits at once', () => {
    const p = plan('2026-10-17T12:05:00Z')
    const r = stepCloudPlan(initialPlanState, p, 100, idle)
    expect(r.commit).toBe(p)
    expect(r.state.committed).toBe(p)
  })

  test('the same frames again change nothing, down to the object', () => {
    const s = committed(plan('2026-10-17T12:05:00Z'))
    const r = stepCloudPlan(s, plan('2026-10-17T12:07:00Z'), 50, idle)
    expect(r.commit).toBeNull()
    expect(r.state).toBe(s)
  })

  test('the next step along commits at once and aborts nothing', () => {
    const s = committed(plan('2026-10-17T12:05:00Z', 1))
    const next = plan('2026-10-17T12:15:00Z', 1)
    expect(stepCloudPlan(s, next, 16, idle)).toMatchObject({ commit: next, abortUnwanted: false })
  })

  test('a scrub to the next frames settles like a jump', () => {
    const s = committed(plan('2026-10-17T12:05:00Z'))
    const scrubbed = plan('2026-10-17T12:15:00Z')
    const scrub = { ...idle, steady: false }
    const r = stepCloudPlan(s, scrubbed, 16, scrub)
    expect(r.commit).toBeNull()
    expect(stepCloudPlan(r.state, scrubbed, 16 + SETTLE_MS, scrub)).toMatchObject({
      commit: scrubbed,
      abortUnwanted: true,
    })
  })

  test('a jump settles for SETTLE_MS, then commits and aborts the rest', () => {
    let s = committed(plan('2026-10-17T12:05:00Z'))
    const target = plan('2024-10-09T12:00:00Z')
    let r = stepCloudPlan(s, target, 1000, idle)
    expect(r.commit).toBeNull()
    s = r.state
    const again = stepCloudPlan(s, target, 1000 + SETTLE_MS - 1, idle)
    expect(again.commit).toBeNull()
    expect(again.state).toBe(s)
    r = stepCloudPlan(s, target, 1000 + SETTLE_MS, idle)
    expect(r).toMatchObject({ commit: target, abortUnwanted: true })
  })

  test('a candidate that moves on keeps its start', () => {
    let s = committed(plan('2026-10-17T12:05:00Z'))
    s = stepCloudPlan(s, plan('2026-09-01T12:05:00Z'), 1000, idle).state
    s = stepCloudPlan(s, plan('2026-09-01T12:15:00Z'), 2000, idle).state
    expect(s.since).toBe(1000)
    const r = stepCloudPlan(s, plan('2026-09-01T12:25:00Z'), 1000 + SETTLE_MS, idle)
    expect(r.commit).not.toBeNull()
  })

  test('a rate change settles first', () => {
    const s = committed(plan('2026-10-17T12:05:00Z', 1))
    const faster = plan('2026-10-17T12:05:00Z', 3600)
    expect(stepCloudPlan(s, faster, 16, idle).commit).toBeNull()
    const r = stepCloudPlan(stepCloudPlan(s, faster, 16, idle).state, faster, 16 + SETTLE_MS, idle)
    expect(r.commit).toBe(faster)
  })

  test('a held frame refreshes only after HOLD_REFRESH_MS, once loaded', () => {
    const s = committed(plan('2026-09-01T12:00:00Z', 86_400))
    const later = plan('2026-09-05T12:00:00Z', 86_400)
    expect(stepCloudPlan(s, later, HOLD_REFRESH_MS - 1, { jumping: false, settled: true, steady: true }).commit).toBeNull()
    expect(stepCloudPlan(s, later, HOLD_REFRESH_MS, { jumping: false, settled: false, steady: true }).commit).toBeNull()
    expect(stepCloudPlan(s, later, HOLD_REFRESH_MS, { jumping: false, settled: true, steady: true })).toMatchObject({
      commit: later,
      abortUnwanted: false,
    })
  })
})

describe('pickBlend', () => {
  const source: CloudSource = viirs('2024-10-09')
  const frame = (
    timeMs: number,
    status: FrameView<string>['status'],
    texture: string | null = status === 'ready' ? `t${timeMs}` : null
  ): FrameView<string> => ({ key: `k${timeMs}`, timeMs, source, status, texture })

  test('mixes the frames either side, clamped', () => {
    const frames = [frame(0, 'ready'), frame(100, 'ready')]
    expect(pickBlend(frames, 25)).toEqual({ a: 't0', b: 't100', mix: 0.25 })
    expect(pickBlend(frames, 0)).toEqual({ a: 't0', b: 't100', mix: 0 })
    expect(pickBlend(frames, 150)).toEqual({ a: 't100', b: 't100', mix: 0 })
  })

  test('one side alone shows that frame', () => {
    expect(pickBlend([frame(0, 'ready'), frame(100, 'loading')], 50)).toEqual({ a: 't0', b: 't0', mix: 0 })
    expect(pickBlend([frame(0, 'loading'), frame(100, 'ready')], 50)).toEqual({
      a: 't100',
      b: 't100',
      mix: 0,
    })
  })

  test('static once every frame failed, nothing while they load', () => {
    expect(pickBlend([frame(0, 'failed'), frame(100, 'failed')], 50)).toEqual({
      a: 'static',
      b: 'static',
      mix: 0,
    })
    expect(pickBlend([frame(0, 'failed'), frame(100, 'loading')], 50)).toBeNull()
    expect(pickBlend([], 50)).toBeNull()
  })

  test('skips a frame still loading in the middle', () => {
    const frames = [frame(0, 'ready'), frame(100, 'loading'), frame(200, 'ready')]
    expect(pickBlend(frames, 150)).toEqual({ a: 't0', b: 't200', mix: 0.75 })
  })

  test('a static frame shows the static clouds', () => {
    const still: FrameView<string> = {
      key: 'static:after-latest',
      timeMs: 0,
      source: { kind: 'static', reason: 'after-latest' },
      status: 'ready',
      texture: null,
    }
    expect(pickBlend([still], 10)).toEqual({ a: 'static', b: 'static', mix: 0 })
  })
})
