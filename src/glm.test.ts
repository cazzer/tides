import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AREA_SANE_KM2,
  decodeGlmFlashes,
  GLM_PACKING,
  glmHourPrefix,
  glmKeyStartMs,
  glmKeyWindow,
  glmListUrl,
  glmObjectUrl,
  ownsFlash,
  parseGlmListing,
  SATELLITES,
  WINDOW_MS,
  type GlmRaw,
} from './glm'

const KEY = 'GLM-L2-LCFA/2026/317/00/OR_GLM-L2-LCFA_G19_s20263170000200_e20263170000400_c20263170000419.nc'
const G19 = SATELLITES[0]
const G18 = SATELLITES[1]

// Raw values packing to these real ones.
const pack = (value: number, p: { scale: number; offset: number }) => {
  const u = Math.round((value - p.offset) / p.scale)
  return u > 32767 ? u - 65536 : u
}

function raw(rows: { first: number; last: number; energyJ: number; areaKm2: number; lat?: number; lon?: number }[]): GlmRaw {
  return {
    lat: rows.map((r) => r.lat ?? 10),
    lon: rows.map((r) => r.lon ?? -80),
    first: rows.map((r) => pack(r.first, GLM_PACKING.time)),
    last: rows.map((r) => pack(r.last, GLM_PACKING.time)),
    energy: rows.map((r) => pack(r.energyJ, GLM_PACKING.energy)),
    area: rows.map((r) => pack(r.areaKm2 * 1e6, GLM_PACKING.area)),
    subpointLon: -75.2,
    timePacking: { ...GLM_PACKING.time },
  }
}

afterEach(() => vi.restoreAllMocks())

describe('GLM files', () => {
  test('the satellites and the first day each bucket holds GLM files', () => {
    expect(SATELLITES.map((s) => s.bucket)).toEqual(['noaa-goes19', 'noaa-goes18'])
    expect(glmHourPrefix(G19.fromMs)).toBe('GLM-L2-LCFA/2025/015/00/')
    expect(glmHourPrefix(G18.fromMs)).toBe('GLM-L2-LCFA/2022/262/00/')
  })

  test("an hour's prefix, its listing URL and an object's URL", () => {
    const ms = Date.UTC(2026, 10, 13, 0, 0, 25)
    expect(glmHourPrefix(ms)).toBe('GLM-L2-LCFA/2026/317/00/')
    expect(glmHourPrefix(Date.UTC(2024, 11, 31, 23, 59))).toBe('GLM-L2-LCFA/2024/366/23/')
    expect(glmListUrl(G19, ms)).toBe(
      'https://noaa-goes19.s3.amazonaws.com/?list-type=2&prefix=GLM-L2-LCFA%2F2026%2F317%2F00%2F'
    )
    expect(glmListUrl(G19, ms, KEY)).toBe(
      'https://noaa-goes19.s3.amazonaws.com/?list-type=2&prefix=GLM-L2-LCFA%2F2026%2F317%2F00%2F&start-after=' +
        encodeURIComponent(KEY)
    )
    expect(glmObjectUrl(G18, KEY)).toBe(`https://noaa-goes18.s3.amazonaws.com/${KEY}`)
  })

  test('parses the keys out of an S3 listing', () => {
    const xml = readFileSync(new URL('./__fixtures__/glm-listing.xml', import.meta.url), 'utf8')
    expect(parseGlmListing(xml)).toEqual([
      'GLM-L2-LCFA/2026/317/00/OR_GLM-L2-LCFA_G19_s20263170000000_e20263170000200_c20263170000217.nc',
      KEY,
      'GLM-L2-LCFA/2026/317/00/OR_GLM-L2-LCFA_G19_s20263170000400_e20263170001000_c20263170001017.nc',
    ])
    expect(parseGlmListing('<ListBucketResult></ListBucketResult>')).toEqual([])
  })

  test("a key's start (its _s field) and the 20 s window it covers", () => {
    expect(glmKeyStartMs(KEY)).toBe(Date.UTC(2026, 10, 13, 0, 0, 20))
    expect(glmKeyWindow(KEY)).toBe(Date.UTC(2026, 10, 13, 0, 0, 20) / WINDOW_MS)
    expect(glmKeyStartMs(KEY.replace('_s20263170000200', '_s20263170000205'))).toBe(Date.UTC(2026, 10, 13, 0, 0, 20, 500))
    expect(glmKeyStartMs('nonsense.nc')).toBeNaN()
  })

  test('pins the packing read from the GOES-19 file (jsfive cannot read it)', () => {
    expect(GLM_PACKING).toEqual({
      time: { scale: 0.00038147560553625226, offset: -5 },
      energy: { scale: 9.999959802209943e-16, offset: 2.8514998886357517e-16 },
      area: { scale: 152601.859375, offset: 0 },
    })
  })
})

