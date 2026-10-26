// The streamed tiles' handover from the globe (tides-zmw.9.7), and the true
// units the tiles and the ship's floor share.
//
// Earth is drawn at one relief, the page's (./relief.ts: true scale, 1x, by
// default; ?relief= sets it at load), at every altitude: the globe's
// displacement, the cloud GLSL, the streamed tiles (renderers/surface/
// surface-scale.ts) and the ship's floor (ship/ship-bodies.ts) all stand on
// TERRAIN_DISPLACEMENT or RELIEF, constants. tides-zmw.9.5 eased the relief
// with the eye's altitude down to true scale near the ground (a live terrain
// scale behind ?blend=1 and ?surface=1); tides-zmw.21 drew Earth at true
// scale throughout and removed it, so ?relief= is now a static setting.
//
// The handover: the tiles draw all the ground up to SURFACE_FADE_START of
// SURFACE_TOP_KM over the sea and none from it up, dissolving between
// (surfaceOpacity(), surfaceOpacityUniform) on a screen-door the globe fills
// (surface-scale.ts), so between the two only the DEM and the imagery
// differ, spread over 40 km of descent. One writer, one value a frame:
// ShipController calls setSurfaceEye() with the ship's altitude before it
// steps the flight model, so the floor the step clamps to (ship-bodies.ts,
// which takes the tiles only where they draw) and the frame drawn agree.
import type * as THREE from 'three'
import { EARTH_RADIUS_KM } from './cloud-layer'
import { sceneRadius } from './planets'

/** True kilometres per scene unit at Earth (sceneRadius(diameter) is the
 * drawn sphere's radius; ~2159). Not ship-bodies.ts' EARTH_RADIUS: that
 * module reads this one. */
export const EARTH_KM_PER_UNIT = EARTH_RADIUS_KM / sceneRadius(12742000)

/** The highest ground the streamed tiles draw, metres (Everest, 8849 m,
 * with room): the globe's own highest is smoothed to 5385 m, but the tiles
 * stand true peaks (tides-zmw.9.7). */
export const SURFACE_MAX_METRES = 8900

/** The altitude over the sea (true km) at and above which the tiles draw
 * nothing: ~100 km, where the scene hands over to the streamed ground
 * (tides-zmw.9). */
export const SURFACE_TOP_KM = 100

/** SURFACE_TOP_KM in scene units. */
export const SURFACE_TOP = SURFACE_TOP_KM / EARTH_KM_PER_UNIT

/** Where in SURFACE_TOP the tiles start to dissolve out, going up (60 km). */
export const SURFACE_FADE_START = 0.6

/**
 * How much of the ground the streamed tiles draw for an eye `altitude`
 * (scene units) over the sea: all of it up to SURFACE_FADE_START of
 * SURFACE_TOP, none from the top up (smoothstep between), the rest left to
 * the globe on a screen-door (surface-scale.ts). 0 for Infinity (no ship).
 */
export function surfaceOpacity(altitude: number): number {
  const top = SURFACE_TOP
  const start = SURFACE_FADE_START * top
  if (!(altitude < top)) return 0
  if (altitude <= start) return 1
  const t = (altitude - start) / (top - start)
  return 1 - t * t * (3 - 2 * t)
}

/**
 * The tiles' share of the ground this frame (surfaceOpacity()): one uniform
 * object every tile material reads (surface-scale.ts). 0 until a ship sets
 * it, and again once it leaves.
 */
export const surfaceOpacityUniform: THREE.IUniform<number> = { value: 0 }

/**
 * Sets the tiles' share for an eye `altitude` over the sea-level sphere
 * (Infinity: away from Earth, or no ship). ShipController's frame, once,
 * after the spawn and before the step (see the header); its unmount passes
 * Infinity, so the system views draw the globe alone.
 */
export function setSurfaceEye(altitude: number): void {
  surfaceOpacityUniform.value = surfaceOpacity(altitude)
}
