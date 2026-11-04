import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { MASK_HEIGHT, MASK_WIDTH, NORTH_GRID, SOUTH_GRID, unpackSeaIce, type SeaIceMask } from './sea-ice'
import { REACH_DEG, drawPolarMap, mapPoint, polarMapLayout } from './sea-ice-map'

const ice = unpackSeaIce(new Uint8Array(gunzipSync(readFileSync('src/assets/sea-ice-2025.bin'))))
// All sea, so every pixel reads the grid.
const sea: SeaIceMask = { rg: new Uint8Array(MASK_WIDTH * MASK_HEIGHT * 2).fill(255), width: MASK_WIDTH, height: MASK_HEIGHT }
const SIZE = 64

function pixel(out: Uint8ClampedArray, x: number, y: number) {
  const o = 4 * (y * SIZE + x)
  return [out[o], out[o + 1], out[o + 2], out[o + 3]]
}

describe('mapPoint', () => {
  it('has the pole in the middle and REACH_DEG at the rim', () => {
    expect(mapPoint(NORTH_GRID, 100, 49.5, 49.5)!.lat).toBeCloseTo(90)
    expect(mapPoint(NORTH_GRID, 100, 49.5, 99)!.lat).toBeCloseTo(90 - REACH_DEG, 0)
    expect(mapPoint(SOUTH_GRID, 100, 49.5, 49.5)!.lat).toBeCloseTo(-90)
    expect(mapPoint(NORTH_GRID, 100, 0, 0)).toBeNull()
  })

  it('faces the way NSIDC’s maps do: 45°W down in the north, 0° up in the south', () => {
    expect(mapPoint(NORTH_GRID, 100, 49.5, 90)!.lon).toBeCloseTo(-45)
    expect(mapPoint(NORTH_GRID, 100, 90, 49.5)!.lon).toBeCloseTo(45)
    expect(mapPoint(SOUTH_GRID, 100, 49.5, 10)!.lon).toBeCloseTo(0)
    expect(mapPoint(SOUTH_GRID, 100, 90, 49.5)!.lon).toBeCloseTo(90)
  })
})

describe('drawPolarMap', () => {
  const north = polarMapLayout(NORTH_GRID, sea, SIZE)
  const south = polarMapLayout(SOUTH_GRID, sea, SIZE)
  const out = new Uint8ClampedArray(SIZE * SIZE * 4)

  it('draws the North Pole’s ice white under the midnight Sun and grey in the polar night', () => {
    const june = pixel(drawPolarMap(north, ice.north, 24, 25, 0, 23.4, out), SIZE / 2, SIZE / 2)
    expect(Math.min(...june.slice(0, 3))).toBeGreaterThan(230)
    expect(june[3]).toBe(255)
    const december = pixel(drawPolarMap(north, ice.north, 50, 51, 0, -23.4, out), SIZE / 2, SIZE / 2)
    expect(Math.max(...december.slice(0, 3))).toBeLessThan(80)
    expect(Math.min(...december.slice(0, 3))).toBeGreaterThan(60)
  })

  it('leaves the corners clear', () => {
    expect(pixel(drawPolarMap(south, ice.south, 0, 1, 0.5, 0, out), 0, 0)[3]).toBe(0)
  })

  it('draws far more white round Antarctica in September than in March', () => {
    const white = (frame: number) => {
      drawPolarMap(south, ice.south, frame, frame, 0, 0, out)
      let n = 0
      for (let k = 0; k < SIZE * SIZE; k++) if (out[4 * k + 3] > 0 && out[4 * k] > 100) n++
      return n
    }
    expect(white(37)).toBeGreaterThan(3 * white(11))
  })
})
