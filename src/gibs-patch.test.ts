import { describe, expect, it, vi } from 'vitest'
import {
  createGibsTileStore,
  GIBS_COLS,
  GIBS_GROUND_WIDTH,
  GIBS_ROWS,
  gibsGroundTileUrl,
  gibsNightTileUrl,
  gibsPatchReachDeg,
  gibsPatchSide,
  gibsPatchTiles,
  gibsTileAt,
  nextGibsPatchOrigin,
  NIGHT_PATCH_HOLD_DEG,
  NIGHT_PATCH_SUN_DEG,
  nightPatchWanted,
} from './gibs-patch'

describe('GIBS ground tiles', () => {
  it('reads Blue Marble NG from level 7 of the 500m matrix, 81920 px around', () => {
    expect(gibsGroundTileUrl(20, 40)).toBe(
      'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/500m/7/20/40.jpeg'
    )
    expect(GIBS_GROUND_WIDTH).toBe(81920)
    expect(GIBS_COLS / GIBS_ROWS).toBe(2)
  })

  it("reads VIIRS's 2012 city lights from the same matrix, at its one date", () => {
    expect(gibsNightTileUrl(18, 81)).toBe(
      'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/VIIRS_CityLights_2012/default/2016-01-01/500m/7/18/81.jpeg'
    )
  })

  it('caps phones and tablets at a 2048 px patch and skips GPUs without 4k', () => {
    expect(gibsPatchSide(8192)).toBe(8)
    expect(gibsPatchSide(4096)).toBe(4)
    expect(gibsPatchSide(null)).toBe(0)
    // Slots stay put across the antimeridian only if the side divides it.
    for (const side of [8, 4]) expect(GIBS_COLS % side).toBe(0)
  })

  it("finds the tile under a day-map coordinate (u east from 180 W, v north from the south pole)", () => {
    // 88.9 W, 43.9 N: tiles are 2.25 deg.
    expect(gibsTileAt((180 - 88.9) / 360, (90 + 43.9) / 180)).toEqual({ row: 20, col: 40 })
    expect(gibsTileAt(0, 1)).toEqual({ row: 0, col: 0 })
    expect(gibsTileAt(1, 0)).toEqual({ row: GIBS_ROWS - 1, col: 0 })
    expect(gibsTileAt(-0.001, 0.5)).toEqual({ row: 40, col: GIBS_COLS - 1 })
  })
})

describe('GIBS patch placement', () => {
  it('centres on the ship and holds while it stays in the middle two tiles', () => {
    const start = nextGibsPatchOrigin({ row: 20, col: 40 }, 8, null)
    expect(start).toEqual({ row: 16, col: 36 })
    expect(nextGibsPatchOrigin({ row: 19, col: 39 }, 8, start)).toBe(start)
    expect(nextGibsPatchOrigin({ row: 20, col: 40 }, 8, start)).toBe(start)
    expect(nextGibsPatchOrigin({ row: 20, col: 41 }, 8, start)).toEqual({ row: 16, col: 37 })
    expect(nextGibsPatchOrigin({ row: 21, col: 40 }, 8, start)).toEqual({ row: 17, col: 36 })
  })

  it('moves a tile at a time going west and north too, and a jitter back does not move it', () => {
    const start = { row: 16, col: 36 }
    const west = nextGibsPatchOrigin({ row: 20, col: 38 }, 8, start)
    expect(west).toEqual({ row: 16, col: 35 })
    expect(nextGibsPatchOrigin({ row: 20, col: 39 }, 8, west)).toBe(west)
    const north = nextGibsPatchOrigin({ row: 18, col: 40 }, 8, start)
    expect(north).toEqual({ row: 15, col: 36 })
    expect(nextGibsPatchOrigin({ row: 19, col: 40 }, 8, north)).toBe(north)
    // Westward across the antimeridian, the short way round.
    expect(nextGibsPatchOrigin({ row: 40, col: 159 }, 8, { row: 36, col: 157 })).toEqual({ row: 36, col: 156 })
    // A jump far from the patch still lands the ship in its middle.
    const far = nextGibsPatchOrigin({ row: 60, col: 100 }, 8, start)
    expect(100 - far.col).toBeGreaterThanOrEqual(3)
    expect(100 - far.col).toBeLessThanOrEqual(4)
    expect(60 - far.row).toBeGreaterThanOrEqual(3)
    expect(60 - far.row).toBeLessThanOrEqual(4)
  })

  it('wraps across the antimeridian and stops at the poles', () => {
    expect(nextGibsPatchOrigin({ row: 40, col: 1 }, 8, null)).toEqual({ row: 36, col: 157 })
    const north = nextGibsPatchOrigin({ row: 1, col: 10 }, 8, null)
    expect(north).toEqual({ row: 0, col: 6 })
    // Held against the pole as the ship moves toward it.
    expect(nextGibsPatchOrigin({ row: 0, col: 10 }, 8, north)).toBe(north)
    expect(nextGibsPatchOrigin({ row: 79, col: 10 }, 8, null)).toEqual({ row: GIBS_ROWS - 8, col: 6 })
  })

  it('gives every tile its own slot, nearest the ship first', () => {
    const tiles = gibsPatchTiles({ row: 36, col: 157 }, 8, { row: 40, col: 1 })
    expect(tiles).toHaveLength(64)
    expect(new Set(tiles.map((t) => t.slot)).size).toBe(64)
    expect(tiles[0]).toMatchObject({ row: 40, col: 1 })
    expect(tiles.map((t) => t.col)).toContain(0)
    expect(Math.max(...tiles.map((t) => t.col))).toBe(159)
  })

  it('names its tiles from the layer it is given, the day imagery unless told', () => {
    const night = gibsPatchTiles({ row: 16, col: 36 }, 4, { row: 18, col: 38 }, gibsNightTileUrl)
    expect(night.map((t) => t.url)).toEqual(night.map((t) => gibsNightTileUrl(t.row, t.col)))
    const day = gibsPatchTiles({ row: 16, col: 36 }, 4, { row: 18, col: 38 })
    expect(day.map((t) => t.url)).toEqual(day.map((t) => gibsGroundTileUrl(t.row, t.col)))
    expect(night.map((t) => [t.row, t.col, t.slot])).toEqual(day.map((t) => [t.row, t.col, t.slot]))
  })

  it('keeps the tiles a one-tile move shares in their slots, so only a column refills', () => {
    const before = gibsPatchTiles({ row: 16, col: 36 }, 8, { row: 20, col: 40 })
    const after = gibsPatchTiles({ row: 16, col: 37 }, 8, { row: 20, col: 41 })
    const slotOf = new Map(before.map((t) => [t.url, t.slot]))
    const refilled = after.filter((t) => slotOf.get(t.url) !== t.slot)
    expect(refilled).toHaveLength(8)
    expect(new Set(refilled.map((t) => t.col))).toEqual(new Set([44]))
  })
})

