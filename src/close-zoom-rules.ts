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

/**
 * Whether the system view mounts the streamed surface tiles (tides-tvr.7.2):
 * with them on (high tier, not ?surface=0), in the main view, and in close
 * zoom over Earth. Leaving any of these releases them, every download with
 * them.
 */
export function systemSurfaceTilesOn({
  tilesOn,
  interactive,
  closeZoom,
  cameraFocus,
}: {
  tilesOn: boolean
  interactive: boolean
  closeZoom: boolean
  cameraFocus: string | null | undefined
}): boolean {
  return tilesOn && interactive && closeZoom && cameraFocus === 'earth'
}
