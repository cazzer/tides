// The streamed true-scale surface (tides-zmw.9.1), chosen at load: on by
// default (tides-6e8), it mounts Mapterhorn terrain with satellite imagery
// under Earth's spin group in ship mode; ?surface=0 in the URL leaves the
// globe as it was, and any other value (absent, 1, junk) keeps the tiles. The tiles stand at the globe's relief (./relief.ts), and
// take the ground over from the globe below the handover's top
// (./surface-handover.ts) by stencil, the globe filling wherever no tile has
// loaded (tides-zmw.9.7, renderers/surface/surface-scale.ts). The tiles
// carry the globe's cloud shadows, night lights, sun glint and terrain
// shadows (tides-zmw.9.12-9.16); tides-zmw.9.10 is the end-to-end flight
// check and frame budget.
//
// The flag is an experiment toggle kept for convenience, not a mode of its
// own: the ship flies the same speed law over the globe and the tiles
// (tides-zmw.9.29, ship/ship-bodies.ts EARTH_GROUND_SPEED_LAW), and nothing
// new should branch on it beyond what the tiles themselves need.
//
// High tier only: the tiles stream tens of MB of textures and meshes a phone
// budget can't spare. iPads report the high tier; there, without linear
// filtering of float textures (OES_texture_float_linear), the elevation maps
// are nearest-filtered (tides-zmw.9.2).
import { isLowQuality } from './quality'

export function parseSurface(search: string): boolean {
  return new URLSearchParams(search).get('surface') !== '0'
}

/** Whether the tiles mount on this tier: not turned off, and not on low quality. */
export function surfaceTilesOn(surface: boolean, lowQuality: boolean): boolean {
  return surface && !lowQuality
}

/** This page's flag; off outside a browser (workers and tests). */
export const SURFACE = typeof location === 'undefined' ? false : parseSurface(location.search)

/** Read once at load, like the flag: a reload changes either. */
export const SURFACE_TILES_ON = surfaceTilesOn(SURFACE, isLowQuality())
