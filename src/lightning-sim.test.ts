import { describe, expect, test } from 'vitest'
import g18 from './__fixtures__/glm-lcfa-g18-12.json'
import g19 from './__fixtures__/glm-lcfa-g19-12.json'
import { encodePrecip } from './cloud-precip'
import { TYPE_H, TYPE_W } from './cloud-types'
import { WINDOW_MS, type FlashBatch } from './lightning'
import { globalFlashRate, syntheticClimatology, syntheticClimatologyBytes, decodeLightningClimatology } from './lightning-climatology'
import {
  coverAt,
  diurnalFactor,
  forecastFactor,
  hash32,
  localSolarHour,
  MEAN_GATE,
  normInv,
  poissonInv,
  R_MAX,
  simulateWindow,
  thickGate,
  unit,
  type SimClouds,
  type SimFrame,
} from './lightning-sim'

const STATIC: SimClouds = { a: null, b: null, mix: 0 }
const JULY = Date.UTC(2031, 6, 15)
const windowAt = (ms: number) => Math.floor(ms / WINDOW_MS)

/** Flashes in `n` windows `step` apart from w0, and the batches. */
function run(clim: ReturnType<typeof syntheticClimatology>, clouds: SimClouds, w0: number, n: number, step = 7) {
  const batches: FlashBatch[] = []
  let total = 0
  for (let i = 0; i < n; i++) {
    const batch = simulateWindow(w0 + i * step, clim, clouds)
    batches.push(batch)
    total += batch.count
  }
  return { total, batches }
}

function precipFrame(showersMmH: number): SimFrame {
  const precip = new Uint8Array(TYPE_W * TYPE_H * 4)
  for (let i = 0; i < TYPE_W * TYPE_H; i++) {
    precip[i * 4 + 1] = encodePrecip(showersMmH)
    precip[i * 4 + 3] = 255
  }
  return { cover: null, precip }
}

const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]

describe('draws', () => {
  test('unit is uniform in (0, 1), and every word of its index, key and stream counts', () => {
    const n = 200_000
    const buckets = new Array(10).fill(0)
    let sum = 0
    let sq = 0
    for (let i = 0; i < n; i++) {
      const u = unit(i, 7, 3)
      expect(u > 0 && u < 1).toBe(true)
      sum += u
      sq += u * u
      buckets[Math.floor(u * 10)]++
    }
    const mean = sum / n
    expect(mean).toBeCloseTo(0.5, 2)
    expect(sq / n - mean * mean).toBeCloseTo(1 / 12, 2)
    for (const b of buckets) expect(Math.abs(b - n / 10)).toBeLessThan(0.03 * (n / 10))
    expect(unit(5 + 2 ** 32, 1, 1)).not.toBe(unit(5, 1, 1))
    expect(unit(-5, 1, 1)).not.toBe(unit(5, 1, 1))
    expect(unit(5, 1, 2)).not.toBe(unit(5, 1, 1))
    expect(unit(5, 2, 1)).not.toBe(unit(5, 1, 1))
    expect(hash32(1, 2, 3, 4)).toBe(hash32(1, 2, 3, 4))
    expect(hash32(1, 2, 3, 4)).not.toBe(hash32(2, 1, 3, 4))
  })

  test('normInv is the standard normal quantile', () => {
    expect(normInv(0.5)).toBeCloseTo(0, 9)
    expect(normInv(0.975)).toBeCloseTo(1.959964, 5)
    expect(normInv(0.001)).toBeCloseTo(-3.090232, 5)
    expect(normInv(1 - 1e-9)).toBeCloseTo(5.997807, 4)
  })

  test("poissonInv's draws have the Poisson mean and variance", () => {
    for (const mu of [0.3, 2, 12, 39, 80, 400]) {
      const n = 40_000
      let sum = 0
      let sq = 0
      for (let i = 0; i < n; i++) {
        const k = poissonInv(mu, unit(i, 11, Math.round(mu * 10)))
        expect(Number.isInteger(k) && k >= 0).toBe(true)
        sum += k
        sq += k * k
      }
      const mean = sum / n
      expect(Math.abs(mean - mu)).toBeLessThan(0.03 * mu + 0.01)
      expect(Math.abs(sq / n - mean * mean - mu)).toBeLessThan(0.06 * mu + 0.02)
    }
    expect(poissonInv(0, 0.9)).toBe(0)
  })
})

