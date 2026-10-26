// Earth's live terrain scale (tides-zmw.9.5): how many times true scale the
// ground is drawn at this frame, eased with the eye's altitude from the
// page's relief (./relief.ts, 12x by default) at the top of the blend down to
// true scale (1x) at the sea. Reload-time ?blend=1 turns it on, and so do the
// streamed surface tiles (?surface=1, ../surface.ts; tides-zmw.9.7), which
// take the same scale; without either the scale is the relief at every
// altitude and every reader below gets TERRAIN_DISPLACEMENT to the bit, so
// production draws as it did. The cloud GLSL follows it too
// (renderers/cloudTerrainScale.ts, tides-zmw.9.6: the columns, their shadows
// and the march's ground stand on the drawn ground); tides-zmw.9.10 turns it
// on by default and drops ?blend. That turns the clouds' live programs on in
// the system views as well, so it passes createCloudLayer live = shipMode or
// re-pins nightLights.test's system-view hash.
//
// One writer, one value a frame: ShipController calls setTerrainEye() with
// the ship's altitude before it steps the flight model, so the floor the
// step clamps to (ship-bodies.ts earthStop ground(), via
// liveTerrainDisplacement()) and the ground the frame then draws
// (EarthRenderer's onBeforeRender, via applyTerrainScale()) use the same
// scale, and the ship stands at least its clearance over the drawn ground in
// every frame, not a frame late. Not from the ground's onBeforeRender: it
// doesn't run while Earth is frustum-culled, which would leave the floor
// on a stale scale. The ground mesh's displacementScale is three's own
// uniform, which the vertex displacement and slope
// (renderers/groundDisplacement.ts), the relief's shading
// (renderers/groundRelief.ts) and the horizon shadows
// (renderers/groundShadow.ts, the same uniform object, its tangents scaled
// linearly, so right down to 1x) all read, so they follow it for free. The
// cloud shell and the ground's cloud shadows read terrainScaleUniform itself
// (uTerrainScale), so they take the same value in the same frame.
//
// What stays at the full relief, a maximum bound for any scale this gives:
// TERRAIN_DISPLACEMENT itself, CLOUD_LAYER_TOP and CLOUD_FLAT_ALTITUDE, the
// shells and the haze's top, the cloud GLSL's TERRAIN_TOP and march steps,
// the cloud tops (CLOUD_UNITS_PER_KM), and the low tier's
// EARTH_COLLISION_RADIUS (which is above the blend's top, so that tier
// always sees the full relief).
//
// The altitude is the eye's over the sea-level sphere, not over the ground:
// over the ground it would depend on the scale it sets. The scale is linear
// in it (smoothstep), not logarithmic: a log blend raises exaggerated peaks
// faster than the eye descends, above it near the ground. The ship's stop is
// the fixed point a = s(a) h + c (h the true ground, c the clearance), unique
// and reached smoothly when s'(a) h < 1 for all ground, which sets the
// blend's lowest top (terrainBlendTop()). The tiles draw true peaks
// (Everest's 8849 m), not the globe's smoothed 5385 m, so with the tiles on
// the top is sized for SURFACE_MAX_METRES (tides-zmw.9.7): ~183 km at 12x;
// the globe alone (?blend=1) keeps ~110 km.
//
// The handover (tides-zmw.9.7): the tiles dissolve in over the top's last
// 40% (surfaceOpacity(), surfaceOpacityUniform, written with the scale), on
// a screen-door the globe fills, so between the two only the DEM and the
// imagery differ, spread over ~70 km of descent; both stand on the one scale.
import type * as THREE from 'three'
import { EARTH_RADIUS_KM, TERRAIN_DISPLACEMENT, TERRAIN_MAX_GREY, TRUE_TERRAIN_DISPLACEMENT } from './cloud-layer'
import { sceneRadius } from './planets'
import { RELIEF } from './relief'
import { SURFACE_TILES_ON } from './surface'

export { TRUE_TERRAIN_DISPLACEMENT }

/** Whether ?blend=1 is in the URL: the live scale on (see the header). */
export function parseTerrainBlend(search: string): boolean {
  return new URLSearchParams(search).get('blend') === '1'
}

/** Whether the live scale is on: ?blend=1, or the surface tiles, which
 * stand on it (tides-zmw.9.7); off outside a browser. */
export function terrainBlendOn(blend: boolean, surfaceTiles: boolean): boolean {
  return blend || surfaceTiles
}

