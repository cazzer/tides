import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { decodeGlmFlashes, GLM_PACKING } from '../glm'
import { loadGlmBatch, readGlmFile } from './glmFile'

// The first 12 flashes of a real GOES-19 and a real GOES-18 file, and an
// empty one (scripts/build-glm-fixture.py), each with its flashes as
// netCDF4 unpacks them from the files' own attributes: so these check
// GLM_PACKING, which jsfive can't read, for both satellites.
const fixture = (name: string) => {
  const buf = readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}
interface Expected {
  subpointLon: number
  flashes: { lat: number; lon: number; firstS: number; lastS: number; energyJ: number; areaKm2: number }[]
}
const expected = (name: string) =>
  JSON.parse(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), 'utf8')) as Expected
const START = Date.UTC(2026, 10, 13)

const FILES = [
  {
    sat: 'GOES-19',
    nc: 'glm-lcfa-g19-12.nc',
    json: 'glm-lcfa-g19-12.json',
    key: 'GLM-L2-LCFA/2026/317/00/OR_GLM-L2-LCFA_G19_s20263170000000_e20263170000200_c20263170000217.nc',
    subpoint: -75.2,
  },
  {
    sat: 'GOES-18',
    nc: 'glm-lcfa-g18-12.nc',
    json: 'glm-lcfa-g18-12.json',
    key: 'GLM-L2-LCFA/2026/316/22/OR_GLM-L2-LCFA_G18_s20263162200000_e20263162200200_c20263162200219.nc',
    subpoint: -137,
  },
]

afterEach(() => vi.unstubAllGlobals())

describe.each(FILES)('readGlmFile (jsfive), $sat', ({ nc, json, key, subpoint }) => {
  test("reads a real file's flash variables, packed, and its subpoint", () => {
    const raw = readGlmFile(fixture(nc))
    expect(raw.lat.length).toBe(12)
    for (const k of ['lon', 'first', 'last', 'energy', 'area'] as const) expect(raw[k].length).toBe(12)
    expect(raw.subpointLon).toBeCloseTo(subpoint, 4)
    // The one packing jsfive can read agrees with the hard-coded one.
    expect(raw.timePacking).toEqual(GLM_PACKING.time)
  })

  test('decodes to what netCDF4 makes of the same file, from its own attributes', () => {
    const batch = decodeGlmFlashes(readGlmFile(fixture(nc)), key, START)
    const want = [...expected(json).flashes].sort((a, b) => a.firstS - b.firstS)
    expect(batch.count).toBe(want.length)
    want.forEach((f, i) => {
      expect(batch.lat[i]).toBeCloseTo(f.lat, 4)
      expect(batch.lon[i]).toBeCloseTo(f.lon, 4)
      expect(batch.offsetMs[i]).toBeCloseTo(f.firstS * 1000, 1)
      expect(batch.durationMs[i]).toBeCloseTo((f.lastS - f.firstS) * 1000, 1)
      expect(batch.energyJ[i] / f.energyJ).toBeCloseTo(1, 5)
      expect(batch.areaKm2[i] / f.areaKm2).toBeCloseTo(1, 5)
    })
    // GLM's ranges (the full G19 file: offsets -2.2..19.4 s, 1.3e-15..3.5e-12 J, 65..6800 km²).
    for (let i = 0; i < batch.count; i++) {
      expect(batch.offsetMs[i]).toBeGreaterThan(-5000)
      expect(batch.offsetMs[i]).toBeLessThan(20_000)
      expect(batch.energyJ[i]).toBeGreaterThan(1e-15)
      expect(batch.energyJ[i]).toBeLessThan(1e-11)
      expect(batch.areaKm2[i]).toBeGreaterThan(60)
      expect(batch.areaKm2[i]).toBeLessThan(7000)
    }
  })
})

describe('glmFile', () => {
  const key = FILES[0].key

  test('a file with no flashes is an empty batch', () => {
    const raw = readGlmFile(fixture('glm-lcfa-g19-0.nc'))
    expect(raw.lat.length).toBe(0)
    expect(decodeGlmFlashes(raw, key, START).count).toBe(0)
  })

  test('loadGlmBatch fetches, reads and decodes one file', async () => {
    const body = fixture('glm-lcfa-g19-12.nc')
    const fetch = vi.fn(async () => new Response(body))
    vi.stubGlobal('fetch', fetch)
    const batch = await loadGlmBatch({ url: 'https://x/f.nc', key, windowStartMs: START }, new AbortController().signal)
    expect(fetch).toHaveBeenCalledWith('https://x/f.nc', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(batch.count).toBe(expected('glm-lcfa-g19-12.json').flashes.length)
  })

  test('loadGlmBatch rejects on an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    await expect(
      loadGlmBatch({ url: 'https://x/f.nc', key, windowStartMs: START }, new AbortController().signal)
    ).rejects.toThrow('HTTP 503')
  })
})
