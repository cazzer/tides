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
 * Whether the system view mounts the streamed surface tiles (tides-tvr.7.2):
 * with them on (high tier, not ?surface=0), in the main view, in close zoom
 * within the tiles' range (`closeZoomTiles`, isTileRange) and in Earth
 * focus. Leaving any of these releases them, every download with them.
 */
export function systemSurfaceTilesOn({
  tilesOn,
  interactive,
  closeZoomTiles,
  cameraFocus,
}: {
  tilesOn: boolean
  interactive: boolean
  closeZoomTiles: boolean
  cameraFocus: string | null | undefined
}): boolean {
  return tilesOn && interactive && closeZoomTiles && cameraFocus === 'earth'
}