/** This page's live scale: ?blend=1 or the tiles; off outside a browser. */
export const TERRAIN_BLEND = terrainBlendOn(
  typeof location === 'undefined' ? false : parseTerrainBlend(location.search),
  SURFACE_TILES_ON
)

/** True kilometres per scene unit at Earth (sceneRadius(diameter) is the
 * drawn sphere's radius; ~2159). Not ship-bodies.ts' EARTH_RADIUS: that
 * module reads this one. */
export const EARTH_KM_PER_UNIT = EARTH_RADIUS_KM / sceneRadius(12742000)

/** The lowest top of the blend: the ~100 km true where the scene hands
 * over to true scale (tides-zmw.9). */
export const TERRAIN_BLEND_MIN_TOP_KM = 100

/** terrain-floor.ts TERRAIN_GREY_MARGIN, the most the floor stands over the
 * drawn ground's highest, in grey levels; mirrored, not imported, to keep
 * this module off the floor's map and the limb sphere (a test pins them). */
export const FLOOR_MARGIN_GREY = 0.5

/** The highest the ship's floor stands at true scale, scene units: the
 * highest drawn ground (TERRAIN_MAX_GREY) plus the floor's margin. */
export const TRUE_FLOOR_MAX = TRUE_TERRAIN_DISPLACEMENT * (TERRAIN_MAX_GREY + FLOOR_MARGIN_GREY / 255)

/** The highest ground the streamed tiles draw, metres (Everest, 8849 m,
 * with room): the globe's own highest (TRUE_FLOOR_MAX) is smoothed to
 * 5385 m, but the tiles stand true peaks on the same scale (tides-zmw.9.7). */
export const SURFACE_MAX_METRES = 8900

/** SURFACE_MAX_METRES in scene units at true scale. */
export const SURFACE_MAX = SURFACE_MAX_METRES / (EARTH_KM_PER_UNIT * 1000)

/** The most the stop's fixed point may move per unit of altitude it moves
 * (s'(a) × the highest ground at the blend's steepest): under 1, so the stop
 * is unique and continuous, with room to spare. */
export const TERRAIN_BLEND_MAX_GAIN = 0.8

/**
 * The blend's shape from the sea to its top: 'smooth' (smoothstep: C1 at
 * both ends, steepest 1.5x its mean slope, so the top sits 1.5x higher) or
 * 'linear' (C0 at the top, a kink in the slope there, but a top two thirds
 * as high: ~122 km at 12x against ~183). Q1 of tides-zmw.9.7; smooth until
 * the user picks.
 */
export type TerrainBlendRamp = 'smooth' | 'linear'
export const TERRAIN_BLEND_RAMP: TerrainBlendRamp = 'smooth'

/** The ramp's steepest slope over its mean. */
const rampPeak = (ramp: TerrainBlendRamp) => (ramp === 'linear' ? 1 : 1.5)

/** The highest ground drawn on the live scale, scene units at true scale:
 * the tiles' true peaks when they're on, else the globe's floor. */
export function terrainBlendPeak(surfaceTiles: boolean): number {
  return surfaceTiles ? Math.max(TRUE_FLOOR_MAX, SURFACE_MAX) : TRUE_FLOOR_MAX
}

/** This page's: SURFACE_MAX with the tiles, TRUE_FLOOR_MAX without. */
export const TERRAIN_BLEND_PEAK = terrainBlendPeak(SURFACE_TILES_ON)

/**
 * The altitude over the sea (scene units) at and above which the ground is
 * drawn at the full `relief`: TERRAIN_BLEND_MIN_TOP_KM, or higher where the
 * blend would be too steep for the stop over the highest ground drawn
 * (`peak`): (relief - 1) × the ramp's peak / top × `peak` at most
 * TERRAIN_BLEND_MAX_GAIN. Smooth over the globe: ~0.0511 (110 km) at 12x;
 * over the tiles' true peaks: ~0.0850 (~183 km) at 12x, ~0.186 at 25x.
 */
export function terrainBlendTop(
  relief: number = RELIEF,
  ramp: TerrainBlendRamp = TERRAIN_BLEND_RAMP,
  peak: number = TERRAIN_BLEND_PEAK
): number {
  return Math.max(
    TERRAIN_BLEND_MIN_TOP_KM / EARTH_KM_PER_UNIT,
    ((relief - 1) * rampPeak(ramp) * peak) / TERRAIN_BLEND_MAX_GAIN
  )
}

/**
 * The terrain scale (multiple of true scale) for an eye `altitude` scene
 * units over the sea-level sphere: 1 at the sea, easing up to `relief` at
 * terrainBlendTop() and holding it above. `relief` everywhere when the blend
 * is off. Infinity (no Earth) gives `relief`.
 */
