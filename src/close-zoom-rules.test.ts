import { describe, expect, it } from 'vitest'
import { TILE_RANGE_ENTER, TILE_RANGE_LEAVE, holdRealTime, isTileRange, systemSurfaceTilesOn } from './close-zoom-rules'

describe('holdRealTime', () => {
  it('holds faster speeds at real time in close zoom, keeping their direction, with a cue', () => {
    expect(holdRealTime(3600, true)).toEqual({ timeScale: 1, cue: true })
    expect(holdRealTime(-86400, true)).toEqual({ timeScale: -1, cue: true })
  })

  it('leaves real time, slower and paused as they are', () => {
    expect(holdRealTime(1, true)).toEqual({ timeScale: 1, cue: false })
    expect(holdRealTime(0, true)).toEqual({ timeScale: 0, cue: false })
    expect(holdRealTime(-1, true)).toEqual({ timeScale: -1, cue: false })
  })

  it('leaves everything as it is outside close zoom', () => {
    expect(holdRealTime(3600, false)).toEqual({ timeScale: 3600, cue: false })
  })
})

describe('systemSurfaceTilesOn', () => {
  it('mounts the tiles only with them on, in the main view in the main slot, in their close zoom range, in Earth focus', () => {
    const on = { tilesOn: true, interactive: true, mainSlot: true, closeZoomTiles: true, cameraFocus: 'earth' }
    expect(systemSurfaceTilesOn(on)).toBe(true)
    expect(systemSurfaceTilesOn({ ...on, tilesOn: false })).toBe(false)
    expect(systemSurfaceTilesOn({ ...on, interactive: false })).toBe(false)
    expect(systemSurfaceTilesOn({ ...on, mainSlot: false })).toBe(false)
    expect(systemSurfaceTilesOn({ ...on, closeZoomTiles: false })).toBe(false)
    expect(systemSurfaceTilesOn({ ...on, cameraFocus: 'moon' })).toBe(false)
    expect(systemSurfaceTilesOn({ ...on, cameraFocus: null })).toBe(false)
    expect(systemSurfaceTilesOn({ tilesOn: false, interactive: false, mainSlot: false, closeZoomTiles: false, cameraFocus: 'sun' })).toBe(false)
  })
})

describe('isTileRange', () => {
  const top = 0.05
  it('enters below twice the handover top and leaves only above 2.2 tops', () => {
    expect([TILE_RANGE_ENTER, TILE_RANGE_LEAVE]).toEqual([2, 2.2])
    expect(isTileRange(2.01 * top, top, false)).toBe(false)
    expect(isTileRange(1.99 * top, top, false)).toBe(true)
    // Backing out between the two stays in range…
    expect(isTileRange(2.1 * top, top, true)).toBe(true)
    // …until past the leave edge.
    expect(isTileRange(2.21 * top, top, true)).toBe(false)
    expect(isTileRange(0, top, false)).toBe(true)
  })
})
