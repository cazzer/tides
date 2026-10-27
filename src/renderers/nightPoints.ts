// The night's city lights as points near the ground (tides-zmw.23). From
// orbit the night map (and VIIRS under the ship, ./gibsNightPatch.ts) is a
// texel or less a pixel and its glow is right; below a few kilometres one
// texel spans hundreds of pixels and the glow is a flat smear. Once the
// light's finest source in play is magnified past TEXEL_PX_START pixels a
// texel, the shader multiplies the emissive by nightPoints(): a field of
// small stochastic lights on the ground with the texel's brightness as their
// mean, so the light per area stays the map's and the smear resolves into
// specks over a dark ground.
//
// The field. The ground is cut into cells on the globe map's own uv
// (SphereGeometry's, as ./surface/tile-material.ts surfaceGlobeUv() takes
// it): NIGHT_POINTS_CELLS_U round each parallel, NIGHT_POINTS_CELLS_V pole to
// pole, so a level-0 cell is CELL0_M square at the equator and narrows east-
// west with the latitude's cosine k (the metric m = (k, 1) undoes it, so a
// light is round on the ground). Level l merges 4^l cells, its own hash per
// level. Each cell holds one light at a hashed point inside it, lit when a
// hashed threshold is under p: a kernel (1 - d'S^-1 d)^2 over the ellipse S,
// the light's own RADIUS_M widened by the pixel's footprint (BLUR_PX of
// it), so a light far smaller than a pixel still spreads over one and none
// aliases. A pixel picks the level whose cells are CELL_PX of its footprints
// across (cross-fading into the next over the last 0.3 of a level), which
// keeps each kernel inside the half cell round its own cell centre, so the
// 2x2 cells nearest the pixel hold every light that reaches it.
//
// Energy. A kernel's integral over the cell's coordinates is W (pi/3 the
// unit disk's, times the ellipse's sqrt(det S), over k for the narrowed u);
// the cells lit average E(p) (p itself away from the threshold's soft edge),
// so the sum over W E(p) is 1 on average and the texel's light, spread over
// its points, keeps its mean. p is the luminance over W PEAK: lights PEAK
// times the texel's colour at their centre, as many as that takes, until
// every cell is lit and the lights brighten instead. RESIDUAL of the glow
// stays as a floor, so the dark between the lights isn't black.
//
// Ground-anchored. The globe takes its cell coordinate from its own
// interpolated uv (vEmissiveMapUv times the cells), float32: 1/32 cell at
// the antimeridian's side of the map, a few metres, which the globe never
// draws close enough to show (the tiles draw the ground near the ship). The
// tiles' uv is per fragment from the quantised surfaceGround (~0.5 m steps),
// so they take the eye's cell in double from the CPU (nightPointsEye(), its
// integer and its fraction apart) plus the exact change to the fragment
// (nightPointsOffset(), small terms only), and their derivatives from the
// base's analytic surfaceGlobeDx/Dy; nothing here differences anything.
import * as THREE from 'three'
import { EARTH_RADIUS_KM } from '../cloud-layer'
import { GIBS_GROUND_WIDTH } from '../gibs-patch'

/** Level-0 cells round each parallel (a power of two: the hash wraps the
 * column at every level by a mask) and from pole to pole. */
export const NIGHT_POINTS_CELLS_U = 2 ** 19
export const NIGHT_POINTS_CELLS_V = 2 ** 18
/** A level-0 cell at the equator on the drawn sphere, metres (~76.4). */
export const NIGHT_POINTS_CELL0_M = (2 * Math.PI * EARTH_RADIUS_KM * 1000) / NIGHT_POINTS_CELLS_U
/** The coarsest level, 4^5 cells a side (~78 km): coarse enough that the
 * pixel's footprint stays under a cell over CELL_PX wherever the breakup is
 * on, down to COS_MIN (the test checks it). */
export const NIGHT_POINTS_LEVEL_MAX = 5
/** A cell's width in the pixel's footprints at the level picked. */
export const NIGHT_POINTS_CELL_PX = 4
/** The kernel's widening by the pixel's footprint, in footprints. */
export const NIGHT_POINTS_BLUR_PX = 1.5
/** A light's own radius on the ground, metres. */
export const NIGHT_POINTS_RADIUS_M = 3
/** Pixels a texel of the finest source from which the breakup starts, and
 * by which it is whole. */
