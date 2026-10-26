// Where the ship's floor reads the streamed surface tiles from
// (tides-zmw.9.8): SurfaceTiles registers its sampler here while it is
// mounted (renderers/surface/surface-ground.ts, in the tiles' lazy chunk) and
// Earth's ground in ship-bodies.ts reads it. A registry with no imports, so
// the ship's modules never import the tiles' (which import ship-bodies for
// Earth's radius) and the tiles' library stays out of the main chunk.

/** The highest drawn tile ground in a window, true metres over the sea. */
export interface SurfaceGroundQuery {
  /** The highest the drawn (or about to be drawn) tile mesh stands. */
  metres: number
  /** Whether loaded tiles cover the whole window; where they don't, the globe draws. */
  covered: boolean
}

export interface SurfaceGroundSampler {
  /**
   * The highest the tile ground stands within `radiusM` metres of (`lat`,
   * `lon`) radians, never under the mesh drawn there; null when no loaded
   * tile reaches the window.
   */
  maxElevation(lat: number, lon: number, radiusM: number): SurfaceGroundQuery | null
}

/**
 * The latitude and longitude, radians, of a unit direction in Earth's local
 * frame (Y north, lon 0 at +X, east toward -Z: renderers/surface/
 * surface-frame.ts), into `out`.
 */
export function earthLatLon(local: { x: number; y: number; z: number }, out: [number, number] = [0, 0]): [number, number] {
  out[0] = Math.asin(Math.min(1, Math.max(-1, local.y)))
  out[1] = Math.atan2(-local.z, local.x)
  return out
}

let current: SurfaceGroundSampler | null = null

/** SurfaceTiles' mount (a sampler) and unmount (null). */
export function setSurfaceGroundSampler(sampler: SurfaceGroundSampler | null): void {
  current = sampler
}

/** The mounted tiles' sampler, or null without tiles. */
export function surfaceGroundSampler(): SurfaceGroundSampler | null {
  return current
}
