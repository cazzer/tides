import { describe, expect, test } from 'vitest'
import {
  cloudAlpha,
  composeCloudAlpha,
  desiredCloudSource,
  iceWeight,
  initialCloudDayState,
  isRetryable,
  pickEvictions,
  selectCloudSource,
  SETTLE_MS,
  sourceKey,
  stepCloudDay,
  tileUrls,
  utcDayKey,
  type CloudDayState,
} from './real-clouds'

const NOW = Date.UTC(2026, 9, 18, 15, 30)
const VIIRS = 'VIIRS_SNPP_CorrectedReflectance_TrueColor'
const MODIS = 'MODIS_Terra_CorrectedReflectance_TrueColor'

const at = (iso: string) => Date.parse(iso)

describe('selectCloudSource', () => {
  test.each([
    ['1950-06-01T12:00:00Z', { kind: 'static', reason: 'before-coverage' }],
    ['1999-12-31T12:00:00Z', { kind: 'static', reason: 'before-coverage' }],
    ['2000-02-23T23:59:59Z', { kind: 'static', reason: 'before-coverage' }],
    ['2000-02-24T00:00:00Z', { kind: 'gibs', layer: MODIS, date: '2000-02-24' }],
    ['2005-08-28T18:00:00Z', { kind: 'gibs', layer: MODIS, date: '2005-08-28' }],
    ['2015-11-23T23:59:59Z', { kind: 'gibs', layer: MODIS, date: '2015-11-23' }],
    ['2015-11-24T00:00:00Z', { kind: 'gibs', layer: VIIRS, date: '2015-11-24' }],
    ['2024-10-09T18:00:00Z', { kind: 'gibs', layer: VIIRS, date: '2024-10-09' }],
    ['2026-10-17T00:00:00Z', { kind: 'gibs', layer: VIIRS, date: '2026-10-17' }],
    ['2026-10-17T23:59:59Z', { kind: 'gibs', layer: VIIRS, date: '2026-10-17' }],
    ['2026-10-18T00:00:00Z', { kind: 'static', reason: 'after-latest' }],
    ['2026-10-18T15:30:00Z', { kind: 'static', reason: 'after-latest' }],
    ['2030-01-01T00:00:00Z', { kind: 'static', reason: 'after-latest' }],
  ])('%s', (iso, expected) => {
    expect(selectCloudSource(at(iso), NOW)).toEqual(expected)
  })

  test('yesterday follows the wall clock across UTC midnight', () => {
    const sim = at('2026-10-17T12:00:00Z')
    expect(selectCloudSource(sim, at('2026-10-17T23:59:59Z')).kind).toBe('static')
    expect(selectCloudSource(sim, at('2026-10-18T00:00:00Z')).kind).toBe('gibs')
  })

  test('a jump target wins over the tweening clock', () => {
    const mid = at('2010-01-01T00:00:00Z')
    expect(desiredCloudSource(mid, at('1950-01-01T00:00:00Z'), NOW)).toEqual({
      kind: 'static',
      reason: 'before-coverage',
    })
    expect(desiredCloudSource(mid, null, NOW)).toEqual({
      kind: 'gibs',
      layer: MODIS,
      date: '2010-01-01',
    })
  })
})

test('utcDayKey and sourceKey', () => {
  expect(utcDayKey(at('2024-10-09T23:59:59Z'))).toBe('2024-10-09')
  expect(sourceKey({ kind: 'gibs', layer: VIIRS, date: '2024-10-09' })).toBe(
    `${VIIRS}/2024-10-09`
  )
  expect(sourceKey({ kind: 'static', reason: 'after-latest' })).toBe('static:after-latest')
})

test('tileUrls lists the 5x3 level-2 tiles row by row', () => {
  const urls = tileUrls(VIIRS, '2024-10-09')
  expect(urls).toHaveLength(15)
  expect(urls[0]).toBe(
    'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/2024-10-09/250m/2/0/0.jpg'
  )
  expect(urls[4]).toMatch(/\/250m\/2\/0\/4\.jpg$/)
  expect(urls[5]).toMatch(/\/250m\/2\/1\/0\.jpg$/)
  expect(urls[14]).toMatch(/\/250m\/2\/2\/4\.jpg$/)
})

describe('cloudAlpha', () => {
  test('white cloud is opaque', () => {
    expect(cloudAlpha(255, 255, 255)).toBe(255)
  })
  test('ocean is clear', () => {
    expect(cloudAlpha(10, 40, 90)).toBe(0)
  })
  test('tan desert is clear', () => {
    expect(cloudAlpha(220, 180, 120)).toBe(0)
  })
  test('grey cloud is partly opaque', () => {
    const a = cloudAlpha(150, 150, 150)
    expect(a).toBeGreaterThan(50)
    expect(a).toBeLessThan(205)
  })
})

describe('iceWeight', () => {
  test('ice sheets on land count as ice', () => {
    expect(iceWeight(0, 250, 250, 252)).toBe(1) // Antarctica
    expect(iceWeight(10, 235, 240, 245)).toBe(1) // Greenland
  })
  test('water is never ice', () => {
    expect(iceWeight(255, 250, 250, 252)).toBe(0)
  })
  test.each([
    ['Sahara', 210, 170, 110],
    ['Tibet', 150, 130, 100],
    ['Rockies', 120, 110, 90],
    ['forest', 40, 70, 30],
  ])('%s is not ice', (_name, r, g, b) => {
    expect(iceWeight(0, r, g, b)).toBe(0)
  })
})

