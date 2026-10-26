import { describe, expect, it } from 'vitest'
import { decodeTerrariumPadded, flatGrid, terrariumElevation } from './terrarium'

describe('terrarium decode (tides-zmw.9.2)', () => {
  it('reads Terrarium metres', () => {
    expect(terrariumElevation(128, 0, 0)).toBe(0)
    expect(terrariumElevation(128, 100, 128)).toBe(100.5)
    expect(terrariumElevation(127, 255, 0)).toBe(-1)
    // Everest-ish
    expect(terrariumElevation(162, 144, 0)).toBe(8848)
  })

  it('pads a 2x2 tile, rows south first, edges copied into the border', () => {
    // image rows north first: north row 1000 m, 2000 m; south row 3000 m, 4000 m
    const px = (m: number) => [128 + Math.floor(m / 256), m % 256, 0, 255]
    const rgba = [...px(1000), ...px(2000), ...px(3000), ...px(4000)]
    const { data, width, height } = decodeTerrariumPadded(rgba, 2, 2)
    expect([width, height]).toEqual([4, 4])
    const rows = [0, 1, 2, 3].map((y) => Array.from(data.subarray(y * 4, y * 4 + 4)))
    expect(rows).toEqual([
      [3000, 3000, 4000, 4000],
      [3000, 3000, 4000, 4000],
      [1000, 1000, 2000, 2000],
      [1000, 1000, 2000, 2000],
    ])
  })

  it('makes a sea-level grid the size a decoded tile would be', () => {
    const grid = flatGrid(512)
    expect([grid.width, grid.height, grid.data.length]).toEqual([514, 514, 514 * 514])
    expect(grid.data.every((v) => v === 0)).toBe(true)
  })
})