describe('GIBS night patch', () => {
  const sinDeg = (deg: number) => Math.sin((deg * Math.PI) / 180)

  it('reaches out to a corner of the patch and the tile beyond its middle', () => {
    expect(gibsPatchReachDeg(8)).toBeCloseTo(15.91, 2)
    expect(gibsPatchReachDeg(4)).toBeCloseTo(9.55, 2)
  })

  it('streams while the Sun is down within reach of the sub-point, and holds a few degrees longer', () => {
    for (const side of [8, 4]) {
      const start = NIGHT_PATCH_SUN_DEG + gibsPatchReachDeg(side)
      const hold = start + NIGHT_PATCH_HOLD_DEG
      expect(nightPatchWanted(sinDeg(-90), side, false)).toBe(true)
      expect(nightPatchWanted(sinDeg(start - 0.1), side, false)).toBe(true)
      expect(nightPatchWanted(sinDeg(start + 0.1), side, false)).toBe(false)
      expect(nightPatchWanted(sinDeg(start + 0.1), side, true)).toBe(true)
      expect(nightPatchWanted(sinDeg(hold - 0.1), side, true)).toBe(true)
      expect(nightPatchWanted(sinDeg(hold + 0.1), side, true)).toBe(false)
      expect(nightPatchWanted(sinDeg(90), side, true)).toBe(false)
    }
  })
})

describe('GIBS tile store', () => {
  it('fetches each tile once and counts the requests', async () => {
    const fetchBlob = vi.fn(async (url: string) => new Blob([url]))
    const store = createGibsTileStore(fetchBlob, 10)
    await store.get('a')
    await store.get('a')
    await store.get('b')
    expect(fetchBlob).toHaveBeenCalledTimes(2)
    expect(store.requests).toBe(2)
  })

  it('drops the least recently used past its limit', async () => {
    const fetchBlob = vi.fn(async (url: string) => new Blob([url]))
    const store = createGibsTileStore(fetchBlob, 2)
    await store.get('a')
    await store.get('b')
    await store.get('a')
    await store.get('c')
    await store.get('a')
    expect(fetchBlob).toHaveBeenCalledTimes(3)
    await store.get('b')
    expect(fetchBlob).toHaveBeenCalledTimes(4)
  })

  it('forgets a failure, so the next call tries again', async () => {
    let fail = true
    const store = createGibsTileStore(async () => {
      if (fail) throw new Error('offline')
      return new Blob(['ok'])
    }, 10)
    await expect(store.get('a')).rejects.toThrow('offline')
    fail = false
    await expect(store.get('a')).resolves.toBeInstanceOf(Blob)
    expect(store.requests).toBe(2)
  })
})
