import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { latLonToLocal } from '../aurora'
import {
  bearing,
  CLIMATE_BYTES,
  CLIMATE_COLS,
  CLIMATE_PLANE_BYTES,
  CLIMATE_ROWS,
  climateAt,
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
  test('decodes to two planes of one RGBA texel per 7.5°, all in range', () => {
    expect(bytes.length).toBe(2 * 48 * 24 * 4)
    expect(CLIMATE_BYTES).toBe(2 * 48 * 24 * 4)
    expect(cells).toHaveLength(48 * 24)
    for (const c of cells) {
      for (const x of Object.values(c)) expect(Number.isFinite(x)).toBe(true)
      expect(c.windWave).toBeGreaterThanOrEqual(0)
      expect(c.swell).toBeGreaterThanOrEqual(0)
      // Means of unit vectors, to within a byte.
      for (const [x, y] of [[c.waveCos, c.waveSin], [c.windCos, c.windSin], [c.swellCos, c.swellSin]]) {
        expect(Math.hypot(x, y)).toBeLessThanOrEqual(1.01)
      }
    }
  })

  test('the Southern Ocean runs rougher than the doldrums', () => {
    expect(cellAt(-55, 90).windWave).toBeGreaterThan(cellAt(5, -120).windWave)
    expect(cellAt(-55, 90).swell).toBeGreaterThan(cellAt(5, -120).swell)
  })

  // Toward which bearing (degrees) the waves travel off coasts known for
  // their swell and in the trades and the westerlies: shoreward, downwind.
  const heading = (lat: number, lon: number, of: 'wind' | 'swell') => {
    const c = climateAt(cells, local(lat, lon))
    return of === 'wind' ? bearing(c.windCos, c.windSin) : bearing(c.swellCos, c.swellSin)
  }
  test.each([
    ['off Southern California, the swell onto its south-west-facing coast', 32, -121, 'swell', 110, 170],
    ['off Portugal, the swell onto its west-facing coast', 39.5, -11, 'swell', 90, 150],
    ["north of Hawaii, the swell onto Oahu's north shore", 23, -158, 'swell', 135, 225],
    ['in the Southern Ocean, the westerlies\' swell east', -50, 90, 'swell', 45, 135],
    ['in the Southern Ocean, the westerlies\' wind sea east', -50, 90, 'wind', 45, 135],
    ["in the Atlantic's north-east trades, the wind sea south-west", 15, -40, 'wind', 225, 280],
    ["in the Pacific's north-east trades, the wind sea south-west", 12, -140, 'wind', 225, 280],
  ] as const)('heads the right way %s', (_, lat, lon, of, from, to) => {
    const b = heading(lat, lon, of)
    expect(b).toBeGreaterThan(from)
    expect(b).toBeLessThan(to)
  })

  test("its medians are the scales' references", () => {
    // Over every texel: land holds its neighbouring sea's values.
    expect(Math.abs(median(cells.map((c) => c.windWave)) / WIND_WAVE_REF_M - 1)).toBeLessThan(0.2)
    expect(Math.abs(median(cells.map((c) => c.swell)) / SWELL_REF_M - 1)).toBeLessThan(0.2)
  })

  test('loads plane 0 as a texture of the same bytes', () => {
    const texture = climateTexture()
    expect(texture.image.width).toBe(CLIMATE_COLS)
    expect(texture.image.height).toBe(CLIMATE_ROWS)
    expect(texture.flipY).toBe(false)
    expect(Array.from(texture.image.data as Uint8Array)).toEqual(Array.from(bytes.subarray(0, CLIMATE_PLANE_BYTES)))
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

describe('climateAt', () => {
  test('is the texel at its centre and bilinear between, across the antimeridian too', () => {
    for (const [i, j] of [[0, 3], [47, 10], [20, 23]]) {
      const at = climateAt(cells, local(texelLat(j), texelLon(i)))
      const texel = cells[j * CLIMATE_COLS + i]
      for (const key of Object.keys(texel) as (keyof ClimateCell)[]) expect(at[key]).toBeCloseTo(texel[key], 9)
    }
    // Halfway between column 47 and column 0, on row 5.
    const mid = climateAt(cells, local(texelLat(5), 180))
    const a = cells[5 * CLIMATE_COLS + 47]
    const b = cells[5 * CLIMATE_COLS]
    expect(mid.swell).toBeCloseTo((a.swell + b.swell) / 2, 9)
    expect(mid.windCos).toBeCloseTo((a.windCos + b.windCos) / 2, 9)
    // Clamped past the first and last rows' centres.
    expect(climateAt(cells, local(89.9, texelLon(4))).swell).toBeCloseTo(cells[4].swell, 9)
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
  const sea: ClimateCell = { windWave: 1.2, swell: 2.5, waveCos: 0.6, waveSin: -0.3, windCos: -0.8, windSin: 0.1, swellCos: 0.2, swellSin: 0.9 }

  test('round-trips a texel to within a byte', () => {
    const decoded = decode(encode(Array(CLIMATE_COLS * CLIMATE_ROWS).fill(sea)))[0]
    for (const key of Object.keys(sea) as (keyof ClimateCell)[]) expect(decoded[key]).toBeCloseTo(sea[key], 1)
  })

  test('fills land from the sea, across the date line and into empty rows', () => {
    const grid: (ClimateCell | null)[] = Array(CLIMATE_COLS * CLIMATE_ROWS).fill(null)
    grid[CLIMATE_ROWS / 2 * CLIMATE_COLS] = sea
    const filled = fillGaps(grid)
    expect(filled.every((c) => Object.keys(sea).every((key) => Math.abs(c[key as keyof ClimateCell] - sea[key as keyof ClimateCell]) < 1e-9))).toBe(true)
  })

  test('turns each direction round to a heading, weighted by its own waves\' height, and averages heights over the sea days', () => {
    const none = { waveHeight: null, windWave: null, swell: null, direction: null, windDirection: null, swellDirection: null }
    const cell = climateCell([
      { waveHeight: 3, windWave: 1, swell: 3, direction: 90, windDirection: 0, swellDirection: 270 },
      { waveHeight: 1, windWave: 3, swell: 1, direction: 0, windDirection: 90, swellDirection: 180 },
      none,
    ])
    expect(cell?.windWave).toBe(2)
    expect(cell?.swell).toBe(2)
    // From the east (weight 3) and the north (1): toward the west 3/4, the south 1/4.
    expect(cell?.waveCos).toBeCloseTo(-0.25, 9)
    expect(cell?.waveSin).toBeCloseTo(-0.75, 9)
    // The wind waves from the north (weight 1) and the east (3).
    expect(cell?.windCos).toBeCloseTo(-0.25, 9)
    expect(cell?.windSin).toBeCloseTo(-0.75, 9)
    // The swell from the west (weight 3) and the south (1).
    expect(cell?.swellCos).toBeCloseTo(0.25, 9)
    expect(cell?.swellSin).toBeCloseTo(0.75, 9)
    // Opposed days cancel: no settled heading.
    const opposed = climateCell([
      { ...none, waveHeight: 1, windWave: 1, swell: 1, direction: 0, windDirection: 0, swellDirection: 0 },
      { ...none, waveHeight: 1, windWave: 1, swell: 1, direction: 180, windDirection: 180, swellDirection: 180 },
    ])
    expect(Math.hypot(opposed!.waveCos, opposed!.waveSin)).toBeCloseTo(0, 9)
    expect(climateCell([none])).toBeNull()
  })

  test('bearing() is the compass bearing of a heading', () => {
    expect(bearing(1, 0)).toBeCloseTo(0, 9)
    expect(bearing(0, 1)).toBeCloseTo(90, 9)
    expect(bearing(-1, 0)).toBeCloseTo(180, 9)
    expect(bearing(0, -1)).toBeCloseTo(270, 9)
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
