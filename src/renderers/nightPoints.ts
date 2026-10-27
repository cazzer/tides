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
// hashed threshold is under p, at a hashed brightness (mean 1, SPREAD stops
// each way), so a lit city is no lattice of equal lights. A light is a
// white core (CORE_RADIUS_M, CORE of its light) in a dim warm glow
// (RADIUS_M), each (1 - d'S^-1 d)^2 over its ellipse S: its radius widened
// by the pixel's footprint (BLUR_PX of it), so a light smaller than a pixel
// still spreads over one and none aliases, at a grazing view too. A pixel
// picks the level whose cells are CELL_PX of its footprints across
// (cross-fading into the next over the last 0.3 of a level), which keeps
// each form inside the half cell round its own cell centre, so the 2x2
// cells nearest the pixel hold every light that reaches it.
//
// Energy. A form integrates to pi/3 sqrt(det S) / k over the cell
// coordinate (k for the narrowed u), so glow and core are each divided by
// theirs; the cells lit average lit (p itself away from the threshold's
// soft edge), the brightness 1, so the sum over lit is 1 on average and the
// texel's light, spread over its points, keeps its mean. p is the luminance
// over PEAK W (W the glow's area): the glow's centre PEAK times the texel's
// colour times the glow's share, as many lights as that takes, until every
// cell is lit and the lights brighten instead. W is held to at least
// W_GROUND level-0 cells, so near the ground, where the pixel no longer
// widens the light, how many cells are lit is the ground's, not the view's.
// RESIDUAL of the glow stays as a floor, so the dark between the lights
// isn't black. Every level's S is level 0's over 16^l (the radii are level
// 0's, clamped there to the half cell), so the forms and p are formed once.
//
// Ground-anchored. A float32 uv is ~0.5 m steps at Earth's radius, too
// coarse for the lights and their derivatives, so neither the globe nor the
// tiles read one: both take the eye's cell in double from the CPU
// (nightPointsEye(), its integer and its fraction apart) plus the exact
// change along the eye-relative ray to the drawn point (nightPointsOffset(),
// small terms only), and the derivatives as that ray's, turned into cells
// (nightPointsDelta(); the tiles' surfaceGlobeDx/Dy are the same). The
// globe's ray is its vertex less the eye, whose float32 rounding the CPU
// hands over apart (uNightPointsEyeLow); the tiles' is the base's
// surfaceRay. Both key on the drawn point's direction, so where the globe
// and the tiles draw the same ground they draw the same lights.
import * as THREE from 'three'
import { EARTH_RADIUS_KM } from '../cloud-layer'
import { GIBS_GROUND_WIDTH } from '../gibs-patch'

/** Level-0 cells round each parallel (a power of two: the hash wraps the
 * column at every level by a mask) and from pole to pole. */
export const NIGHT_POINTS_CELLS_U = 2 ** 19
export const NIGHT_POINTS_CELLS_V = 2 ** 18
/** A level-0 cell at the equator on the drawn sphere, metres (~76.4). */
export const NIGHT_POINTS_CELL0_M = (2 * Math.PI * EARTH_RADIUS_KM * 1000) / NIGHT_POINTS_CELLS_U
/** The coarsest level, 4^6 cells a side (~310 km): far enough that the
 * breakup holds toward a low horizon. It fades out over the level before,
 * so no pixel's footprint outgrows its cells. */
export const NIGHT_POINTS_LEVEL_MAX = 6
/** A cell's width in the pixel's footprints at the level picked. */
export const NIGHT_POINTS_CELL_PX = 4
/** The kernel's widening by the pixel's footprint, in footprints. */
export const NIGHT_POINTS_BLUR_PX = 1.5
/** A light's glow's radius on the ground, metres; at most 0.3 of a level-0
 * cell's width (23 m at the equator, 13 m at 55°). */
export const NIGHT_POINTS_RADIUS_M = 20
/** A light's core's radius on the ground, metres, and its share of the
 * light: the speck, white where the glow is warm. */
export const NIGHT_POINTS_CORE_RADIUS_M = 2
export const NIGHT_POINTS_CORE = 0.9
/** A light's brightness spread: log2-uniform over this many stops each way,
 * scaled to a mean of 1. */
export const NIGHT_POINTS_SPREAD = 1.5
/** Pixels a texel of the finest source from which the breakup starts, and
 * by which it is whole, across the footprint's narrow axis (at a grazing
 * view the texels are magnified across it however long the pixel is). */
export const NIGHT_POINTS_TEXEL_PX_START = 2
export const NIGHT_POINTS_TEXEL_PX_FULL = 6
/** The footprint's narrow axis on the ground, metres, under which the
 * breakup is whole and over which it is off (the globe from orbit). */
export const NIGHT_POINTS_PIXEL_M_FULL = 500
export const NIGHT_POINTS_PIXEL_M_OFF = 1000
/** A glow's centre over the texel's colour (less the core's share), while
 * there are cells to light. */
