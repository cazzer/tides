import { describe, expect, it } from 'vitest'
import { holdRealTime, systemSurfaceTilesOn } from './close-zoom-rules'

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
  it('mounts the tiles only with them on, in the main view, in close zoom, in Earth focus', () => {
    const on = { tilesOn: true, interactive: true, closeZoom: true, cameraFocus: 'earth' }
    expect(systemSurfaceTilesOn(on)).toBe(true)
    expect(systemSurfaceTilesOn({ ...on, tilesOn: false })).toBe(false)
    expect(systemSurfaceTilesOn({ ...on, interactive: false })).toBe(false)
    expect(systemSurfaceTilesOn({ ...on, closeZoom: false })).toBe(false)
    expect(systemSurfaceTilesOn({ ...on, cameraFocus: 'moon' })).toBe(false)
    expect(systemSurfaceTilesOn({ ...on, cameraFocus: null })).toBe(false)
    expect(systemSurfaceTilesOn({ tilesOn: false, interactive: false, closeZoom: false, cameraFocus: 'sun' })).toBe(false)
  })
})
