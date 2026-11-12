// Close zoom's rules the store needs (tides-tvr.7.1), kept free of imports
// so store.ts and close-zoom.ts don't import each other.

/**
 * The requested time scale held at real time in close zoom: faster either
 * way becomes real time that way, with a cue to say so. Paused stays paused.
 */
export function holdRealTime(
  requested: number,
  closeZoom: boolean
): { timeScale: number; cue: boolean } {
  return closeZoom && Math.abs(requested) > 1
    ? { timeScale: Math.sign(requested), cue: true }
    : { timeScale: requested, cue: false }
}

/** The tiles' range in close zoom, in handover tops (SURFACE_TOP): entered below this… */
export const TILE_RANGE_ENTER = 2
/** …and left above this, so an eye resting on the edge doesn't mount and release them. */
export const TILE_RANGE_LEAVE = 2.2

/**
 * Whether an eye `altitude` over the sea is low enough for the streamed
 * surface tiles (tides-tvr.7.2), `top` the handover's top (SURFACE_TOP, in
 * the same units): far above it they would only stream tiles nobody sees.
 */
export function isTileRange(altitude: number, top: number, wasInRange: boolean): boolean {
  return altitude < (wasInRange ? TILE_RANGE_LEAVE : TILE_RANGE_ENTER) * top
}

/**
 * Whether an eye `altitude` is above the tiles' range however it got there
 * (at or past the leave mark, TILE_RANGE_LEAVE tops): where tiles still
 * mounted sit out their leave grace (stepTileMount), drawing nothing.
 */
export function aboveTileRange(altitude: number, top: number): boolean {
  return altitude >= TILE_RANGE_LEAVE * top
}

/**
 * How long close zoom keeps the tiles mounted after the eye leaves their
 * range (tides-8h7), in seconds: a tilt swings the eye's height across the
 * range's edge and back, and each remount rebuilt them whole. Out of range
 * they sit above the handover's top, so they draw nothing meanwhile.
 */
export const TILE_LEAVE_GRACE_S = 10

/** Close zoom's tile mount (stepTileMount): mounted, and for how long the eye has been out of range. */
export interface TileMount {
  mounted: boolean
  outFor: number
}

/**
 * Steps `m` by `dt` seconds and returns whether the tiles stay mounted: out
 * of close zoom never; in range (`inRange`, isTileRange) at once; out of
 * range only once mounted, until the eye has stayed out for `grace` seconds.
 * Mutates `m`, so a frame allocates nothing.
 */
export function stepTileMount(
  m: TileMount,
  close: boolean,
  inRange: boolean,
  dt: number,
  grace = TILE_LEAVE_GRACE_S
): boolean {
  if (!close) {
    m.mounted = false
    m.outFor = 0
  } else if (inRange) {
    m.mounted = true
    m.outFor = 0
  } else if (!m.mounted) {
    m.outFor = 0
  } else {
    m.outFor += dt
    if (m.outFor >= grace) {
      m.mounted = false
      m.outFor = 0
    }
  }
  return m.mounted
}

/** Close zoom's tiles each frame (stepTileGate): in their range (isTileRange's hysteresis), and mounted. */
export interface TileGate {
  range: boolean
  mount: TileMount
}

/**
 * Steps `g` by `dt` seconds for an eye `altitude` over the sea (`top` the
 * handover's top, in the same units) and returns whether the tiles stay
 * mounted. The range keys its hysteresis on itself, never on the mount, so
 * the grace can't widen it. The mount needs close zoom in Earth focus: the
 * system view only mounts them there (systemSurfaceTilesOn), so leaving focus
 * drops the grace rather than letting a return above the range remount them.
 */
export function stepTileGate(
  g: TileGate,
  close: boolean,
  earthFocus: boolean,
  altitude: number,
  top: number,
  dt: number
): boolean {
  g.range = close && isTileRange(altitude, top, g.range)
  return stepTileMount(g.mount, close && earthFocus, g.range, dt)
}

/**
 * Whether the system view mounts the streamed surface tiles (tides-tvr.7.2):
 * with them on (high tier, not ?surface=0), in the main view while it holds
 * the main grid slot (`mainSlot`: swapped to a side slot, the panel keeps
 * its close zoom but not the credits line, which only the main slot shows),
 * in close zoom with the tiles mounted (`closeZoomTiles`: within their
 * range, isTileRange, or out of it for under TILE_LEAVE_GRACE_S,
 * stepTileMount) and in Earth focus. Leaving any of these releases them,
 * every download with them.
 */
export function systemSurfaceTilesOn({
  tilesOn,
  interactive,
  mainSlot,
  closeZoomTiles,
  cameraFocus,
}: {
  tilesOn: boolean
  interactive: boolean
  mainSlot: boolean
  closeZoomTiles: boolean
  cameraFocus: string | null | undefined
}): boolean {
  return tilesOn && interactive && mainSlot && closeZoomTiles && cameraFocus === 'earth'
}
