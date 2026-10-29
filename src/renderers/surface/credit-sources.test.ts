import { describe, expect, test } from 'vitest'
import {
  ActiveSources,
  creditsShown,
  imageryTileFor,
  sourcesForTile,
  tileOnNearSide,
  tileRadianBounds,
  type RadianBounds,
} from './credit-sources'
import * as THREE from 'three'
import { applySurfaceFrame, surfaceEcef } from './surface-frame'
import { tileBounds } from './imagery'

const RAD = Math.PI / 180
const rad = (z: number, x: number, y: number): RadianBounds => {
  const b = tileBounds({ z, x, y })
  return { west: b.west * RAD, south: b.south * RAD, east: b.east * RAD, north: b.north * RAD }
}

describe('sourcesForTile', () => {
  test('a tile in the Grand Canyon takes Mapterhorn and USGS, and EOX (tides-zmw.9.11: its colour is matched and anchored through EOX)', () => {
    // z10 tile over 36.1N 112.1W
    expect(sourcesForTile(rad(10, 192, 405))).toEqual(['mapterhorn', 'usgs', 'eox'])
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

describe("tileOnNearSide through the tiles' group", () => {
  test('the eye turned into the group frame sees the tile below it and not the antipode', () => {
    const parent = new THREE.Group() // Earth's tilt and spin
    parent.rotation.set(0.4, 1.1, -0.2)
    parent.position.set(3, -2, 5)
    const group = new THREE.Group()
    applySurfaceFrame(group)
    parent.add(group)
    parent.updateWorldMatrix(true, true)
    const eyeWorld = group.localToWorld(surfaceEcef(36.1, -112.1, 3000).multiplyScalar(1)) // metres in group-local
    const eye = group.worldToLocal(eyeWorld.clone())
    expect(tileOnNearSide(rad(10, 192, 405), eye)).toBe(true)
    expect(tileOnNearSide({ west: 67 * RAD, east: 68 * RAD, south: -37 * RAD, north: -36 * RAD }, eye)).toBe(false)
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

describe('EOX standing in for USGS (tides-zmw.9.2)', () => {
  test('finds the imagery tile a terrain tile drapes, clamped to the deepest imagery level', () => {
    expect(imageryTileFor(rad(10, 192, 405))).toEqual({ z: 10, x: 192, y: 405 })
    expect(imageryTileFor(rad(16, 12355, 25721))).toEqual({ z: 16, x: 12355, y: 25721 })
    expect(imageryTileFor(rad(17, 24711, 51443))).toEqual({ z: 16, x: 12355, y: 25721 })
  })
  test('credits EOX, not USGS, for a tile in a US box whose imagery EOX served', () => {
    const offBigSur = rad(11, 326, 801) // inside CONUS west, over the Pacific
    expect(sourcesForTile(offBigSur)).toEqual(['mapterhorn', 'usgs', 'eox'])
    const served = new Set(['11/326/801'])
    const byEox = ({ z, x, y }: { z: number; x: number; y: number }) => served.has(`${z}/${x}/${y}`)
    expect(sourcesForTile(offBigSur, byEox)).toEqual(['mapterhorn', 'eox'])
    // its land neighbour keeps USGS; outside the boxes nothing changes
    expect(sourcesForTile(rad(11, 327, 801), byEox)).toEqual(['mapterhorn', 'usgs', 'eox'])
    expect(sourcesForTile(rad(10, 541, 361), byEox)).toEqual(['mapterhorn', 'eox'])
  })
})

describe('creditsShown', () => {
  test('in flight always; in the system view only while the tiles draw', () => {
    expect(creditsShown('ship', true)).toBe(true)
    expect(creditsShown('ship', false)).toBe(true)
    expect(creditsShown('system', true)).toBe(true)
    expect(creditsShown('system', false)).toBe(false)
  })
})
