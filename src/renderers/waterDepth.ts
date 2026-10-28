// The sea's depth under the water's body (tides-d9f.6): the day map's ocean
// is one mid blue from the Bahamas' banks to the Mariana Trench (linear luma
// 0.05-0.08 over shelf and abyss alike), so from orbit and from low down the
// sea read flat. The body (./water.ts waterBody) now tints it by the depth
// under it: lighter and greener over the shallow banks and reefs, the
// shelf's blue a little lighter than the map's, deep water darker and the
// trenches darker again, as the sea looks in photographs.
//
// The depth map, src/assets/earth-bathy-4k.png (high tier) and
// earth-bathy-2k.png (low tier, the 4k map's 2 x 2 means), is built by
// scripts/build-earth-bathy.mjs from NOAA NCEI's ETOPO 2022 (60 arc-second
// surface elevation; US Government work, public domain): one 8-bit grey
// level a texel on exactly the elevation map's grid (src/earth-dem.ts: rows
// north to south, columns from longitude -180 east), the mean depth of the
// ETOPO cells whose centres fall in it, sqrt-encoded (encodeWaterDepth) so
// the shelf's first hundred metres get as many levels as the abyss's
// thousands. Land (above sea level in the elevation map) and the lakes over
// it take their wet neighbours' depth within three texels of the coast and
// WATER_DEPTH_NEUTRAL beyond: a lake further inland takes deep water's tint.
// The Caspian is wet, with its own depths below its own surface.
//
// The model: waterTint(depth), a gain on the map's colour by channel, three
// smoothsteps between four gains: from WATER_TINT_SHALLOW over sand a few
// metres down to WATER_TINT_SHELF by WATER_DEPTH_SHOAL, held over the shelf
// to its edge (WATER_DEPTH_SHELF), down the continental slope to
// WATER_TINT_DEEP (WATER_DEPTH_SLOPE), and to WATER_TINT_TRENCH from the
// abyssal plain (WATER_DEPTH_ABYSS) to the trenches (WATER_DEPTH_TRENCH).
// Each gain darker than the last, so a deeper sea is never lighter. A gain,
// not a colour, so the map's own variation (silt plumes, its lighter
// lagoons) shows through; and where the map is already well lighter than
// the open sea (WATER_KEEP: the Bahamas' banks, river mouths) the tint fades
// out and the map's own shelf colour stays. No imports: ./water.ts and the
// build script both read it.

/** The deepest depth the map encodes (m): Challenger Deep is ~10,920. */
export const WATER_DEPTH_MAX = 11000
/** The depth land and lakes take far from the sea (m): deep water's. */
export const WATER_DEPTH_NEUTRAL = 3000
/** The ramp's stops (m): the banks' foot, the shelf's edge, the foot of the
 * slope, the abyssal plain and the trenches. */
export const WATER_DEPTH_SHOAL = 50
export const WATER_DEPTH_SHELF = 200
export const WATER_DEPTH_SLOPE = 2000
export const WATER_DEPTH_ABYSS = 5500
export const WATER_DEPTH_TRENCH = 9000

type Rgb = readonly [number, number, number]
/** The tint's gains on the map's colour (linear, by channel): over sand a
 * few metres down, the shelf, deep water, and the trenches. Playtested at 70%
 * of [1.5, 1.9, 1.25], [1, 1.2, 1], [0.6, 0.6, 0.78], [0.4, 0.4, 0.6]'s
 * distance from 1. */
export const WATER_TINT_SHALLOW: Rgb = [1.35, 1.63, 1.175]
export const WATER_TINT_SHELF: Rgb = [1.0, 1.14, 1.0]
export const WATER_TINT_DEEP: Rgb = [0.72, 0.72, 0.846]
export const WATER_TINT_TRENCH: Rgb = [0.58, 0.58, 0.72]
/** The map's luma over which the tint fades out (from the first to the
 * second): the open sea's is 0.05-0.08, the Bahamas' banks 0.13. */
export const WATER_KEEP: readonly [number, number] = [0.1, 0.16]

/** A depth (m, positive down) as the map's grey level. */
export function encodeWaterDepth(metres: number): number {
  return Math.round(255 * Math.sqrt(Math.min(Math.max(metres, 0), WATER_DEPTH_MAX) / WATER_DEPTH_MAX))
}

