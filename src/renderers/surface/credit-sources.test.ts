import { describe, expect, test } from 'vitest'
import { ActiveSources, sourcesForTile, tileOnNearSide, tileRadianBounds, type RadianBounds } from './credit-sources'
import { tileBounds } from './imagery'

const RAD = Math.PI / 180
const rad = (z: number, x: number, y: number): RadianBounds => {
  const b = tileBounds({ z, x, y })
  return { west: b.west * RAD, south: b.south * RAD, east: b.east * RAD, north: b.north * RAD }
}

describe('sourcesForTile', () => {
  test('a tile in the Grand Canyon takes Mapterhorn and USGS', () => {
    // z10 tile over 36.1N 112.1W
    expect(sourcesForTile(rad(10, 192, 405))).toEqual(['mapterhorn', 'usgs'])
  })
  test('a tile in the Alps takes Mapterhorn and EOX', () => {
    expect(sourcesForTile(rad(10, 541, 361))).toEqual(['mapterhorn', 'eox'])
  })
  test('a coarse tile straddling a box edge names both imagery sources', () => {
    expect(sourcesForTile(rad(5, 6, 12))).toEqual(['mapterhorn', 'usgs', 'eox'])
  })
  test('a tile wholly in Canada takes EOX only', () => {
    expect(sourcesForTile(rad(8, 50, 80))).toEqual(['mapterhorn', 'eox'])
  })
})

describe('tileOnNearSide', () => {
  const R = 6371000
  // 3 km over (36.1N, 112.1W)
  const eye = (h: number, lat = 36.1, lon = -112.1) => ({
    x: (R + h) * Math.cos(lat * RAD) * Math.cos(lon * RAD),
    y: (R + h) * Math.cos(lat * RAD) * Math.sin(lon * RAD),
    z: (R + h) * Math.sin(lat * RAD),
  })
  test('counts the tile underneath and drops the one on the far side of the planet', () => {
    expect(tileOnNearSide(rad(10, 192, 405), eye(3000))).toBe(true)
    // the antipode, in the Indian Ocean
    expect(tileOnNearSide({ west: 67 * RAD, east: 68 * RAD, south: -37 * RAD, north: -36 * RAD }, eye(3000))).toBe(false)
  })
  test('sees more of the world from orbit', () => {
    const europe = rad(4, 8, 5)
    expect(tileOnNearSide(europe, eye(3000))).toBe(false)
    expect(tileOnNearSide(rad(2, 0, 1), eye(6000000))).toBe(true)
  })
})

describe('tileRadianBounds', () => {
  test('reads a region volume and tolerates the root', () => {
    expect(tileRadianBounds({ boundingVolume: { region: [1, 2, 3, 4, 0, 1] } })).toEqual({
      west: 1, south: 2, east: 3, north: 4,
    })
    expect(tileRadianBounds({ boundingVolume: {} })).toBeNull()
    expect(tileRadianBounds({})).toBeNull()
  })
})

describe('ActiveSources', () => {
  test('is empty with no tiles', () => {
    expect(new ActiveSources().update([], 0)).toEqual([])
  })
  test('names sources in a stable order, whatever order they arrive in', () => {
    expect(new ActiveSources().update(['eox', 'mapterhorn'], 0)).toEqual(['mapterhorn', 'eox'])
  })
  test('holds a source for the linger, then drops it', () => {
    const a = new ActiveSources(1000)
    a.update(['mapterhorn', 'usgs'], 0)
    expect(a.update(['mapterhorn', 'eox'], 500)).toEqual(['mapterhorn', 'usgs', 'eox'])
    expect(a.update(['mapterhorn', 'eox'], 1200)).toEqual(['mapterhorn', 'eox'])
    expect(a.update([], 2300)).toEqual([])
  })
  test('returns the same array while nothing changes', () => {
    const a = new ActiveSources()
    const first = a.update(['mapterhorn'], 0)
    expect(a.update(['mapterhorn'], 100)).toBe(first)
  })
})
