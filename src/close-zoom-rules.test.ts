import { describe, expect, it } from 'vitest'
import {
  TILE_LEAVE_GRACE_S,
  TILE_RANGE_ENTER,
  TILE_RANGE_LEAVE,
  holdRealTime,
  isTileRange,
  stepTileGate,
  stepTileMount,
  systemSurfaceTilesOn,
  type TileGate,
  type TileMount,
} from './close-zoom-rules'

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

describe('stepTileMount', () => {
  const unmounted = (): TileMount => ({ mounted: false, outFor: 0 })
  const mounted = (): TileMount => ({ mounted: true, outFor: 0 })
  /** Steps `m` out of range in close zoom `n` times by `dt`, returning the last result. */
  const stepOut = (m: TileMount, n: number, dt: number) => {
    let on = m.mounted
    for (let i = 0; i < n; i++) on = stepTileMount(m, true, false, dt)
    return on
  }

  it('pins the grace at 10 s', () => {
    expect(TILE_LEAVE_GRACE_S).toBe(10)
  })

  it('mounts at once in range, with no timer', () => {
    const m = unmounted()
    expect(stepTileMount(m, true, true, 0.016)).toBe(true)
    expect(m).toEqual({ mounted: true, outFor: 0 })
  })

  it('never mounted and out of range: stays unmounted, with no timer', () => {
    const m = unmounted()
    expect(stepOut(m, 200, 0.1)).toBe(false)
    expect(m).toEqual({ mounted: false, outFor: 0 })
  })

  it('stays mounted through a leave inside the grace', () => {
    const m = mounted()
    expect(stepOut(m, 99, 0.1)).toBe(true)
    expect(m.mounted).toBe(true)
    expect(m.outFor).toBeCloseTo(9.9)
  })

  it('resets the timer on re-entering the range', () => {
    const m = mounted()
    expect(stepOut(m, 99, 0.1)).toBe(true)
    expect(stepTileMount(m, true, true, 0.1)).toBe(true)
    expect(m.outFor).toBe(0)
    expect(stepOut(m, 99, 0.1)).toBe(true)
  })

  it('unmounts once a sustained leave crosses the grace, and stays unmounted', () => {
    const m = mounted()
    expect(stepOut(m, 99, 0.1)).toBe(true)
    expect(stepOut(m, 2, 0.1)).toBe(false)
    expect(m).toEqual({ mounted: false, outFor: 0 })
    expect(stepOut(m, 50, 0.1)).toBe(false)
    expect(m.outFor).toBe(0)
  })

  it('unmounts on a single step of the grace or longer', () => {
    const at = mounted()
    expect(stepTileMount(at, true, false, 10)).toBe(false)
    expect(at).toEqual({ mounted: false, outFor: 0 })
    const over = mounted()
    expect(stepTileMount(over, true, false, 12)).toBe(false)
    expect(over).toEqual({ mounted: false, outFor: 0 })
  })

  it('unmounts at once out of close zoom, mid-grace or in range', () => {
    const mid = mounted()
    stepOut(mid, 50, 0.1)
    expect(stepTileMount(mid, false, false, 0.016)).toBe(false)
    expect(mid).toEqual({ mounted: false, outFor: 0 })
    const inRange = mounted()
    expect(stepTileMount(inRange, false, true, 0.016)).toBe(false)
    expect(inRange).toEqual({ mounted: false, outFor: 0 })
  })
})

describe('stepTileGate', () => {
  // In km: the tiles' range then enters below 200 and leaves above 220.
  const top = 100
  const dt = 0.1
  const gate = (): TileGate => ({ range: false, mount: { mounted: false, outFor: 0 } })

  it('keeps the tiles mounted through a tilt flapping across the range for a minute (tides-8h7)', () => {
    const g = gate()
    expect(stepTileGate(g, true, true, 150, top, dt)).toBe(true)
    let unmounted = 0
    for (let i = 0; i < 600; i++) {
      const altitude = Math.floor(i / 30) % 2 === 0 ? 260 : 150
      if (!stepTileGate(g, true, true, altitude, top, dt)) unmounted++
      // The range follows the eye, not the grace.
      expect(g.range).toBe(altitude === 150)
    }
    expect(unmounted).toBe(0)
  })

  it('unmounts a hold above the range between 10 and 10.2 s, and stays unmounted', () => {
    const g = gate()
    expect(stepTileGate(g, true, true, 150, top, dt)).toBe(true)
    let steps = 0
    while (stepTileGate(g, true, true, 260, top, dt)) steps++
    const outFor = (steps + 1) * dt
    expect(outFor).toBeGreaterThanOrEqual(10 - 1e-9)
    expect(outFor).toBeLessThanOrEqual(10.2)
    for (let i = 0; i < 100; i++) expect(stepTileGate(g, true, true, 260, top, dt)).toBe(false)
    expect(g.mount).toEqual({ mounted: false, outFor: 0 })
  })

  it('unmounts at once on leaving Earth focus, and a return above the range does not remount', () => {
    const g = gate()
    expect(stepTileGate(g, true, true, 150, top, dt)).toBe(true)
    expect(stepTileGate(g, true, true, 260, top, dt)).toBe(true)
    expect(stepTileGate(g, true, false, 260, top, dt)).toBe(false)
    expect(g.mount).toEqual({ mounted: false, outFor: 0 })
    for (let i = 0; i < 20; i++) expect(stepTileGate(g, true, true, 260, top, dt)).toBe(false)
    // Back in range, they mount again.
    expect(stepTileGate(g, true, true, 150, top, dt)).toBe(true)
  })

  it('leaves the range only above 220 km while mounted, and drops it out of close zoom', () => {
    const g = gate()
    stepTileGate(g, true, true, 150, top, dt)
    stepTileGate(g, true, true, 210, top, dt)
    expect(g.range).toBe(true)
    stepTileGate(g, false, true, 150, top, dt)
    expect(g.range).toBe(false)
    expect(g.mount.mounted).toBe(false)
  })
})