describe('decodeGlmFlashes', () => {
  const start = Date.UTC(2026, 10, 13)

  test('real units, sorted by first light, owned left to the feed', () => {
    const batch = decodeGlmFlashes(
      raw([
        { first: 12, last: 12.3, energyJ: 2e-13, areaKm2: 500, lat: 25, lon: -90 },
        { first: -1.5, last: -1.2, energyJ: 3e-12, areaKm2: 4000, lat: -5, lon: -60 },
        { first: 3, last: 3.1, energyJ: 1.3e-15, areaKm2: 65, lat: 10, lon: -75 },
      ]),
      KEY,
      start
    )
    expect(batch).toMatchObject({ source: 'glm', key: KEY, startMs: start, count: 3, subpointLon: -75.2 })
    expect([...batch.lat]).toEqual([-5, 10, 25])
    expect([...batch.offsetMs].map((x) => x / 1000)).toEqual([
      expect.closeTo(-1.5, 3),
      expect.closeTo(3, 3),
      expect.closeTo(12, 3),
    ])
    expect(batch.durationMs[0]).toBeCloseTo(300, -1)
    expect(batch.energyJ[0]).toBeCloseTo(3e-12, 15)
    expect(batch.areaKm2[0]).toBeCloseTo(4000, -1)
    expect([...batch.owned]).toEqual([0, 0, 0])
  })

  test("drops energy and area fill values and non-finite rows; a time's raw -1 is 20 s", () => {
    const r = raw([
      { first: 1, last: 1.2, energyJ: 1e-13, areaKm2: 300 },
      { first: 2, last: 2.2, energyJ: 1e-13, areaKm2: 300 },
      { first: 3, last: 3.2, energyJ: 1e-13, areaKm2: 300 },
      { first: 4, last: 4.2, energyJ: 1e-13, areaKm2: 300 },
      { first: 19.9, last: 19.95, energyJ: 1e-13, areaKm2: 300 },
    ])
    ;(r.energy as number[])[0] = -1
    ;(r.area as number[])[1] = -1
    ;(r.lat as number[])[2] = Number.NaN
    ;(r.last as number[])[4] = -1
    const batch = decodeGlmFlashes(r, KEY, start)
    expect(batch.count).toBe(2)
    expect(batch.offsetMs[0]).toBeCloseTo(4000, -1)
    expect(batch.offsetMs[1] + batch.durationMs[1]).toBeCloseTo(20_000, -1)
  })

  test('an area out of range means the packing is wrong: the batch is emptied', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const batch = decodeGlmFlashes(
      raw([
        { first: 1, last: 1.2, energyJ: 1e-13, areaKm2: 300 },
        { first: 2, last: 2.2, energyJ: 1e-13, areaKm2: AREA_SANE_KM2[0] / 4 },
      ]),
      KEY,
      start
    )
    expect(batch.count).toBe(0)
    expect(warn).toHaveBeenCalled()
  })

  test('warns once when a file says its time packing is not GLM_PACKING', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = { ...raw([{ first: 1, last: 1.2, energyJ: 1e-13, areaKm2: 300 }]), timePacking: { scale: 0.001, offset: -5 } }
    decodeGlmFlashes(r, KEY, start)
    decodeGlmFlashes(r, KEY, start)
    expect(warn).toHaveBeenCalledTimes(1)
    decodeGlmFlashes({ ...r, timePacking: { ...GLM_PACKING.time } }, KEY, start)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('ownsFlash', () => {
  test('the satellite nearer the flash in longitude draws it', () => {
    const east = -75.2
    const west = -137
    expect(ownsFlash(-90, east, west, true)).toBe(true)
    expect(ownsFlash(-90, west, east, false)).toBe(false)
    expect(ownsFlash(-120, west, east, false)).toBe(true)
    // Across the antimeridian.
    expect(ownsFlash(170, west, east, false)).toBe(true)
    // A tie goes to the one that wins ties, once.
    const mid = (east + west) / 2
    expect(ownsFlash(mid, east, west, true)).toBe(true)
    expect(ownsFlash(mid, west, east, false)).toBe(false)
  })
})
