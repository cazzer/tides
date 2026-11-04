import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  HUGHES_E,
  NORTH_GRID,
  RHO_SCALE,
  SEA_ICE_GRID_GLSL,
  SOUTH_GRID,
  dayShare,
  extentOn,
  gridLatLon,
  gridPoint,
  sampleGrid,
  seaIceDataDate,
  seaIceDay,
  seaIceFrames,
  unpackSeaIce,
} from './sea-ice'

const ice = unpackSeaIce(new Uint8Array(gunzipSync(readFileSync('src/assets/sea-ice-2025.bin'))))

/** Cells at least 15% covered: a rough check, not the index's own extent. */
function coveredCells(cells: Uint8Array): number {
  let n = 0
  for (const v of cells) if (v >= 0.15 * 255) n++
  return n
}

describe('gridPoint', () => {
  // NSIDC's published grid corners (outer edges of the corner cells).
  it.each([
    [NORTH_GRID, 30.98, 168.35, 0, 0],
    [NORTH_GRID, 34.35, 350.03, 304, 448],
    [NORTH_GRID, 33.92, 279.26, 0, 448],
    [SOUTH_GRID, -39.23, 317.76, 0, 0],
    [SOUTH_GRID, -39.26, 42.24, 316, 0],
    [SOUTH_GRID, -41.45, 135, 316, 332],
    [SOUTH_GRID, -41.51, 225, 0, 332],
  ])('puts a corner of the grid at its corner', (grid, lat, lon, col, row) => {
    const p = gridPoint(grid, lat, lon)
    expect(Math.abs(p.col - col)).toBeLessThan(0.25)
    expect(Math.abs(p.row - row)).toBeLessThan(0.25)
  })

  it('puts the poles where the grids have them', () => {
    expect(gridPoint(NORTH_GRID, 90, 0)).toEqual({ col: expect.closeTo(154, 6), row: expect.closeTo(234, 6) })
    expect(gridPoint(SOUTH_GRID, -90, 0)).toEqual({ col: expect.closeTo(158, 6), row: expect.closeTo(174, 6) })
  })
})

describe('gridLatLon', () => {
  it('inverts gridPoint to a hundredth of a cell over both grids', () => {
    for (const grid of [NORTH_GRID, SOUTH_GRID]) {
      for (let row = 0.5; row < grid.height; row += 13) {
        for (let col = 0.5; col < grid.width; col += 11) {
          const { lat, lon } = gridLatLon(grid, col, row)
          expect(Math.sign(lat)).toBe(grid.sign)
          const p = gridPoint(grid, lat, lon)
          expect(Math.abs(p.col - col)).toBeLessThan(0.01)
          expect(Math.abs(p.row - row)).toBeLessThan(0.01)
        }
      }
    }
  })

  it('finds the poles at the grids\' poles and the corners at NSIDC\'s', () => {
    expect(gridLatLon(NORTH_GRID, 154, 234).lat).toBeCloseTo(90, 6)
    expect(gridLatLon(SOUTH_GRID, 158, 174).lat).toBeCloseTo(-90, 6)
    const corner = gridLatLon(NORTH_GRID, 0, 0)
    expect(corner.lat).toBeCloseTo(30.98, 1)
    expect(corner.lon).toBeCloseTo(168.35, 1)
    expect(gridLatLon(SOUTH_GRID, 316, 332).lon).toBeCloseTo(135, 1)
  })
})

// SEA_ICE_GRID_GLSL's sums, line for line, in double.
function gridCellsMirror(dir: [number, number, number]) {
  const [x, y, z] = dir
  const north = y >= 0
  const sgn = north ? 1 : -1
  const grid = north ? NORTH_GRID : SOUTH_GRID
  const sinLat = Math.abs(y)
  const lon0 = [Math.cos((grid.lon0 * Math.PI) / 180), Math.sin((grid.lon0 * Math.PI) / 180)]
  const k = RHO_SCALE / ((1 + sinLat) * Math.pow((1 - HUGHES_E * sinLat) / (1 + HUGHES_E * sinLat), HUGHES_E / 2))
  const east = -z * lon0[0] - x * lon0[1]
  const along = x * lon0[0] - z * lon0[1]
  const xy = [k * east, k * -sgn * along]
  return { col: (xy[0] - grid.x0) / grid.cell, row: (grid.y0 - xy[1]) / grid.cell }
}

