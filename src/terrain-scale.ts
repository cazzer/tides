// Earth's live terrain scale (tides-zmw.9.5): how many times true scale the
// ground is drawn at this frame, eased with the eye's altitude from the
// page's relief (./relief.ts, 12x by default) at the top of the blend down to
// true scale (1x) at the sea. Reload-time ?blend=1 turns it on; without it
// the scale is the relief at every altitude and every reader below gets
// TERRAIN_DISPLACEMENT to the bit, so production draws as it did. It stays
// behind the flag until the cloud march follows it (tides-zmw.9.6: until
// then its GLSL stands the columns on full-relief ground, so the shadows
// drift and over mountains the march's ground can stand above the eye); the
// last of tides-zmw.9.7 / 9.10 to land turns it on and drops ?blend.
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
// linearly, so right down to 1x) all read, so they follow it for free.
//
// What stays at the full relief, a maximum bound for any scale this gives:
// TERRAIN_DISPLACEMENT itself, CLOUD_LAYER_TOP and CLOUD_FLAT_ALTITUDE, the
// shells and the haze's top, the cloud GLSL's TERRAIN_TOP, and the low
// tier's EARTH_COLLISION_RADIUS (which is above the blend's top, so that
// tier always sees the full relief).
//
// The altitude is the eye's over the sea-level sphere, not over the ground:
// over the ground it would depend on the scale it sets. The scale is linear
// in it (smoothstep), not logarithmic: a log blend raises exaggerated peaks
// faster than the eye descends, above it near the ground. The ship's stop is
// the fixed point a = s(a) h + c (h the true ground, c the clearance), unique
// and reached smoothly when s'(a) h < 1 for all ground, which sets the
// blend's lowest top (terrainBlendTop()).
import type * as THREE from 'three'
import { EARTH_RADIUS_KM, TERRAIN_DISPLACEMENT, TERRAIN_MAX_GREY, TRUE_TERRAIN_DISPLACEMENT } from './cloud-layer'
import { sceneRadius } from './planets'
import { RELIEF } from './relief'

export { TRUE_TERRAIN_DISPLACEMENT }

/** Whether ?blend=1 is in the URL: the live scale on (see the header). */
export function parseTerrainBlend(search: string): boolean {
  return new URLSearchParams(search).get('blend') === '1'
}

/** This page's ?blend=1; off outside a browser. */
export const TERRAIN_BLEND = typeof location === 'undefined' ? false : parseTerrainBlend(location.search)

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

/** The most the stop's fixed point may move per unit of altitude it moves
 * (s'(a) × TRUE_FLOOR_MAX at the blend's steepest): under 1, so the stop is
 * unique and continuous, with room to spare. */
export const TERRAIN_BLEND_MAX_GAIN = 0.8

/**
 * The altitude over the sea (scene units) at and above which the ground is
 * drawn at the full `relief`: TERRAIN_BLEND_MIN_TOP_KM, or higher where the
 * blend would be too steep for the stop (smoothstep's steepest slope is 1.5
 * over its span: (relief - 1) × 1.5 / top × TRUE_FLOOR_MAX at most
 * TERRAIN_BLEND_MAX_GAIN). ~0.0512 (110 km) at 12x, ~0.111 at 25x.
 */
export function terrainBlendTop(relief: number = RELIEF): number {
  return Math.max(
    TERRAIN_BLEND_MIN_TOP_KM / EARTH_KM_PER_UNIT,
    ((relief - 1) * 1.5 * TRUE_FLOOR_MAX) / TERRAIN_BLEND_MAX_GAIN
  )
}

/**
 * The terrain scale (multiple of true scale) for an eye `altitude` scene
 * units over the sea-level sphere: 1 at the sea, easing up to `relief` at
 * terrainBlendTop() and holding it above. `relief` everywhere when the blend
 * is off. Infinity (no Earth) gives `relief`.
 */
export function terrainScale(altitude: number, relief: number = RELIEF, blend: boolean = TERRAIN_BLEND): number {
  if (!blend) return relief
  const top = terrainBlendTop(relief)
  // Exactly the relief at and above the top, which 1 + (relief - 1) needn't
  // round to.
  if (!(altitude < top)) return relief
  const t = Math.max(0, altitude / top)
  return 1 + (relief - 1) * t * t * (3 - 2 * t)
}

/**
 * The live scale: one uniform object every reader shares (the ground's
 * displacement through applyTerrainScale(), the CPU floor through
 * liveTerrainDisplacement(); next the cloud march, tides-zmw.9.6, and the
 * streamed tiles' height, tides-zmw.9.7). The page's relief until a ship
 * sets it, and again once it leaves.
 */
export const terrainScaleUniform: THREE.IUniform<number> = { value: RELIEF }

/**
 * Sets the live scale for an eye `altitude` over the sea-level sphere
 * (Infinity: away from Earth, or no ship). ShipController's frame, once,
 * after the spawn and before the step (see the header); its unmount passes
 * Infinity, so the system views draw the full relief.
 */
export function setTerrainEye(altitude: number, blend: boolean = TERRAIN_BLEND): void {
  terrainScaleUniform.value = terrainScale(altitude, RELIEF, blend)
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
