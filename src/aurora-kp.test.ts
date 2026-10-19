import { describe, expect, test, vi } from 'vitest'
import {
  CARRY_MS,
  createKpFeed,
  kpAt,
  KP_RETRY_MS,
  KP_SETTLE_MS,
  kpSourceFor,
  parseCelestrakKp,
  parseSwpcKp,
  SLOT_MS,
  SWPC_REFRESH_MS,
  type KpSeries,
  type KpSourceKind,
} from './aurora-kp'

const HOUR = 3_600_000
const DAY = 24 * HOUR

// Trimmed from SW-Last5Years.csv (the 2024-05-10/11 G5 storm).
const CELESTRAK = `DATE,BSRN,ND,KP1,KP2,KP3,KP4,KP5,KP6,KP7,KP8,KP_SUM,AP1,AP2,AP3,AP4,AP5,AP6,AP7,AP8,AP_AVG,CP,C9,ISN,F10.7_OBS,F10.7_ADJ,F10.7_DATA_TYPE,F10.7_OBS_CENTER81,F10.7_OBS_LAST81,F10.7_ADJ_CENTER81,F10.7_ADJ_LAST81
2024-05-10,2601,20,27,27,23,20,37,77,87,87,383,12,12,9,7,22,179,300,300,105,1.9,8,172,223.4,227.9,OBS,176.2,162.9,179.6,162.8
2024-05-11,2601,21,90,83,83,90,87,83,77,77,670,400,236,236,400,300,236,179,179,271,2.3,9,173,213.7,218.0,OBS,177.1,163.7,180.5,163.6
2041-08-01,2834,21,,,,,,,,,,,,,,,,,,,,,11,68.4,70.5,PRM,68.7,69.0,70.6,71.1
`

describe('parseCelestrakKp', () => {
  test('reads 8 slots per day, tenths rounded back to thirds', () => {
    const s = parseCelestrakKp(CELESTRAK)
    expect(s.t).toHaveLength(16)
    expect(s.t[0]).toBe(Date.UTC(2024, 4, 10, 0))
    expect(s.t[15]).toBe(Date.UTC(2024, 4, 11, 21))
    expect(s.kp[0]).toBeCloseTo(8 / 3, 5) // 27 → 2+
    expect(s.kp[6]).toBeCloseTo(26 / 3, 5) // 87 → 9-
    expect(s.kp[8]).toBeCloseTo(9, 5)
  })

  test('rejects an unexpected header', () => {
    expect(() => parseCelestrakKp('foo,bar\n1,2')).toThrow()
  })
})

describe('parseSwpcKp', () => {
  test('object rows (current format)', () => {
    const s = parseSwpcKp([
      { time_tag: '2026-10-12T03:00:00', Kp: 2.33, a_running: 9, station_count: 8 },
      { time_tag: '2026-10-12T00:00:00', Kp: 1.67, a_running: 6, station_count: 8 },
      { time_tag: '2026-10-12T06:00:00', Kp: null },
    ])
    expect(Array.from(s.t)).toEqual([Date.UTC(2026, 9, 12, 0), Date.UTC(2026, 9, 12, 3)])
    expect(s.kp[0]).toBeCloseTo(1.67, 5)
  })

  test('header + string rows (older format)', () => {
    const s = parseSwpcKp([
      ['time_tag', 'Kp', 'a_running', 'station_count'],
      ['2024-05-10 00:00:00.000', '2.67', '12', '8'],
      ['2024-05-10 03:00:00.000', '9.00', '400', '8'],
    ])
    expect(Array.from(s.t)).toEqual([Date.UTC(2024, 4, 10, 0), Date.UTC(2024, 4, 10, 3)])
    expect(s.kp[1]).toBe(9)
  })

  test('not an array', () => {
    expect(() => parseSwpcKp({})).toThrow()
  })
})

describe('kpAt', () => {
  const s = parseCelestrakKp(CELESTRAK)
  const may11 = Date.UTC(2024, 4, 11)

  test('slot centre gives the slot value', () => {
    expect(kpAt(s, may11 + 1.5 * HOUR)).toBeCloseTo(9, 5)
  })

  test('interpolates between slot centres', () => {
    // Halfway between the 00 (9) and 03 (8.33) centres.
    expect(kpAt(s, may11 + 3 * HOUR)).toBeCloseTo((9 + 25 / 3) / 2, 5)
  })

  test('the latest slot is carried past its end, then nothing', () => {
    const last = s.t[s.t.length - 1]
    expect(kpAt(s, last + SLOT_MS + CARRY_MS - 1)).toBeCloseTo(s.kp[s.kp.length - 1], 5)
    expect(kpAt(s, last + SLOT_MS + CARRY_MS)).toBeNull()
    expect(kpAt(s, s.t[0] - 1)).toBeNull()
  })

  test('gaps in the data give null', () => {
    const gappy: KpSeries = {
      t: new Float64Array([0, SLOT_MS, 10 * SLOT_MS]),
      kp: new Float32Array([1, 2, 3]),
    }
    expect(kpAt(gappy, 5 * SLOT_MS)).toBeNull()
    // No interpolation across the gap either.
    expect(kpAt(gappy, 1.9 * SLOT_MS)).toBeCloseTo(2, 5)
  })

  test('empty series', () => {
    expect(kpAt({ t: new Float64Array(), kp: new Float32Array() }, 0)).toBeNull()
  })
})

