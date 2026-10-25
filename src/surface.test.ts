import { describe, expect, it } from 'vitest'
import { parseSurface, SURFACE, SURFACE_TILES_ON, surfaceTilesOn } from './surface'

describe('parseSurface (tides-zmw.9.1)', () => {
  it('turns the surface tiles on only for surface=1', () => {
    expect(parseSurface('?surface=1')).toBe(true)
    expect(parseSurface('?ship=1&surface=1&quality=high')).toBe(true)
  })

  it('leaves them off when absent, 0, true or junk', () => {
    for (const search of ['', '?ship=1', '?surface=0', '?surface=true', '?surface=', '?surface=yes', '?surface=01'])
      expect(parseSurface(search)).toBe(false)
  })

  it('is off outside a browser', () => {
    expect(SURFACE).toBe(false)
    expect(SURFACE_TILES_ON).toBe(false)
  })
})

describe('surfaceTilesOn (tides-zmw.9.1)', () => {
  it('mounts the tiles on the high tier only', () => {
    expect(surfaceTilesOn(true, false)).toBe(true)
    expect(surfaceTilesOn(true, true)).toBe(false)
    expect(surfaceTilesOn(false, false)).toBe(false)
    expect(surfaceTilesOn(false, true)).toBe(false)
  })
})
