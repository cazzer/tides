// The streamed true-scale surface (tides-zmw.9.1), chosen at load: ?surface=1
// in the URL mounts Mapterhorn terrain with satellite imagery under Earth's
// spin group in ship mode; anything else (absent, 0, true, junk) leaves the
// scene as it was. TEMPORARY: the tiles are drawn at true scale (1x relief)
// while the globe is drawn at RELIEF (12x by default, ./relief.ts), so with
// the flag the tiles sit up to tens of km under the globe's ground and only
// show where the globe is hidden or clipped by the near plane, and the two
// z-fight at sea level, where both are at the ellipsoid. That makes the flag
// a developer preview of the streaming itself; the altitude blend
// (tides-zmw.9.7) hands the ground over from the globe and removes the flag.
//
// High tier only: the tiles stream tens of MB of textures and meshes a phone
// budget can't spare. iPads report the high tier; there, without linear
// filtering of float textures (OES_texture_float_linear), the elevation maps
// are nearest-filtered (tides-zmw.9.2).
import { isLowQuality } from './quality'

export function parseSurface(search: string): boolean {
  return new URLSearchParams(search).get('surface') === '1'
}

/** Whether the tiles mount on this tier: asked for, and not on low quality. */
export function surfaceTilesOn(surface: boolean, lowQuality: boolean): boolean {
  return surface && !lowQuality
}

/** This page's flag; off outside a browser. */
export const SURFACE = typeof location === 'undefined' ? false : parseSurface(location.search)

/** Read once at load, like the flag: a reload changes either. */
export const SURFACE_TILES_ON = surfaceTilesOn(SURFACE, isLowQuality())