export const NIGHT_POINTS_TEXEL_PX_START = 2
export const NIGHT_POINTS_TEXEL_PX_FULL = 6
/** A pixel's ground footprint, metres, under which the breakup is whole and
 * over which it is off (the globe from high up, at a grazing horizon). */
export const NIGHT_POINTS_PIXEL_M_FULL = 500
export const NIGHT_POINTS_PIXEL_M_OFF = 1000
/** A light's centre over the texel's colour, while there are cells to light. */
export const NIGHT_POINTS_PEAK = 4
/** Of the glow, kept under the lights. */
export const NIGHT_POINTS_RESIDUAL = 0.1
/** Half the width of a cell's threshold's soft edge. */
export const NIGHT_POINTS_SOFT = 0.05
/** The least latitude cosine the metric takes (~75.5°): no city lights
 * beyond, and it bounds the cells' aspect. */
export const NIGHT_POINTS_COS_MIN = 0.25
/** Of a level, where the cross-fade into the next starts. */
export const NIGHT_POINTS_FADE_FROM = 0.7

const f = (x: number) => x.toFixed(6)

/** The kernel's own radius in level-0 cells. */
const RADIUS_CELLS0 = NIGHT_POINTS_RADIUS_M / NIGHT_POINTS_CELL0_M

// Declarations after common (PI is three's). nightPointsHash is pcg3d
// (Jarzynski and Olano 2020). nightPointsLevel is one level's lights at a
// cell coordinate split into base (whole cells, exact in float32) and local
// (the rest; the globe's is all local), with dx/dy its screen derivatives,
// k the latitude's cosine and lum the texel's luminance. nightPoints is the
// emissive's factor, 1 where the breakup is off: v is the map's v and
// mapWidth the night map's width in texels; fine is VIIRS's cover (0 to 1),
// whose texels then set the breakup.
const HEAD = /* glsl */ `
#define NIGHT_POINTS_CELLS vec2(${f(NIGHT_POINTS_CELLS_U)}, ${f(NIGHT_POINTS_CELLS_V)})
uvec3 nightPointsHash(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
float nightPointsLevel(float level, vec2 base, vec2 local, vec2 dx, vec2 dy, float k, float lum) {
  float s = exp2(2.0 * level);
  vec2 hi = floor(base / s);
  vec2 at = (base - hi * s + local) / s;
  vec2 m = vec2(k, 1.0);
  vec2 mdx = dx * m / s;
  vec2 mdy = dy * m / s;
  float r = min(${f(RADIUS_CELLS0)} / s, 0.3 * k);
  mat2 S = mat2(r * r) + ${f(NIGHT_POINTS_BLUR_PX ** 2)} * (outerProduct(mdx, mdx) + outerProduct(mdy, mdy));
  mat2 Si = inverse(S);
  float W = ${f(Math.PI / 3)} * sqrt(determinant(S)) / k;
  float p = min(lum / (W * ${f(NIGHT_POINTS_PEAK)}), 1.0);
  // The cells lit on average: p, less what the soft edge loses at either end.
  float under = max(${f(NIGHT_POINTS_SOFT)} - p, 0.0);
  float over = max(p - ${f(1 - NIGHT_POINTS_SOFT)}, 0.0);
  float lit = p + (under * under - over * over) / ${f(4 * NIGHT_POINTS_SOFT)};
  int wrap = (${NIGHT_POINTS_CELLS_U} >> (2 * int(level))) - 1;
  vec2 c0 = floor(at - 0.5);
  float sum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 cell = c0 + vec2(float(i & 1), float(i >> 1));
    ivec2 id = ivec2(hi + cell);
    vec3 h = vec3(nightPointsHash(uvec3(uint(id.x & wrap), uint(id.y), uint(level))) >> 8u) / 16777216.0;
    vec2 d = (cell + h.xy - at) * m;
    float q = max(1.0 - dot(d, Si * d), 0.0);
    sum += q * q * clamp((p - h.z) / ${f(2 * NIGHT_POINTS_SOFT)} + 0.5, 0.0, 1.0);
  }
  return sum / (W * lit);
}
float nightPoints(vec3 source, float fine, vec2 base, vec2 local, vec2 dx, vec2 dy, float v, float mapWidth) {
  float lum = dot(source, vec3(0.2126, 0.7152, 0.0722));
  // log2 of the pixel's footprint and of the finest source's texel, in cells.
  float pixel = log2(max(length(dx), length(dy)));
  float texel = mix(log2(${f(NIGHT_POINTS_CELLS_U)} / mapWidth), ${f(Math.log2(NIGHT_POINTS_CELLS_U / GIBS_GROUND_WIDTH))}, fine);
  float breakup = smoothstep(${f(Math.log2(NIGHT_POINTS_TEXEL_PX_START))}, ${f(Math.log2(NIGHT_POINTS_TEXEL_PX_FULL))}, texel - pixel)
    * (1.0 - smoothstep(${f(Math.log2(NIGHT_POINTS_PIXEL_M_FULL / NIGHT_POINTS_CELL0_M))}, ${f(Math.log2(NIGHT_POINTS_PIXEL_M_OFF / NIGHT_POINTS_CELL0_M))}, pixel));
  if (breakup <= 0.0 || lum <= 0.0) return 1.0;
  float k = max(sin(v * PI), ${f(NIGHT_POINTS_COS_MIN)});
  // The level whose cells are CELL_PX footprints across (on the ground, and
  // over k: a cell is k as wide as tall), and the next over the level's end.
  float x = 0.5 * log2(${f(NIGHT_POINTS_CELL_PX)} * length(vec4(dx * vec2(k, 1.0), dy * vec2(k, 1.0))) / k);
  float above = floor(x) + 1.0;
  float l0 = clamp(above, 0.0, ${f(NIGHT_POINTS_LEVEL_MAX)});
  float t = above < 0.0 || above >= ${f(NIGHT_POINTS_LEVEL_MAX)} ? 0.0 : smoothstep(${f(NIGHT_POINTS_FADE_FROM)}, 1.0, fract(x));
  float n = 0.0;
  if (t < 1.0) n += (1.0 - t) * nightPointsLevel(l0, base, local, dx, dy, k, lum);
  if (t > 0.0) n += t * nightPointsLevel(l0 + 1.0, base, local, dx, dy, k, lum);
  return mix(1.0, ${f(NIGHT_POINTS_RESIDUAL)} + ${f(1 - NIGHT_POINTS_RESIDUAL)} * n, breakup);
}
`