export const NIGHT_POINTS_PEAK = 5
/** The least glow area p is taken over, level-0 cells. */
export const NIGHT_POINTS_W_GROUND = 0.06
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

/** The glow's and the core's radii in level-0 cells. */
export const NIGHT_POINTS_RADIUS_CELLS0 = NIGHT_POINTS_RADIUS_M / NIGHT_POINTS_CELL0_M
export const NIGHT_POINTS_CORE_RADIUS_CELLS0 = NIGHT_POINTS_CORE_RADIUS_M / NIGHT_POINTS_CELL0_M
/** 1 over the mean of the 16 brightnesses a light's 4 hash bits pick. */
export const NIGHT_POINTS_WEIGHT_NORM =
  16 / Array.from({ length: 16 }, (_, i) => 2 ** (NIGHT_POINTS_SPREAD * ((i + 0.5) / 8 - 1))).reduce((a, b) => a + b)

// Declarations after common (PI is three's). nightPointsHash is
// lowbias32 (Wellons), one 32-bit hash a cell split into bit fields: 10 bits
// each for the light's place in the cell, 8 for its threshold, 4 for its
// brightness. nightPointsLevel is one level's lights at a cell coordinate
// split into base (whole cells, exact in float32) and local (the rest), with
// m the metric, glowSi0 and coreSi0 the inverses of level 0's S for the
// glow and the core, share0 each one's share over its area at level 0, and
// p0 level 0's p before it is clamped. nightPoints is the
// emissive's factor, 1 where the breakup is off: dx/dy are the coordinate's
// screen derivatives, v the map's v and mapWidth the night map's width in
// texels; fine is VIIRS's cover (0 to 1), whose texels then set the breakup.
const HEAD = /* glsl */ `
#define NIGHT_POINTS_CELLS vec2(${f(NIGHT_POINTS_CELLS_U)}, ${f(NIGHT_POINTS_CELLS_V)})
uint nightPointsHash(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
float nightPointsLevel(int level, vec2 base, vec2 local, vec2 m, mat2 glowSi0, mat2 coreSi0, vec2 share0, float p0) {
  float s = float(1 << (2 * level));
  float s2 = s * s;
  vec2 hi = floor(base / s);
  vec2 at = (base - hi * s + local) / s;
  mat2 glowSi = glowSi0 * s2;
  mat2 coreSi = coreSi0 * s2;
  float p = min(p0 * s2, 1.0);
  // The cells lit on average: p, less what the soft edge loses at either end.
  float under = max(${f(NIGHT_POINTS_SOFT)} - p, 0.0);
  float over = max(p - ${f(1 - NIGHT_POINTS_SOFT)}, 0.0);
  float lit = p + (under * under - over * over) / ${f(4 * NIGHT_POINTS_SOFT)};
  int wrap = (${NIGHT_POINTS_CELLS_U} >> (2 * level)) - 1;
  vec2 c0 = floor(at - 0.5);
  float sum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 cell = c0 + vec2(float(i & 1), float(i >> 1));
    ivec2 id = ivec2(hi + cell);
    uint h = nightPointsHash(uint(id.x & wrap) ^ nightPointsHash(uint(id.y) ^ uint(level << 24)));
    vec2 d = (cell + (vec2(uvec2(h, h >> 10u) & 1023u) + 0.5) / 1024.0 - at) * m;
    float glow = max(1.0 - dot(d, glowSi * d), 0.0);
    float core = max(1.0 - dot(d, coreSi * d), 0.0);
    float form = share0.x * glow * glow + share0.y * core * core;
    float threshold = (float((h >> 20u) & 255u) + 0.5) / 256.0;
    float brightness = ${f(NIGHT_POINTS_WEIGHT_NORM)} * exp2(${f(NIGHT_POINTS_SPREAD / 8)} * (float(h >> 28u) + 0.5) - ${f(NIGHT_POINTS_SPREAD)});
    sum += brightness * form * clamp((p - threshold) / ${f(2 * NIGHT_POINTS_SOFT)} + 0.5, 0.0, 1.0);
  }
  return sum * s2 / lit;
}
// The smaller singular value of the footprint [a b].
float nightPointsNarrow(vec2 a, vec2 b) {
  float frobenius = dot(a, a) + dot(b, b);
  float det = abs(a.x * b.y - a.y * b.x);
  return det / max(sqrt(0.5 * (frobenius + sqrt(max(frobenius * frobenius - 4.0 * det * det, 0.0)))), 1e-12);
}
float nightPoints(vec3 source, float fine, vec2 base, vec2 local, vec2 dx, vec2 dy, float v, float mapWidth) {
  float lum = dot(source, vec3(0.2126, 0.7152, 0.0722));
  float k = max(sin(v * PI), ${f(NIGHT_POINTS_COS_MIN)});
  vec2 m = vec2(k, 1.0);
  vec2 mdx = dx * m;
  vec2 mdy = dy * m;
  // log2 of the footprint's narrow axis in cells (where the texel is square)
  // and on the ground, and of the finest source's texel.
  float pixel = log2(max(nightPointsNarrow(dx, dy), 1e-6));
  float ground = log2(max(nightPointsNarrow(mdx, mdy), 1e-6));
  float texel = mix(log2(${f(NIGHT_POINTS_CELLS_U)} / mapWidth), ${f(Math.log2(NIGHT_POINTS_CELLS_U / GIBS_GROUND_WIDTH))}, fine);
  // The level whose cells are CELL_PX footprints across (on the ground, and
  // over k: a cell is k as wide as tall), and the next over the level's end.
  float footprint = length(vec4(mdx, mdy));
  float x = 0.5 * log2(max(${f(NIGHT_POINTS_CELL_PX)} * footprint / k, 1e-6));
  float breakup = smoothstep(${f(Math.log2(NIGHT_POINTS_TEXEL_PX_START))}, ${f(Math.log2(NIGHT_POINTS_TEXEL_PX_FULL))}, texel - pixel)
    * (1.0 - smoothstep(${f(Math.log2(NIGHT_POINTS_PIXEL_M_FULL / NIGHT_POINTS_CELL0_M))}, ${f(Math.log2(NIGHT_POINTS_PIXEL_M_OFF / NIGHT_POINTS_CELL0_M))}, ground))
    * (1.0 - smoothstep(${f(NIGHT_POINTS_LEVEL_MAX - 1)}, ${f(NIGHT_POINTS_LEVEL_MAX)}, x));
  if (breakup <= 0.0 || lum <= 0.0) return 1.0;
  int above = int(floor(x)) + 1;
  int l0 = clamp(above, 0, ${NIGHT_POINTS_LEVEL_MAX});
  float t = above < 0 || above >= ${NIGHT_POINTS_LEVEL_MAX} ? 0.0 : smoothstep(${f(NIGHT_POINTS_FADE_FROM)}, 1.0, fract(x));
  // Level 0's light: the glow and the core (each at most 0.3 k of a cell)
  // widened by the footprint, each normalised over its own area.
  mat2 blur = ${f(NIGHT_POINTS_BLUR_PX ** 2)} * (outerProduct(mdx, mdx) + outerProduct(mdy, mdy));
  float r = min(${f(NIGHT_POINTS_RADIUS_CELLS0)}, 0.3 * k);
  float rc = min(${f(NIGHT_POINTS_CORE_RADIUS_CELLS0)}, 0.3 * k);
  mat2 glowS = mat2(r * r) + blur;
  mat2 coreS = mat2(rc * rc) + blur;
  float A = sqrt(determinant(glowS)) / k;
  vec2 share = vec2(${f((1 - NIGHT_POINTS_CORE) * 3 / Math.PI)} / A, ${f((NIGHT_POINTS_CORE * 3) / Math.PI)} * k / sqrt(determinant(coreS)));
  float p0 = lum / (${f(NIGHT_POINTS_PEAK)} * max(${f(Math.PI / 3)} * A, ${f(NIGHT_POINTS_W_GROUND)}));
  mat2 glowSi = inverse(glowS);
  mat2 coreSi = inverse(coreS);
  float n = 0.0;
  if (t < 1.0) n += (1.0 - t) * nightPointsLevel(l0, base, local, m, glowSi, coreSi, share, p0);
  if (t > 0.0) n += t * nightPointsLevel(l0 + 1, base, local, m, glowSi, coreSi, share, p0);
  return mix(1.0, ${f(NIGHT_POINTS_RESIDUAL)} + ${f(1 - NIGHT_POINTS_RESIDUAL)} * n, breakup);
}
`

// After HEAD, where the ray is known: the change of the cell coordinate
// from the eye e to e + r (the ground's frame, scene units), each angle as
// one atan of the small cross term over the large dot, so Earth's radius
// never cancels in float32 and the error scales with the ray, not the
// radius. u's angle turns in the equator's plane (x, -z); v's in the
// meridian's (rho, y), where rho's change is (rho'^2 - rho^2) / (rho' + rho).
// nightPointsDelta is the change of the cell coordinate for a small change d
// of the point p (surfaceGlobeUvDelta() in cells, for d across the
// direction over the radius).
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
vec2 nightPointsDelta(vec3 p, vec3 d) {
  float inv = inversesqrt(dot(p, p));
  vec3 up = p * inv;
  vec3 t = (d - up * dot(up, d)) * inv;
  float h = max(up.x * up.x + up.z * up.z, 1e-12);
  return vec2((up.z * t.x - up.x * t.z) / h * RECIPROCAL_PI2, t.y * inversesqrt(h) * RECIPROCAL_PI) * NIGHT_POINTS_CELLS;
}
`

/** The points' GLSL: head, then offsetHead, after common on the globe and
 * the tiles. */
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