describe('rates', () => {
  test('the diurnal cycle averages 1 over a day; over land it peaks at 16-17 h', () => {
    for (const land of [0, 0.4, 1]) {
      let sum = 0
      for (let h = 0; h < 24; h += 0.25) sum += diurnalFactor(h, land)
      expect(sum / 96).toBeCloseTo(1, 9)
    }
    let peak = 0
    for (let h = 0; h < 24; h += 0.25) if (diurnalFactor(h, 1) > diurnalFactor(peak, 1)) peak = h
    expect(peak).toBeGreaterThanOrEqual(16)
    expect(peak).toBeLessThanOrEqual(17)
  })

  test('localSolarHour is the mean solar time, wrapping', () => {
    const noon = Date.UTC(2031, 0, 1, 12)
    expect(localSolarHour(noon, 0)).toBeCloseTo(12, 9)
    expect(localSolarHour(noon, 180)).toBeCloseTo(0, 9)
    expect(localSolarHour(noon, -180)).toBeCloseTo(0, 9)
    expect(localSolarHour(Date.UTC(2031, 0, 1, 23), 30)).toBeCloseTo(1, 9)
    expect(localSolarHour(Date.UTC(2031, 0, 1, 1), -30)).toBeCloseTo(23, 9)
    expect(localSolarHour(Date.UTC(1960, 0, 1, 1), -30)).toBeCloseTo(23, 9)
  })

  test('the forecast factor follows the showers up to R_MAX; the gate opens only on thick cloud', () => {
    expect(forecastFactor(0)).toBe(0)
    expect(forecastFactor(0.6)).toBeCloseTo(2 * forecastFactor(0.3), 9)
    expect(forecastFactor(50)).toBe(R_MAX)
    expect(thickGate(0.4)).toBe(0)
    expect(thickGate(0.9)).toBe(1)
  })
})