// The tiles' only (after HEAD): the change of the cell coordinate from the
// eye e to e + r (the ground's frame, scene units), each angle as one atan
// of the small cross term over the large dot, so Earth's radius never
// cancels in float32 and the error scales with the ray, not the radius.
// u's angle turns in the equator's plane (x, -z); v's in the meridian's
// (rho, y), where rho's change is (rho'^2 - rho^2) / (rho' + rho).
const OFFSET_HEAD = /* glsl */ `
vec2 nightPointsOffset(vec3 e, vec3 r) {
  float rhoE2 = e.x * e.x + e.z * e.z;
  float rhoE = sqrt(rhoE2);
  float rhoP = length(vec2(e.x + r.x, e.z + r.z));
  float du = atan(e.z * r.x - e.x * r.z, rhoE2 + e.x * r.x + e.z * r.z);
  float dRho = (2.0 * (e.x * r.x + e.z * r.z) + r.x * r.x + r.z * r.z) / (rhoP + rhoE);
  float dv = atan(rhoE * r.y - e.y * dRho, rhoE * rhoP + e.y * (e.y + r.y));
  return vec2(du * RECIPROCAL_PI2, dv * RECIPROCAL_PI) * NIGHT_POINTS_CELLS;
}
`

/** The points' GLSL: head after common on the globe and the tiles,
 * offsetHead after it on the tiles. */
export const NIGHT_POINTS_GLSL = { head: HEAD, offsetHead: OFFSET_HEAD }

/**
 * The eye's level-0 cell coordinate, from its position in the ground's frame
 * (`eye`, any scale), in double: the whole cells (the column wrapped) in x
 * and y, the fraction in [0, 1) in z and w, so float32 keeps both exactly
 * enough. The uv is surfaceGlobeUv()'s (./surface/tile-material.ts).
 */
export function nightPointsEye(eye: THREE.Vector3, target: THREE.Vector4): THREE.Vector4 {
  const u = 0.5 + Math.atan2(-eye.z, eye.x) / (2 * Math.PI)
  const v = 0.5 + Math.atan2(eye.y, Math.hypot(eye.x, eye.z)) / Math.PI
  const cu = u * NIGHT_POINTS_CELLS_U
  const cv = v * NIGHT_POINTS_CELLS_V
  const iu = Math.floor(cu)
  const iv = Math.floor(cv)
  return target.set(iu % NIGHT_POINTS_CELLS_U, iv, cu - iu, cv - iv)
}