describe('kpSourceFor', () => {
  const now = Date.UTC(2026, 9, 19, 4)
  test.each<[number, KpSourceKind | null]>([
    [now, 'swpc'],
    [now - 6 * DAY, 'swpc'],
    [now - 8 * DAY, 'celestrak-recent'],
    [Date.UTC(2024, 4, 11), 'celestrak-recent'],
    [Date.UTC(2003, 9, 29), 'celestrak-all'],
    [Date.UTC(1950, 0, 1), null],
    [now + DAY, null],
  ])('%i → %s', (sim, kind) => {
    expect(kpSourceFor(sim, now)).toBe(kind)
  })
})

describe('createKpFeed', () => {
  const now = Date.UTC(2026, 9, 19, 4)
  const storm = Date.UTC(2024, 4, 11, 1, 30)
  const flush = () => new Promise((r) => setTimeout(r, 0))

  function setup(impl?: (kind: KpSourceKind) => Promise<KpSeries>) {
    const load = vi.fn(impl ?? (async () => parseCelestrakKp(CELESTRAK)))
    return { load, feed: createKpFeed({ load }) }
  }

  test('first request loads at once; value appears once loaded', async () => {
    const { load, feed } = setup()
    expect(feed.tick(storm, null, 0, now)).toBeNull()
    expect(load).toHaveBeenCalledWith('celestrak-recent')
    await flush()
    expect(feed.tick(storm, null, 16, now)).toBeCloseTo(9, 5)
    expect(load).toHaveBeenCalledTimes(1)
  })

  test('later sources wait to settle, so scrubbing does not download', async () => {
    const { load, feed } = setup()
    feed.tick(storm, null, 0, now)
    await flush()
    const old = Date.UTC(1989, 2, 13)
    feed.tick(old, null, 100, now)
    feed.tick(old, null, 100 + KP_SETTLE_MS - 1, now)
    // Scrubbed back before it settled.
    feed.tick(storm, null, 100 + KP_SETTLE_MS + 10, now)
    feed.tick(old, null, 200 + KP_SETTLE_MS, now)
    expect(load).toHaveBeenCalledTimes(1)
    feed.tick(old, null, 200 + 2 * KP_SETTLE_MS, now)
    expect(load).toHaveBeenLastCalledWith('celestrak-all')
    expect(load).toHaveBeenCalledTimes(2)
  })

  test('a jump looks up and loads for its target only', async () => {
    const { load, feed } = setup()
    feed.tick(now, storm, 0, now)
    expect(load).toHaveBeenCalledWith('celestrak-recent')
    await flush()
    expect(feed.tick(now - 300 * DAY, storm, 10, now)).toBeCloseTo(9, 5)
  })

  test('failures retry after a delay', async () => {
    const { load, feed } = setup(async () => {
      throw new Error('offline')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    feed.tick(storm, null, 0, now)
    await flush()
    feed.tick(storm, null, KP_SETTLE_MS * 2, now)
    expect(load).toHaveBeenCalledTimes(1)
    feed.tick(storm, null, KP_RETRY_MS + 1, now)
    feed.tick(storm, null, KP_RETRY_MS + KP_SETTLE_MS + 2, now)
    expect(load).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  test('SWPC is refreshed while in use; archives are not', async () => {
    const recent: KpSeries = {
      t: new Float64Array([now - 3 * HOUR]),
      kp: new Float32Array([4]),
    }
    const { load, feed } = setup(async () => recent)
    expect(feed.tick(now, null, 0, now)).toBeNull()
    await flush()
    expect(feed.tick(now, null, 10, now)).toBe(4)
    feed.tick(now, null, SWPC_REFRESH_MS + 10, now)
    feed.tick(now, null, SWPC_REFRESH_MS + KP_SETTLE_MS + 20, now)
    expect(load).toHaveBeenCalledTimes(2)
    // The old data keeps answering while the refresh is in flight.
    expect(feed.tick(now, null, SWPC_REFRESH_MS + KP_SETTLE_MS + 30, now)).toBe(4)
  })

  test('future and pre-archive times return null without loading', () => {
    const { load, feed } = setup()
    expect(feed.tick(now + 30 * DAY, null, 0, now)).toBeNull()
    expect(feed.tick(Date.UTC(1900, 0, 1), null, 5000, now)).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })

  test('deactivate discards in-flight results', async () => {
    const { feed } = setup()
    feed.tick(storm, null, 0, now)
    feed.deactivate()
    await flush()
    // Nothing loaded; the next tick starts again.
    expect(feed.tick(storm, null, 10, now)).toBeNull()
  })
})
