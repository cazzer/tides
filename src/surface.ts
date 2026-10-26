// The streamed true-scale surface (tides-zmw.9.1), chosen at load: ?surface=1
// in the URL mounts Mapterhorn terrain with satellite imagery under Earth's
// spin group in ship mode; anything else (absent, 0, true, junk) leaves the
// scene as it was. The tiles stand on the globe's live terrain scale, which
// the flag turns on (terrain-scale.ts TERRAIN_BLEND), and take the ground
// over from the globe below the blend's top by stencil, the globe filling
// wherever no tile has loaded (tides-zmw.9.7, renderers/surface/
// surface-scale.ts). Still a preview: the tiles lack the globe's cloud
// shadows, night lights, sun glint and terrain shadows (beads under
// tides-zmw.9), which must land before the flag becomes the default
// (tides-zmw.9.10).
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