/** The unit direction at (lat, lon) degrees in Earth's local frame (Y north, lon 0 at +X, east towards -Z). */
function direction(lat: number, lon: number): [number, number, number] {
  const la = (lat * Math.PI) / 180
  const lo = (lon * Math.PI) / 180
  return [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)]
}

describe('SEA_ICE_GRID_GLSL', () => {
  const glsl = SEA_ICE_GRID_GLSL('cellsOf')

  it('is a function of the direction alone, with no asin or atan', () => {
    expect(glsl).toContain('vec2 cellsOf(vec3 dir) {')
    expect(glsl).not.toMatch(/\basin\b|\batan\b/)
    expect(glsl).toContain(RHO_SCALE.toFixed(9))
    expect(glsl).toContain(HUGHES_E.toFixed(9))
    expect(glsl).toContain(`vec2(${NORTH_GRID.x0.toFixed(9)}, ${NORTH_GRID.y0.toFixed(9)})`)
    expect(glsl).toContain(`vec2(${SOUTH_GRID.x0.toFixed(9)}, ${SOUTH_GRID.y0.toFixed(9)})`)
    expect(NORTH_GRID.cell).toBe(SOUTH_GRID.cell)
  })

  it('puts a direction on the grids where gridPoint puts its latitude and longitude, at both poles', () => {
    let checked = 0
    for (let lat = -89.75; lat <= 89.75; lat += 2.5) {
      if (Math.abs(lat) < 30) continue
      for (let lon = -180; lon < 180; lon += 7.5) {
        const got = gridCellsMirror(direction(lat, lon))
        const want = gridPoint(lat >= 0 ? NORTH_GRID : SOUTH_GRID, lat, lon)
        expect(Math.abs(got.col - want.col)).toBeLessThan(1e-3)
        expect(Math.abs(got.row - want.row)).toBeLessThan(1e-3)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(1000)
    // The poles themselves: no singularity.
    expect(gridCellsMirror([0, 1, 0])).toEqual({ col: expect.closeTo(154, 6), row: expect.closeTo(234, 6) })
    expect(gridCellsMirror([0, -1, 0])).toEqual({ col: expect.closeTo(158, 6), row: expect.closeTo(174, 6) })
  })
})

describe('the shipped year', () => {
  it('is 2025, every 7 days, both grids, with a daily extent for each day', () => {
    expect(ice.year).toBe(2025)
    expect(ice.stepDays).toBe(7)
    expect(ice.north.frames).toHaveLength(53)
    expect(ice.south.frames).toHaveLength(53)
    expect([ice.north.width, ice.north.height, ice.south.width, ice.south.height]).toEqual([304, 448, 316, 332])
    expect(ice.extentNorth).toHaveLength(365)
    expect(ice.extentSouth).toHaveLength(365)
  })

  // NSIDC's own 2025 numbers (v4): the Arctic's peak, 14.35 million km² on
  // 21 March; its low, 4.54 on 8 September; the Antarctic's peak, 17.85 on 15
  // September, and its low, 1.96 on 1 March.
  it('peaks in March in the Arctic and in September round Antarctica', () => {
    const argmax = (a: Float32Array) => a.indexOf(Math.max(...a))
    const argmin = (a: Float32Array) => a.indexOf(Math.min(...a))
    expect(argmax(ice.extentNorth)).toBeGreaterThan(59) // March
    expect(argmax(ice.extentNorth)).toBeLessThan(100)
    expect(argmin(ice.extentNorth)).toBeGreaterThan(220) // September
    expect(argmin(ice.extentNorth)).toBeLessThan(275)
    expect(argmax(ice.extentSouth)).toBeGreaterThan(220)
    expect(argmin(ice.extentSouth)).toBeLessThan(70) // Feb-Mar
    expect(Math.max(...ice.extentNorth)).toBeCloseTo(14.35, 2)
    expect(Math.max(...ice.extentSouth)).toBeCloseTo(17.85, 2)
  })

  it('has far more Arctic ice on the grid in March than in September, and the reverse in the south', () => {
    const march = 11 // 19 March
    const september = 37 // 17 September
    expect(coveredCells(ice.north.frames[march])).toBeGreaterThan(2.5 * coveredCells(ice.north.frames[september]))
    expect(coveredCells(ice.south.frames[september])).toBeGreaterThan(4 * coveredCells(ice.south.frames[march]))
  })

  it('has the North Pole iced all year and the equator-side corners clear', () => {
    for (const frame of ice.north.frames) {
      const pole = gridPoint(NORTH_GRID, 90, 0)
      expect(sampleGrid(frame, 304, 448, pole.col, pole.row)).toBeGreaterThan(0.9)
      // The mid-Atlantic, 40°N 30°W.
      const atlantic = gridPoint(NORTH_GRID, 40, -30)
      expect(sampleGrid(frame, 304, 448, atlantic.col, atlantic.row)).toBe(0)
    }
  })

  it('freezes Hudson Bay in March and clears it in September', () => {
    const bay = gridPoint(NORTH_GRID, 60, -86)
    expect(sampleGrid(ice.north.frames[11], 304, 448, bay.col, bay.row)).toBeGreaterThan(0.8)
    expect(sampleGrid(ice.north.frames[37], 304, 448, bay.col, bay.row)).toBe(0)
  })
})

describe('sampleGrid', () => {
  it('blends between cells and reads 0 off the grid', () => {
    const cells = new Uint8Array([0, 255, 255, 255])
    expect(sampleGrid(cells, 2, 2, 1.5, 0.5)).toBe(1)
    expect(sampleGrid(cells, 2, 2, 1, 0.5)).toBeCloseTo(0.5)
    expect(sampleGrid(cells, 2, 2, -5, 0.5)).toBe(0)
    expect(sampleGrid(cells, 2, 2, 1, 9)).toBe(0)
  })
})

describe('seaIceDay and seaIceFrames', () => {
  it('reads the same date of the year, leap years scaled', () => {
    expect(seaIceDay(Date.parse('2026-01-01T00:00:00Z'))).toBe(0)
    expect(seaIceDay(Date.parse('2026-03-20T12:00:00Z'))).toBeCloseTo(78.5, 5)
    expect(seaIceDay(Date.parse('2028-12-31T00:00:00Z'))).toBeCloseTo((365 / 366) * 365, 5)
    expect(seaIceDataDate(Date.parse('2026-03-20T14:45:42Z'), 2025)).toBe('20 Mar 2025')
    expect(seaIceDataDate(Date.parse('2027-01-03T02:07:49Z'), 2025)).toBe('3 Jan 2025')
  })

  it('blends between the weekly frames, and from 31 December into 1 January', () => {
    expect(seaIceFrames(0, 7, 53)).toEqual({ a: 0, b: 1, mix: 0 })
    expect(seaIceFrames(10.5, 7, 53)).toEqual({ a: 1, b: 2, mix: 0.5 })
    expect(seaIceFrames(364, 7, 53)).toEqual({ a: 52, b: 0, mix: 0 })
    expect(seaIceFrames(364.5, 7, 53)).toEqual({ a: 52, b: 0, mix: 0.5 })
    expect(seaIceFrames(365, 7, 53)).toEqual({ a: 52, b: 0, mix: 1 })
  })

  it('reads the extent between days', () => {
    const extents = new Float32Array([1, 2, 4])
    expect(extentOn(extents, 0.5)).toBeCloseTo(1.5)
    expect(extentOn(extents, 1.5)).toBeCloseTo(3)
    expect(extentOn(extents, 9)).toBe(4)
    expect(extentOn(ice.extentNorth, seaIceDay(Date.parse('2026-03-21T00:00:00Z')))).toBeCloseTo(14.35, 2)
  })
})

describe('dayShare', () => {
  it('is half everywhere at an equinox, none and all at the poles at a solstice', () => {
    expect(dayShare(45, 0)).toBeCloseTo(0.5)
    expect(dayShare(80, 23.44)).toBe(1)
    expect(dayShare(80, -23.44)).toBe(0)
    expect(dayShare(-80, -23.44)).toBe(1)
    expect(dayShare(60, 23.44)).toBeGreaterThan(0.7)
  })
})
