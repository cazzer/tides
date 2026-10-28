// The sea's depth under the water's body (tides-d9f.6): the floor its colour
// is lifted to (./water.ts waterBody) goes from turquoise over the shallow
// banks, through the shelf's blue, to deep water's navy and darker again
// over the trenches, so the Bahamas, the North Sea and the Grand Banks read
// as shallow from orbit and from low down, as they do in photographs.
// Before it every sea took the one floor, WATER_DEEP, the shelves showing
// only where the day map's own colour happened to be lighter.
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
// it take their wet neighbours' depth near the coast and
// WATER_DEPTH_NEUTRAL beyond, whose floor is WATER_DEEP: a lake, or a coast
// the mask and the elevation map draw a texel apart, keeps the floor it had.
//
// The model: waterFloor(depth), three smoothsteps between four colours, the
// ramp from WATER_SHALLOW to WATER_SHELF over the shelf's first
// WATER_DEPTH_SHELF metres, to WATER_DEEP down the continental slope
// (WATER_DEPTH_SLOPE), and to WATER_TRENCH from the abyssal plain
// (WATER_DEPTH_ABYSS) to the trenches (WATER_DEPTH_TRENCH). Between the slope
// and the abyss, most of the open ocean, it is exactly WATER_DEEP, the floor
// every sea had before. Each stop darker than the last, so a deeper sea is
// never lighter. No imports: ./water.ts and the build script both read it.

/** The deepest depth the map encodes (m): Challenger Deep is ~10,920. */
export const WATER_DEPTH_MAX = 11000
/** The depth land and lakes take far from the sea (m): WATER_DEEP's. */
export const WATER_DEPTH_NEUTRAL = 3000
/** The ramp's stops (m): the shelf's shallows, the foot of the slope, the
 * abyssal plain and the trenches. */
export const WATER_DEPTH_SHELF = 200
export const WATER_DEPTH_SLOPE = 2000
export const WATER_DEPTH_ABYSS = 5500
export const WATER_DEPTH_TRENCH = 9000

type Rgb = readonly [number, number, number]
/** The floor's colours (linear): over sand a few metres down, the shelf,
 * deep water, and the trenches. */
export const WATER_SHALLOW: Rgb = [0.02, 0.085, 0.075]
export const WATER_SHELF: Rgb = [0.01, 0.04, 0.065]
export const WATER_DEEP: Rgb = [0.008, 0.022, 0.045]
export const WATER_TRENCH: Rgb = [0.003, 0.008, 0.022]

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
// GLSL's mix: exactly `b` at t = 1, so the open ocean's floor is WATER_DEEP.
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => a[i] * (1 - t) + b[i] * t) as unknown as Rgb

/** The floor at `depth` m, as the GLSL's waterFloor(). */
export function waterFloor(depth: number): [number, number, number] {
  let c = mix(WATER_SHALLOW, WATER_SHELF, smoothstep(0, WATER_DEPTH_SHELF, depth))
  c = mix(c, WATER_DEEP, smoothstep(WATER_DEPTH_SHELF, WATER_DEPTH_SLOPE, depth))
  return [...mix(c, WATER_TRENCH, smoothstep(WATER_DEPTH_ABYSS, WATER_DEPTH_TRENCH, depth))] as [number, number, number]
}

const f = (x: number) => x.toFixed(6)
const v3 = (c: readonly number[]) => `vec3(${c.map(f).join(', ')})`

/** The depth's uniform, the global the samples set, and the floor (after
 * common; ./water.ts puts it in its head). */
export const WATER_DEPTH_GLSL = /* glsl */ `
uniform sampler2D uWaterDepth;
float waterDepth;
// The floor at depth d m (waterFloor() mirrors it).
vec3 waterFloor(float d) {
  vec3 c = mix(${v3(WATER_SHALLOW)}, ${v3(WATER_SHELF)}, smoothstep(0.0, ${f(WATER_DEPTH_SHELF)}, d));
  c = mix(c, ${v3(WATER_DEEP)}, smoothstep(${f(WATER_DEPTH_SHELF)}, ${f(WATER_DEPTH_SLOPE)}, d));
  return mix(c, ${v3(WATER_TRENCH)}, smoothstep(${f(WATER_DEPTH_ABYSS)}, ${f(WATER_DEPTH_TRENCH)}, d));
}
`

const decode = (tap: string) => `${f(WATER_DEPTH_MAX)} * ${tap} * ${tap}`

/** Each chain's sample, ending its water prelude: the globe's at its
 * specular map's uv (the depth is on the mask's grid; with no mask there is
 * no water, and the neutral depth), the tiles' at the base's globe uv. */
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
{
  float waterDepthTap = surfaceGlobeTex(uWaterDepth, surfaceGlobeUv).r;
  waterDepth = ${decode('waterDepthTap')};
}
`,
} as const
