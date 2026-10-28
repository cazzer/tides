// The sea's baked noise (tides-d9f.5): deterministic, tileable, centred, and
// sharing one texture array with the wave climate without changing what
// the climate's lookup reads.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { CLIMATE_COLS, CLIMATE_ROWS, climateTexture, waterSeaTexture } from './waterClimate'
import { bakeWaterNoise, NOISE_CELL_TEXELS, NOISE_CELLS, NOISE_LAT_MAX, NOISE_SIZE, noiseCellsAround, noiseMercator } from './waterNoise'

const texel = (data: Uint8Array, x: number, y: number, c: number) =>
  data[(((y + NOISE_SIZE) % NOISE_SIZE) * NOISE_SIZE + ((x + NOISE_SIZE) % NOISE_SIZE)) * 4 + c]

describe('the sea\'s baked noise', () => {
  const noise = bakeWaterNoise()

  it('bakes the same noise every time, four channels of it', () => {
    expect(noise.length).toBe(NOISE_SIZE * NOISE_SIZE * 4)
    expect(Array.from(bakeWaterNoise().subarray(0, 4096))).toEqual(Array.from(noise.subarray(0, 4096)))
    expect(NOISE_CELL_TEXELS * NOISE_CELLS).toBe(NOISE_SIZE)
    // The channels are independent draws.
    let same = 0
    for (let i = 0; i < noise.length; i += 4) if (noise[i] === noise[i + 1]) same++
    expect(same / (noise.length / 4)).toBeLessThan(0.05)
  })

  it('reads about 0 on average (as 2 b / 255 - 1), and tiles: no step across its edges', () => {
    for (let c = 0; c < 4; c++) {
      let sum = 0
      for (let i = c; i < noise.length; i += 4) sum += (2 * noise[i]) / 255 - 1
      expect(Math.abs(sum / (noise.length / 4))).toBeLessThan(0.1)
      // Neighbours differ by little anywhere, across the wrap as within.
      let inner = 0
      let edge = 0
      for (let y = 0; y < NOISE_SIZE; y++) {
        inner = Math.max(inner, Math.abs(texel(noise, 100, y, c) - texel(noise, 101, y, c)))
        edge = Math.max(edge, Math.abs(texel(noise, NOISE_SIZE - 1, y, c) - texel(noise, 0, y, c)))
        edge = Math.max(edge, Math.abs(texel(noise, y, NOISE_SIZE - 1, c) - texel(noise, y, 0, c)))
      }
      expect(edge).toBeLessThanOrEqual(Math.max(inner, 1) * 1.5 + 2)
      expect(edge).toBeLessThan(40)
    }
  })

  it('wraps each octave a whole number of tiles round the equator', () => {
    for (const km of [40, 13, 4.5, 1.6, 0.55]) {
      const n = noiseCellsAround(km, 6371)
      expect(n % NOISE_CELLS).toBe(0)
      expect(Math.abs((2 * Math.PI * 6371) / n / km - 1)).toBeLessThan(0.1)
    }
  })

  it('takes the Mercator plane, held short of the poles', () => {
    expect(noiseMercator(0.3, 0)[0]).toBe(0.3)
    expect(noiseMercator(0.3, 0)[1]).toBeCloseTo(0, 12)
    const [, y] = noiseMercator(0, 0.5)
    expect(y).toBeCloseTo(Math.log(Math.tan(Math.PI / 4 + 0.25)), 12)
    expect(noiseMercator(0, Math.PI / 2)[1]).toBe(noiseMercator(0, NOISE_LAT_MAX)[1])
  })
})

describe('the sea\'s texture array', () => {
  const sea = waterSeaTexture()
  const data = sea.image.data as Uint8Array
  const climate = climateTexture().image.data as Uint8Array
  const layer = NOISE_SIZE * NOISE_SIZE * 4

  it('holds the climate in layer 0 and the noise in layer 1, mipmapped and repeating', () => {
    expect(sea).toBeInstanceOf(THREE.DataArrayTexture)
    expect(sea.image.depth).toBe(2)
    expect(sea.generateMipmaps).toBe(true)
    expect(sea.wrapS).toBe(THREE.RepeatWrapping)
    expect(sea.wrapT).toBe(THREE.RepeatWrapping)
    expect(Array.from(data.subarray(layer, layer + 4096))).toEqual(Array.from(bakeWaterNoise().subarray(0, 4096)))
    for (let row = 0; row < CLIMATE_ROWS; row++) {
      for (let col = 0; col < CLIMATE_COLS; col++) {
        for (let c = 0; c < 4; c++) expect(texel(data, col, row, c)).toBe(climate[(row * CLIMATE_COLS + col) * 4 + c])
      }
    }
  })

  it('pads the climate so a bilinear read wraps its longitude and clamps its latitude, as its own texture did', () => {
    for (let c = 0; c < 4; c++) {
      for (let row = 0; row < CLIMATE_ROWS; row++) {
        // East of the last column, the first; west of the first, the last.
        expect(texel(data, CLIMATE_COLS, row, c)).toBe(texel(data, 0, row, c))
        expect(texel(data, -1, row, c)).toBe(texel(data, CLIMATE_COLS - 1, row, c))
      }
      for (let col = -1; col <= CLIMATE_COLS; col++) {
        // North of the first row, the first; south of the last, the last.
        expect(texel(data, col, -1, c)).toBe(texel(data, col, 0, c))
        expect(texel(data, col, CLIMATE_ROWS, c)).toBe(texel(data, col, CLIMATE_ROWS - 1, c))
      }
    }
  })
})
