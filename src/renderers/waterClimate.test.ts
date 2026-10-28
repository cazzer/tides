import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { latLonToLocal } from '../aurora'
import {
  CLIMATE_BYTES,
  CLIMATE_COLS,
  CLIMATE_ROWS,
  climateCell,
  climateTexture,
  climateUv,
  decode,
  encode,
  fillGaps,
  localEastNorth,
  mssScale,
  SWELL_REF_M,
  swellScale,
  texelLat,
  texelLon,
  WIND_WAVE_REF_M,
  type ClimateCell,
} from './waterClimate'

const bytes = new Uint8Array(fs.readFileSync(path.join(__dirname, '../assets/earth-wave-climate.bin')))
const cells = decode(bytes)

const local = (lat: number, lon: number) => latLonToLocal(lat, lon).toArray() as [number, number, number]

/** The texel (column, row) waterClimateAt() reads nearest at a lat/lon. */
function texelAt(lat: number, lon: number): [number, number] {
  const [u, v] = climateUv(local(lat, lon))
  return [Math.floor(u * CLIMATE_COLS) % CLIMATE_COLS, Math.min(CLIMATE_ROWS - 1, Math.floor(v * CLIMATE_ROWS))]
}

const cellAt = (lat: number, lon: number) => {
  const [i, j] = texelAt(lat, lon)
  return cells[j * CLIMATE_COLS + i]
}

const median = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

describe('the wave climate asset', () => {
  test('decodes to one RGBA texel per 7.5°, all in range', () => {
    expect(bytes.length).toBe(48 * 24 * 4)
    expect(CLIMATE_BYTES).toBe(48 * 24 * 4)
    expect(cells).toHaveLength(48 * 24)
    for (const c of cells) {
      for (const x of [c.windWave, c.swell, c.axisCos, c.axisSin]) expect(Number.isFinite(x)).toBe(true)
      expect(c.windWave).toBeGreaterThanOrEqual(0)
      expect(c.swell).toBeGreaterThanOrEqual(0)
      expect(Math.hypot(c.axisCos, c.axisSin)).toBeLessThanOrEqual(Math.SQRT2 + 1e-9)
    }
  })

  test('the Southern Ocean runs rougher than the doldrums', () => {
    expect(cellAt(-55, 90).windWave).toBeGreaterThan(cellAt(5, -120).windWave)
    expect(cellAt(-55, 90).swell).toBeGreaterThan(cellAt(5, -120).swell)
  })

  test("its medians are the scales' references", () => {
    // Over every texel: land holds its neighbouring sea's values.
    expect(Math.abs(median(cells.map((c) => c.windWave)) / WIND_WAVE_REF_M - 1)).toBeLessThan(0.2)
    expect(Math.abs(median(cells.map((c) => c.swell)) / SWELL_REF_M - 1)).toBeLessThan(0.2)
  })

  test('loads as a texture of the same bytes', () => {
    const texture = climateTexture()
    expect(texture.image.width).toBe(CLIMATE_COLS)
    expect(texture.image.height).toBe(CLIMATE_ROWS)
    expect(texture.flipY).toBe(false)
    expect(Array.from(texture.image.data as Uint8Array)).toEqual(Array.from(bytes))
  })
})

describe('climateUv', () => {
  test('puts longitude −180° and +180° in the same column, the first', () => {
    expect(texelAt(10, -179.9)[0]).toBe(0)
    expect(texelAt(10, 180)[0]).toBe(0)
    expect(texelAt(10, 179.9)[0]).toBe(CLIMATE_COLS - 1)
  })

  test('maps each texel centre to its own texel, the north to row 0', () => {
    for (let j = 0; j < CLIMATE_ROWS; j++) {
      for (let i = 0; i < CLIMATE_COLS; i++) {
        const [u, v] = climateUv(local(texelLat(j), texelLon(i)))
        expect(u * CLIMATE_COLS).toBeCloseTo(i + 0.5, 6)
        expect(v * CLIMATE_ROWS).toBeCloseTo(j + 0.5, 6)
      }
    }
    expect(climateUv([0, 1, 0])[1]).toBeCloseTo(0, 9)
    expect(climateUv([0, -1, 0])[1]).toBeCloseTo(1, 9)
  })
})

describe('localEastNorth', () => {
  test('is orthonormal to up, east toward rising longitude, north toward rising latitude', () => {
    const dot = (a: number[], b: number[]) => a.reduce((s, x, k) => s + x * b[k], 0)
    for (const [lat, lon] of [[0, 0], [40, -100], [-55, 90], [80, 170]]) {
      const up = local(lat, lon)
      const { east, north } = localEastNorth(up)
      expect(dot(east, east)).toBeCloseTo(1, 9)
      expect(dot(north, north)).toBeCloseTo(1, 9)
      expect(dot(east, up)).toBeCloseTo(0, 9)
      expect(dot(north, up)).toBeCloseTo(0, 9)
      expect(dot(east, north)).toBeCloseTo(0, 9)
      expect(dot(east, local(lat, lon + 1))).toBeGreaterThan(dot(east, up))
      expect(dot(north, local(lat + 1, lon))).toBeGreaterThan(dot(north, up))
    }
  })
})

describe('encoding', () => {
  const sea: ClimateCell = { windWave: 1.2, swell: 2.5, axisCos: 0.6, axisSin: -0.3 }

  test('round-trips a texel to within a byte', () => {
    const decoded = decode(encode(Array(CLIMATE_COLS * CLIMATE_ROWS).fill(sea)))[0]
    expect(decoded.windWave).toBeCloseTo(1.2, 1)
    expect(decoded.swell).toBeCloseTo(2.5, 1)
    expect(decoded.axisCos).toBeCloseTo(0.6, 1)
    expect(decoded.axisSin).toBeCloseTo(-0.3, 1)
  })

  test('fills land from the sea, across the date line and into empty rows', () => {
    const grid: (ClimateCell | null)[] = Array(CLIMATE_COLS * CLIMATE_ROWS).fill(null)
    grid[CLIMATE_ROWS / 2 * CLIMATE_COLS] = sea
    const filled = fillGaps(grid)
    expect(filled.every((c) => Math.abs(c.windWave - 1.2) < 1e-9 && Math.abs(c.axisCos - 0.6) < 1e-9)).toBe(true)
  })

  test('weights the axis by wave height and averages heights over the sea days', () => {
    const cell = climateCell([
      { waveHeight: 3, windWave: 1, swell: 2, direction: 90 },
      { waveHeight: 1, windWave: 3, swell: 4, direction: 0 },
      { waveHeight: null, windWave: null, swell: null, direction: null },
    ])
    expect(cell?.windWave).toBe(2)
    expect(cell?.swell).toBe(3)
    // 90° (an east–west axis) is cos 2θ = −1 at weight 3; 0° is +1 at weight 1.
    expect(cell?.axisCos).toBeCloseTo(-0.5, 9)
    expect(cell?.axisSin).toBeCloseTo(0, 9)
    expect(climateCell([{ waveHeight: null, windWave: null, swell: null, direction: null }])).toBeNull()
  })
})

describe('scales', () => {
  test('are 1 at the median sea and clamped', () => {
    expect(mssScale(WIND_WAVE_REF_M)).toBeCloseTo(1, 9)
    expect(swellScale(SWELL_REF_M)).toBeCloseTo(1, 9)
    expect(mssScale(0)).toBe(0.5)
    expect(mssScale(100)).toBe(2)
    expect(swellScale(0)).toBe(0.4)
    expect(swellScale(100)).toBe(2)
  })
})
