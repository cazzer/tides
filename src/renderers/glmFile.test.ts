import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { decodeGlmFlashes, GLM_PACKING } from '../glm'
import { loadGlmBatch, readGlmFile } from './glmFile'

// The first 12 flashes of a real GOES-19 file and an empty one
// (scripts/build-glm-fixture.py), with the flashes the script decoded.
const fixture = (name: string) => {
  const buf = readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}
const expected = JSON.parse(readFileSync(new URL('../__fixtures__/glm-lcfa-g19-12.json', import.meta.url), 'utf8')) as {
  subpointLon: number
  flashes: { lat: number; lon: number; firstS: number; lastS: number; energyJ: number; areaKm2: number }[]
}
const KEY = 'GLM-L2-LCFA/2026/317/00/OR_GLM-L2-LCFA_G19_s20263170000000_e20263170000200_c20263170000217.nc'
const START = Date.UTC(2026, 10, 13)

afterEach(() => vi.unstubAllGlobals())

describe('readGlmFile (jsfive)', () => {
  test("reads a real file's flash variables, packed, and its subpoint", () => {
    const raw = readGlmFile(fixture('glm-lcfa-g19-12.nc'))
    expect(raw.lat.length).toBe(12)
    for (const k of ['lon', 'first', 'last', 'energy', 'area'] as const) expect(raw[k].length).toBe(12)
    expect(raw.subpointLon).toBeCloseTo(-75.2, 4)
    // The one packing jsfive can read agrees with the hard-coded one.
    expect(raw.timePacking).toEqual(GLM_PACKING.time)
  })

  test('decodes to what netCDF4 makes of the same file', () => {
    const batch = decodeGlmFlashes(readGlmFile(fixture('glm-lcfa-g19-12.nc')), KEY, START)
    const want = [...expected.flashes].sort((a, b) => a.firstS - b.firstS)
    expect(batch.count).toBe(want.length)
    want.forEach((f, i) => {
      expect(batch.lat[i]).toBeCloseTo(f.lat, 4)
      expect(batch.lon[i]).toBeCloseTo(f.lon, 4)
      expect(batch.offsetMs[i]).toBeCloseTo(f.firstS * 1000, 1)
      expect(batch.durationMs[i]).toBeCloseTo((f.lastS - f.firstS) * 1000, 1)
      expect(batch.energyJ[i] / f.energyJ).toBeCloseTo(1, 5)
      expect(batch.areaKm2[i]).toBeCloseTo(f.areaKm2, 2)
    })
    // GLM's ranges (the full file: offsets -2.2..19.4 s, 1.3e-15..3.5e-12 J, 65..6800 km²).
    for (let i = 0; i < batch.count; i++) {
      expect(batch.offsetMs[i]).toBeGreaterThan(-5000)
      expect(batch.offsetMs[i]).toBeLessThan(20_000)
      expect(batch.energyJ[i]).toBeGreaterThan(1e-15)
      expect(batch.energyJ[i]).toBeLessThan(1e-11)
      expect(batch.areaKm2[i]).toBeGreaterThan(60)
      expect(batch.areaKm2[i]).toBeLessThan(7000)
    }
  })

  test('a file with no flashes is an empty batch', () => {
    const raw = readGlmFile(fixture('glm-lcfa-g19-0.nc'))
    expect(raw.lat.length).toBe(0)
    expect(decodeGlmFlashes(raw, KEY, START).count).toBe(0)
  })

  test('loadGlmBatch fetches, reads and decodes one file', async () => {
    const body = fixture('glm-lcfa-g19-12.nc')
    const fetch = vi.fn(async () => new Response(body))
    vi.stubGlobal('fetch', fetch)
    const batch = await loadGlmBatch({ url: 'https://x/f.nc', key: KEY, windowStartMs: START }, new AbortController().signal)
    expect(fetch).toHaveBeenCalledWith('https://x/f.nc', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(batch.count).toBe(expected.flashes.length)
  })

  test('loadGlmBatch rejects on an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    await expect(
      loadGlmBatch({ url: 'https://x/f.nc', key: KEY, windowStartMs: START }, new AbortController().signal)
    ).rejects.toThrow('HTTP 503')
  })
})