/** A grey level's depth (m), as the GLSL decodes it. */
export function decodeWaterDepth(level: number): number {
  return WATER_DEPTH_MAX * (level / 255) ** 2
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}
// GLSL's mix: exactly `b` at t = 1.
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => a[i] * (1 - t) + b[i] * t) as unknown as Rgb
/** Rec. 709 luma weights, as ./water.ts LUMA. */
const WATER_LUMA: Rgb = [0.2126, 0.7152, 0.0722]
const luma = (c: Rgb) => WATER_LUMA[0] * c[0] + WATER_LUMA[1] * c[1] + WATER_LUMA[2] * c[2]

/** The gain at `depth` m, as the GLSL's waterTint(). */
export function waterTint(depth: number): [number, number, number] {
  let c = mix(WATER_TINT_SHALLOW, WATER_TINT_SHELF, smoothstep(0, WATER_DEPTH_SHOAL, depth))
  c = mix(c, WATER_TINT_DEEP, smoothstep(WATER_DEPTH_SHELF, WATER_DEPTH_SLOPE, depth))
  return [...mix(c, WATER_TINT_TRENCH, smoothstep(WATER_DEPTH_ABYSS, WATER_DEPTH_TRENCH, depth))] as [number, number, number]
}

/** The map's colour `c` (linear) tinted for `depth` m of water under it, as
 * the GLSL's waterTinted(). */
export function waterTinted(c: Rgb, depth: number): [number, number, number] {
  const gain = mix(waterTint(depth), [1, 1, 1], smoothstep(WATER_KEEP[0], WATER_KEEP[1], luma(c)))
  return [0, 1, 2].map((i) => c[i] * gain[i]) as [number, number, number]
}

const f = (x: number) => x.toFixed(6)
const v3 = (c: readonly number[]) => `vec3(${c.map(f).join(', ')})`

/** The depth's uniform, the global the samples set, and the tint (after
 * common; ./water.ts puts it in its head). */
export const WATER_DEPTH_GLSL = /* glsl */ `
uniform sampler2D uWaterDepth;
float waterDepth;
// The gain at depth d m (waterTint() mirrors it).
vec3 waterTint(float d) {
  vec3 c = mix(${v3(WATER_TINT_SHALLOW)}, ${v3(WATER_TINT_SHELF)}, smoothstep(0.0, ${f(WATER_DEPTH_SHOAL)}, d));
  c = mix(c, ${v3(WATER_TINT_DEEP)}, smoothstep(${f(WATER_DEPTH_SHELF)}, ${f(WATER_DEPTH_SLOPE)}, d));
  return mix(c, ${v3(WATER_TINT_TRENCH)}, smoothstep(${f(WATER_DEPTH_ABYSS)}, ${f(WATER_DEPTH_TRENCH)}, d));
}
// The map's colour tinted for the depth here, unless it is already well
// lighter than the open sea (waterTinted() mirrors it).
vec3 waterTinted(vec3 c) {
  float keep = smoothstep(${f(WATER_KEEP[0])}, ${f(WATER_KEEP[1])}, dot(c, ${v3(WATER_LUMA)}));
  return c * mix(waterTint(waterDepth), vec3(1.0), keep);
}
`

const decode = (tap: string) => `${f(WATER_DEPTH_MAX)} * ${tap} * ${tap}`

/** Each chain's sample, ending its water prelude: the globe's at its
 * specular map's uv (the depth is on the mask's grid; with no mask there is
 * no water, and the neutral depth), the tiles' at the base's globe uv, and
 * only on tiles with water (../surface/tile-glint.ts uTileWet; textureGrad,
 * so it can branch). */
export const WATER_DEPTH_SAMPLE = {
  globe: /* glsl */ `
#ifdef USE_SPECULARMAP
{
  float waterDepthTap = texture2D(uWaterDepth, vSpecularMapUv).r;
  waterDepth = ${decode('waterDepthTap')};
}
#else
waterDepth = ${f(WATER_DEPTH_NEUTRAL)};
#endif
`,
  tiles: /* glsl */ `
waterDepth = ${f(WATER_DEPTH_NEUTRAL)};
if (uTileWet > 0.5) {
  float waterDepthTap = surfaceGlobeTex(uWaterDepth, surfaceGlobeUv).r;
  waterDepth = ${decode('waterDepthTap')};
}
`,
} as const