describe('simulateWindow', () => {
  // Sea everywhere (a weak diurnal cycle), all thick cloud.
  const flat = syntheticClimatology({ density: 0.005, land: 0, cover: 1 })

  test('flashes at the climatology rate, over a gate of 1 / MEAN_GATE, over 500 windows', () => {
    const expected = (globalFlashRate(flat) * (WINDOW_MS / 1000)) / MEAN_GATE
    const { total } = run(flat, STATIC, windowAt(Date.UTC(2031, 3, 2)), 500)
    expect(Math.abs(total / 500 / expected - 1)).toBeLessThan(0.1)
  })

  test('nothing under clear sky', () => {
    const clear = syntheticClimatology({ density: 0.005, cover: 0 })
    expect(run(clear, STATIC, windowAt(JULY), 20).total).toBe(0)
  })

  test("over land the late afternoon is busier than the morning", () => {
    const land = syntheticClimatology({ density: 0.005, land: 1, cover: 1 })
    let afternoon = 0
    let morning = 0
    for (const batch of run(land, STATIC, windowAt(JULY), 100).batches) {
      const tMid = batch.startMs + WINDOW_MS / 2
      for (let i = 0; i < batch.count; i++) {
        const h = localSolarHour(tMid, batch.lon[i])
        if (h >= 15.5 && h < 17.5) afternoon++
        else if (h >= 8 && h < 10) morning++
      }
    }
    expect(morning).toBeGreaterThan(100)
    expect(afternoon / morning).toBeGreaterThan(2)
  })

  test('on a half-cloudy map the flashes keep to the cloudy half', () => {
    const half = syntheticClimatology({ density: 0.005, cover: (_lat, lon) => (lon < 0 ? 1 : 0) })
    let west = 0
    for (const batch of run(half, STATIC, windowAt(JULY), 40).batches) {
      for (let i = 0; i < batch.count; i++) {
        // Near the poles 12 km is many degrees of longitude.
        if (Math.abs(batch.lat[i]) < 70) expect(batch.lon[i] < 2 || batch.lon[i] > 178).toBe(true)
        if (batch.lon[i] < 0) west++
      }
    }
    expect(west).toBeGreaterThan(1000)
    // A frame's own cover, where it has one, rather than the static clouds'.
    const north: SimFrame = { cover: { data: [0, 0, 255, 255], width: 2, height: 2 }, precip: null }
    const clear = syntheticClimatology({ density: 0.005, cover: 0 })
    expect(coverAt({ a: north, b: null, mix: 0 }, clear, 45, 10)).toBe(1)
    expect(coverAt({ a: north, b: null, mix: 1 }, clear, 45, 10)).toBe(0)
    const { batches, total } = run(clear, { a: north, b: north, mix: 0.5 }, windowAt(JULY), 20)
    expect(total).toBeGreaterThan(100)
    for (const batch of batches) for (let i = 0; i < batch.count; i++) expect(batch.lat[i]).toBeGreaterThan(-1)
  })

  describe('in forecast hours, where LIS has no data (the guess)', () => {
    // Cloud only at 40-60° N, so no window comes near the cap.
    const guess = syntheticClimatology({ density: 0, coverage: 0, land: 0.5, cover: (lat) => (lat > 40 && lat < 60 ? 1 : 0) })
    const w0 = windowAt(JULY)
    const at = (showers: number, from = w0) =>
      run(guess, { a: precipFrame(showers), b: precipFrame(showers), mix: 0 }, from, 60).total

    test('flashes follow the showers: none without, twice as many for twice the showers, up to R_MAX', () => {
      expect(at(0)).toBe(0)
      const one = at(0.3)
      const two = at(0.6)
      const capped = at(5)
      expect(one).toBeGreaterThan(1000)
      expect(two / one).toBeGreaterThan(1.8)
      expect(two / one).toBeLessThan(2.2)
      expect(at(20)).toBe(capped)
      expect(capped / one).toBeGreaterThan(2.7)
    })

    test('the guess flashes in summer and less in winter', () => {
      const winter = at(0.3, windowAt(Date.UTC(2031, 0, 15)))
      expect(winter).toBeGreaterThan(0)
      expect(winter).toBeLessThan(at(0.3) / 3)
    })
  })

  test('the same arguments give the same batch, byte for byte, sorted, all owned', () => {
    const bytes = syntheticClimatologyBytes({ density: 0.005, cover: 1 })
    const w = windowAt(JULY) + 3
    const first = simulateWindow(w, decodeLightningClimatology(bytes), STATIC)
    // Other windows in between, and a climatology decoded again (no memo).
    run(flat, STATIC, w + 100, 5)
    const again = simulateWindow(w, decodeLightningClimatology(bytes), STATIC)
    expect(again).toEqual(first)
    expect(first.source).toBe('simulated')
    expect(first.key).toBe(`sim:${w}`)
    expect(first.startMs).toBe(w * WINDOW_MS)
    expect(first.count).toBeGreaterThan(100)
    for (let i = 0; i < first.count; i++) {
      expect(first.owned[i]).toBe(1)
      expect(first.offsetMs[i]).toBeGreaterThanOrEqual(0)
      expect(first.offsetMs[i]).toBeLessThan(WINDOW_MS)
      if (i > 0) expect(first.offsetMs[i]).toBeGreaterThanOrEqual(first.offsetMs[i - 1])
      expect(Math.abs(first.lat[i])).toBeLessThanOrEqual(90)
      expect(first.lon[i] >= -180 && first.lon[i] < 180).toBe(true)
    }
  })

  test("its flashes look like GLM's (the fixtures' energy and footprint)", () => {
    const { batches } = run(flat, STATIC, windowAt(JULY), 5)
    const energy: number[] = []
    const area: number[] = []
    for (const b of batches) {
      for (let i = 0; i < b.count; i++) {
        energy.push(Math.log10(b.energyJ[i]))
        area.push(Math.log10(b.areaKm2[i]))
      }
    }
    const glm = [...g18.flashes, ...g19.flashes]
    expect(Math.abs(median(energy) - median(glm.map((f) => Math.log10(f.energyJ))))).toBeLessThan(0.4)
    expect(Math.abs(median(area) - median(glm.map((f) => Math.log10(f.areaKm2))))).toBeLessThan(0.4)
  })

  test('timing (logged, not asserted)', () => {
    // About LIS's 46 fl/s: the tropics, land-heavy, under a patchy deck.
    const clim = syntheticClimatology({
      density: (lat) => 0.024 * Math.exp(-((lat / 22) ** 2)),
      land: (lat, lon) => (Math.sin(lon * 0.05) * Math.cos(lat * 0.07) > 0.3 ? 1 : 0),
      cover: (lat, lon) => 0.5 + 0.5 * Math.sin(lat * 0.21) * Math.cos(lon * 0.13),
    })
    const w0 = windowAt(Date.UTC(2031, 8, 3, 15))
    let t = performance.now()
    const cold = simulateWindow(w0, clim, STATIC)
    const coldMs = performance.now() - t
    t = performance.now()
    let count = 0
    for (let i = 1; i <= 30; i++) count += simulateWindow(w0 + i, clim, STATIC).count
    const warmMs = (performance.now() - t) / 30
    console.log(
      `[lightning-sim] ${globalFlashRate(clim).toFixed(1)} fl/s climatology: cold window ${coldMs.toFixed(1)} ms ` +
        `(${cold.count} flashes, seeding 3 epochs), warm ${warmMs.toFixed(2)} ms/window (${(count / 30).toFixed(0)} flashes)`
    )
  })
})
