// The cloud GLSL on the live terrain scale (tides-zmw.9.6). Every ground read
// in cloudShaders.ts' FIELD (cloudTerrain(), cloudCeilingRadius(),
// cloudGround(), cloudKm()) goes through one macro, TERRAIN_DISPLACEMENT,
// which FIELD defines as the full relief's number. With the live scale on
// (../terrain-scale.ts, ?blend=1) that one line becomes the live scale times
// true scale, read from the same uniform object the ground's displacement
// takes (terrainScaleUniform), so the shell's clouds and bases and the
// ground's cloud shadows stand on the ground as it is drawn this frame, and
// the shadows stay under their clouds at every altitude of the blend.
//
// What stays at the full relief: TERRAIN_TOP (a number written into the
// source, not the macro), the shells, CLOUD_LAYER_TOP and the march's steps,
// all maximum bounds; and the cloud tops (CLOUD_UNITS_PER_KM, ~9x).
//
// With the scale off nothing changes: the programs are FIELD as written, to
// the byte, so the system view's hash pin (nightLights.test.ts) holds.
import { TERRAIN_DISPLACEMENT, TRUE_TERRAIN_DISPLACEMENT } from '../cloud-layer'

const f = (x: number) => x.toFixed(6)

/** FIELD's own line: the full relief's displacement. */
export const FIXED_TERRAIN_GLSL = `#define TERRAIN_DISPLACEMENT ${f(TERRAIN_DISPLACEMENT)}`

/** Its live stand-in: the ground's displacementScale this frame, as
 * ../terrain-scale.ts terrainDisplacement() gives it (within an ulp). */
export const LIVE_TERRAIN_GLSL = `uniform float uTerrainScale;\n#define TERRAIN_DISPLACEMENT (uTerrainScale * ${f(TRUE_TERRAIN_DISPLACEMENT)})`

/**
 * `source` (a shader holding FIELD) with its TERRAIN_DISPLACEMENT on the live
 * scale when `live`, else unchanged. Throws if FIELD's line isn't there,
 * which would otherwise leave the clouds on the full relief unnoticed.
 */
export function liveTerrain(source: string, live: boolean): string {
  const parts = source.split(FIXED_TERRAIN_GLSL)
  if (parts.length < 2) {
    throw new Error(`cloud layer: shader has no ${FIXED_TERRAIN_GLSL}`)
  }
  return live ? parts.join(LIVE_TERRAIN_GLSL) : source
}