describe('composeCloudAlpha', () => {
  const run = (gibs: number[], staticAlpha: number[], ice: number[]) => {
    const out = new Uint8ClampedArray(gibs.length)
    composeCloudAlpha(Uint8ClampedArray.from(gibs), staticAlpha, ice, out)
    return Array.from(out)
  }

  test('no-data pixels take the static alpha', () => {
    expect(run([0, 0, 0, 0, 5, 8, 11, 255], [77, 140], [0, 0])).toEqual([
      77, 77, 77, 255, 140, 140, 140, 255,
    ])
  })
  test('cloud stays, ice removes it', () => {
    expect(run([255, 255, 255, 255, 255, 255, 255, 255], [0, 0], [0, 255])).toEqual([
      255, 255, 255, 255, 0, 0, 0, 255,
    ])
  })
})

describe('stepCloudDay', () => {
  const A = 'gibs/2024-10-09'
  const B = 'gibs/2024-10-10'
  const C = 'gibs/2024-10-11'

  test('the first key commits at once', () => {
    const { state, commit } = stepCloudDay(initialCloudDayState, A, 100)
    expect(commit).toBe(A)
    expect(state.committed).toBe(A)
  })

  test('a rollover commits after it settles', () => {
    let s: CloudDayState = stepCloudDay(initialCloudDayState, A, 0).state
    let r = stepCloudDay(s, B, 1000)
    expect(r.commit).toBeNull()
    s = r.state
    r = stepCloudDay(s, B, 1000 + SETTLE_MS - 1)
    expect(r.commit).toBeNull()
    s = r.state
    r = stepCloudDay(s, B, 1000 + SETTLE_MS)
    expect(r.commit).toBe(B)
    expect(r.state).toEqual({ candidate: null, since: 1000 + SETTLE_MS, committed: B })
  })

  test('fast-forward through days never commits', () => {
    let s = stepCloudDay(initialCloudDayState, A, 0).state
    const days = [B, C, 'd', 'e', 'f', 'g']
    for (let frame = 0; frame < 6 * 60; frame++) {
      const r = stepCloudDay(s, days[Math.floor(frame / 60)], frame * 16)
      expect(r.commit).toBeNull()
      s = r.state
    }
    expect(s.committed).toBe(A)
  })

  test('returning to the committed day drops the candidate', () => {
    let s = stepCloudDay(initialCloudDayState, A, 0).state
    s = stepCloudDay(s, B, 100).state
    const r = stepCloudDay(s, A, 200)
    expect(r.commit).toBeNull()
    expect(r.state.candidate).toBeNull()
    expect(stepCloudDay(r.state, B, 300 + SETTLE_MS - 1).commit).toBeNull()
  })

  test('calling twice in a frame commits once and is otherwise a no-op', () => {
    let s = stepCloudDay(initialCloudDayState, A, 0).state
    s = stepCloudDay(s, B, 100).state
    const again = stepCloudDay(s, B, 100)
    expect(again.state).toBe(s)
    const first = stepCloudDay(s, B, 100 + SETTLE_MS)
    expect(first.commit).toBe(B)
    const second = stepCloudDay(first.state, B, 100 + SETTLE_MS)
    expect(second.commit).toBeNull()
    expect(second.state).toBe(first.state)
  })

  test('a jump commits its target, never the days it passes', () => {
    const target = at('1950-01-01T00:00:00Z')
    const key = (sim: number) => sourceKey(desiredCloudSource(sim, target, NOW))
    const from = at('2024-10-09T12:00:00Z')
    let s = stepCloudDay(initialCloudDayState, sourceKey(selectCloudSource(from, NOW)), 0).state
    const commits: string[] = []
    for (let ms = 16; ms <= 5000; ms += 16) {
      const sim = from + ((target - from) * ms) / 5000
      const r = stepCloudDay(s, key(sim), ms)
      if (r.commit) commits.push(r.commit)
      s = r.state
    }
    expect(commits).toEqual(['static:before-coverage'])
  })
})

test('isRetryable', () => {
  expect(isRetryable('timeout')).toBe(true)
  expect(isRetryable('network')).toBe(true)
  expect(isRetryable(503)).toBe(true)
  expect(isRetryable(429)).toBe(true)
  expect(isRetryable(404)).toBe(false)
  expect(isRetryable(400)).toBe(false)
})

describe('pickEvictions', () => {
  const entries = [
    { key: 'a', lastUsed: 1 },
    { key: 'b', lastUsed: 4 },
    { key: 'c', lastUsed: 2 },
    { key: 'd', lastUsed: 3 },
  ]
  test('evicts the least recently used beyond max', () => {
    expect(pickEvictions(entries, null, 3)).toEqual(['a'])
    expect(pickEvictions(entries, null, 2)).toEqual(['a', 'c'])
  })
  test('never evicts the kept key', () => {
    expect(pickEvictions(entries, 'a', 3)).toEqual(['c'])
  })
  test('nothing to do under the limit', () => {
    expect(pickEvictions(entries, null, 4)).toEqual([])
  })
})