export function terrainScale(
  altitude: number,
  relief: number = RELIEF,
  blend: boolean = TERRAIN_BLEND,
  ramp: TerrainBlendRamp = TERRAIN_BLEND_RAMP,
  peak: number = TERRAIN_BLEND_PEAK
): number {
  if (!blend) return relief
  const top = terrainBlendTop(relief, ramp, peak)
  // Exactly the relief at and above the top, which 1 + (relief - 1) needn't
  // round to.
  if (!(altitude < top)) return relief
  const t = Math.max(0, altitude / top)
  return 1 + (relief - 1) * (ramp === 'linear' ? t : t * t * (3 - 2 * t))
}

/** Where in the blend's top the tiles start to dissolve out, going up. */
export const SURFACE_FADE_START = 0.6

/**
 * How much of the ground the streamed tiles draw for an eye `altitude` over
 * the sea (tides-zmw.9.7): all of it up to SURFACE_FADE_START of the blend's
 * top, none from the top up (smoothstep between), the rest left to the
 * globe on a screen-door (surface-scale.ts). 0 for Infinity (no ship).
 */
export function surfaceOpacity(
  altitude: number,
  relief: number = RELIEF,
  ramp: TerrainBlendRamp = TERRAIN_BLEND_RAMP,
  peak: number = TERRAIN_BLEND_PEAK
): number {
  const top = terrainBlendTop(relief, ramp, peak)
  const start = SURFACE_FADE_START * top
  if (!(altitude < top)) return 0
  if (altitude <= start) return 1
  const t = (altitude - start) / (top - start)
  return 1 - t * t * (3 - 2 * t)
}

/**
 * The live scale: one uniform object every reader shares (the ground's
 * displacement through applyTerrainScale(), the CPU floor through
 * liveTerrainDisplacement(), the cloud shell and the ground's cloud shadows
 * as uTerrainScale, tides-zmw.9.6, and the streamed tiles' height and bump,
 * tides-zmw.9.7). The page's relief until a ship sets it, and again once it
 * leaves.
 */
export const terrainScaleUniform: THREE.IUniform<number> = { value: RELIEF }

/**
 * terrainScaleUniform's GLSL declaration (uTerrainScale), guarded, so that
 * patches composed onto one program (the cloud shadow and the streamed
 * tiles' height, tides-zmw.9.12) can each declare it without redefining it.
 */
export const TERRAIN_SCALE_UNIFORM_GLSL =
  '#ifndef TERRAIN_SCALE_DECLARED\n#define TERRAIN_SCALE_DECLARED\nuniform float uTerrainScale;\n#endif\n'

/**
 * The tiles' share of the ground this frame (surfaceOpacity()), written with
 * the scale: one uniform object every tile material reads (surface-scale.ts).
 * 0 until a ship sets it, and again once it leaves.
 */
export const surfaceOpacityUniform: THREE.IUniform<number> = { value: 0 }

/**
 * Sets the live scale for an eye `altitude` over the sea-level sphere
 * (Infinity: away from Earth, or no ship). ShipController's frame, once,
 * after the spawn and before the step (see the header); its unmount passes
 * Infinity, so the system views draw the full relief.
 */
export function setTerrainEye(altitude: number, blend: boolean = TERRAIN_BLEND): void {
  terrainScaleUniform.value = terrainScale(altitude, RELIEF, blend)
  surfaceOpacityUniform.value = surfaceOpacity(altitude)
}

/**
 * The ground's displacementScale at `scale`: scene units at grey 1. Taken as
 * a share of TERRAIN_DISPLACEMENT (so exactly it at the page's relief, which
 * TRUE_TERRAIN_DISPLACEMENT × RELIEF needn't round to), and within an ulp of
 * TRUE_TERRAIN_DISPLACEMENT × scale otherwise.
 */
export function terrainDisplacement(scale: number): number {
  return TERRAIN_DISPLACEMENT * (scale / RELIEF)
}

/** The displacementScale the ground is drawn at this frame. */
export function liveTerrainDisplacement(): number {
  return terrainDisplacement(terrainScaleUniform.value)
}

/**
 * Puts the live displacement on the ground's material, for its
 * onBeforeRender: three copies material.displacementScale into the program's
 * uniform at each draw (after onBeforeRender), so the vertex displacement,
 * the relief and the horizon shadows all take it this frame.
 */
export function applyTerrainScale(material: { displacementScale: number }): void {
  material.displacementScale = liveTerrainDisplacement()
}
