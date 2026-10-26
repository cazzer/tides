// The cloud layer's materials (tides-y2e): a shell whose fragments march the
// view ray down through a height field of cloud tops, lit as cloud (wrapped
// diffuse, self-shadowing toward the Sun, sunset tint, forward scattering),
// and a patch for the ground's material that shades it from the same clouds.
// The low-quality path (CLOUD_FLAT) skips the march and the terrain: one
// sample on a flat shell, still shaded by the tops' slopes.
//
// Within the ship camera's reach of the shell (tides-01v.8.4: inside it, or
// near enough that the near plane may clip it), the material draws its back
// faces instead (three defines FLIP_SIDED) and the march starts at the
// camera; see the FLIP_SIDED branches. From below the tops (tides-01v.8.5)
// that march also meets the clouds' bases and the sides of their gaps, which
// are shaded darker as the light reaching them has come through the cloud.
// A march that starts in a cloud (tides-01v.8.6) first crosses its fog,
// from the same field, then goes on to whatever lies past it.
//
// Real weather's clouds are drawn by kind at the hit (tides-tvr.4.2): the
// blended cloud-type grid sets the tops' relief, the detail's erosion and
// grain (drawn out east-west for cirrus), the self-shadow and the underside
// (./cloudTypeGlsl.ts), in a program of their own (CLOUD_TYPED) for typed
// maps. The march, and so which top is hit and where, never sees the types.
//
// The maths mirrors ../cloud-layer.ts; constants come from there.
import * as THREE from 'three'
import {
  type EyeSample,
  type Vec3,
  airMass,
  ceilingReach,
  cloudFrame,
  CLOUD_CLEARANCE,
  CLOUD_FLAT_ALTITUDE,
  CLOUD_LAYER_TOP,
  CLOUD_MIN_ALPHA,
  CLOUD_UNITS_PER_KM,
  DETAIL_BASE_TEXELS,
  DETAIL_FADE_END,
  DETAIL_FADE_START,
  DETAIL_OCTAVES,
  DETAIL_OCTAVES_FLAT,
  EARTH_RADIUS_KM,
  eyePastOffsets,
  maxTopKm,
  FOG_EASE_SAMPLES,
  FOG_EASE_SECONDS,
  FOG_PATH,
  FOG_SOFT,
  MAX_CLOUD_TOP_KM,
  MIN_MEASURED_TOP_KM,
  SUNBEAM_FLOOR_KM,
  SUNLIGHT_EXTINCTION,
  SUNSET_FLOOR,
  TERRAIN_DISPLACEMENT,
  TERRAIN_KM_PER_GREY,
  TERRAIN_MAX_GREY,
  TERRAIN_READ_TEXELS,
} from '../cloud-layer'
import { CLOUD_AMBIENT, CLOUD_EXPOSURE, SUNLIGHT_INTENSITY } from '../lighting'
import { sceneRadius } from '../planets'
import { neutralTypeTexture } from './cloudBlend'
import { CLOUD_LOOK_GLSL } from './cloudTypeGlsl'
import { DETAIL_NOISE_GLSL, detailTurnsGlsl } from './detailNoise'
import { ECLIPSE_GLSL, type EclipseShadow, type MaterialPatch } from './eclipseShadow'
import {
  ATMOSPHERE_DUSK,
  ATMOSPHERE_GAIN,
  ATMOSPHERE_SCALE_HEIGHT,
  ATMOSPHERE_SKY,
  ATMOSPHERE_SURFACE,
  AURORA_SHELL_INNER,
  CLOUD_REACH_RENDER_ORDER,
  CLOUD_UNDER_AURORA_RENDER_ORDER,
  withinShellReach,
} from './earth-shells'
import { POLE_SMOOTH_CLOUD_TAPS, poleSmoothingGlsl, poleSmoothingLod } from './poleSmoothing'
import { LIMB_SEGMENTS, limbBody } from '../ship/limb-detail'
import { prefersReducedMotion } from '../ship/reduced-motion'
import { TERRAIN_MAP_SIZE } from '../ship/terrain-floor'
import { TERRAIN_BLEND, terrainScaleUniform } from '../terrain-scale'
import { liveTerrain } from './cloudTerrainScale'
import ceilingUrl from '../assets/earth-cloud-ceiling.bin?url'
import hazeGlsl from '../shaders/atmosphere/haze.glsl'
import depthGlsl from '../shaders/depth.glsl'

const f = (x: number) => x.toFixed(6)
const v3 = (v: readonly number[]) => `vec3(${v.map(f).join(', ')})`

export const MARCH_STEP = 0.011
// The cloud map's width the step was tuned to: at sea level, a texel is
// about 0.009, a little under a step.
export const MARCH_MAP_WIDTH = 2048
// Over how much height above the ground mesh a cloud thins out to nothing
// (tides-01v.8.19): under the clearance, so cloud over level ground keeps
// all of its opacity.
export const GROUND_FADE = 0.005
// Where the detail erodes a cloud's opacity (tides-tvr.3). Its coarsest
// octave is DETAIL_BASE_TEXELS map texels, about 31 km at 2560 wide, and
// real weather's broad decks sit at mid opacity, where the erosion
// (DETAIL_EDGE times 4c(1-c)) is strongest: up close the whole deck was
// pitted with holes at that one scale. The same pattern reads as texture a
// few pixels a wave and as holes tens of pixels a wave, so an octave erodes
// in full while its wave is at most DETAIL_GRAIN_PX pixels on screen, and
// inside a cloud eases to DETAIL_INTERIOR of that by DETAIL_HOLE_PX; near
// the cloud's edges it erodes in full whatever its size (detailEdge()).
// Pixels on screen are a view DETAIL_VIEW_PX tall's (detailPixelScale()):
// a share of the view, the same in any window and on any display. Seen from
// a scene unit up, the coarsest wave over the deck is then at most about 15
// such pixels on a 2048-wide map (11 on real weather's 2560), so far views
// keep the fractal edges of tides-01v.2 exactly. Up close, what erodes the
// deck's inside is the octaves under DETAIL_GRAIN_PX: the same grain a far
// view shows, not holes.
export const DETAIL_INTERIOR = 0.15
export const DETAIL_GRAIN_PX = 16
export const DETAIL_HOLE_PX = 20
export const DETAIL_VIEW_PX = 800
// The edge, in steps of the reads it is measured over: the slope's spacing,
// h scene units (three equatorial texels close up), a mip down. The reads
// can't tell how far on within a step a crisp rim lies: there, the fall
// over the step reads as about two steps of reach, less toward the rim as
// the opacity at the hit thins, so a crisp rim's band is the last texel or
// two where it thins, a soft one's about a step wider.
export const DETAIL_EDGE_NEAR = 1
export const DETAIL_EDGE_FAR = 2

/** Pixels of a view DETAIL_VIEW_PX tall a device pixel of a view
 * `viewHeight` device pixels tall stands for: uPixelScale. */
export function detailPixelScale(viewHeight: number): number {
  return viewHeight / DETAIL_VIEW_PX
}

/** How much of an octave of `wavelength` erodes the opacity at a pixel
 * `footprint` wide (both scene units; a pixel of a view DETAIL_VIEW_PX
 * tall), 0..1, `edge` (detailEdge()) of the way to a cloud's edge, for a
 * cloud whose inside erodes `interior` (its look's, tides-tvr.4.2):
 * cloudDetail()'s. */
export function detailErosion(
  footprint: number,
  wavelength: number,
  edge: number,
  interior: number = DETAIL_INTERIOR
): number {
  const grain = THREE.MathUtils.smoothstep(footprint / wavelength, 1 / DETAIL_HOLE_PX, 1 / DETAIL_GRAIN_PX)
  // mix(mix(interior, 1, grain), 1, edge), as the shader folds it.
  return 1 - (1 - interior) * (1 - edge) * (1 - grain)
}

/** How near a cloud of opacity `alpha` is to its edge, 1 there to 0 inside,
 * by how many steps of the reads on it stops showing (CLOUD_MIN_ALPHA), for
 * a fall in opacity of `fallPerStep` a step: the hit shading's. */
export function detailEdge(alpha: number, fallPerStep: number): number {
  const reach = (alpha - CLOUD_MIN_ALPHA) / Math.max(fallPerStep, 1e-4)
  return 1 - THREE.MathUtils.smoothstep(reach, DETAIL_EDGE_NEAR, DETAIL_EDGE_FAR)
}

/** The fall in opacity a step, by central differences of four reads a
 * step east, west, north and south of the hit: centred, so a rim facing
 * any way reads alike. */
export function detailFall(east: number, west: number, north: number, south: number): number {
  return 0.5 * Math.hypot(east - west, north - south)
}

// Steps for the longest path a march can take: a ray from the layer's top
// grazing the sea, under every base, and out again (sea level is Earth's
// scene radius, as EarthRenderer sets it); one from outside stops at the
// base, inside that. Short of that, a grazing ray's samples straddle the
// tops and the limb stair-steps along them (tides-01v.9). Since the base
// rose to CLOUD_CLEARANCE 0.012 (tides-42p), the sea-grazing chord is 4%
// longer than the base-grazing one the count was first taken over.
const SEA_LEVEL = sceneRadius(2000 * EARTH_RADIUS_KM)
export const MARCH_STEPS = Math.ceil(
  (2 * Math.sqrt((SEA_LEVEL + CLOUD_LAYER_TOP) ** 2 - SEA_LEVEL ** 2)) / MARCH_STEP
)
// Reads of the field within the step where the march from inside went down
// through a top (tides-ndh), once it has stopped there: each halves where in
// the step the ray meets the top, which is then solved linearly over the
// half left, so the top holds still to about 2^-MARCH_REFINE of a step
// however the steps fall along the ray. 0 leaves the step's own crossing.
export const MARCH_REFINE = 2

/**
 * The march's step phase (the shader's uMarchPhase, tides-ndh) once the eye
 * has moved `from` to `to` (in the clouds' frame), the view along unit
 * `forward`: the steps fall `phase` of a `step` short of whole steps from
 * the eye, so moving on by the eye's motion along the view keeps those
 * along it where they were over the clouds. Any phase will do to start
 * from, and after a jump.
 */
export function marchPhaseAfter(phase: number, from: Vec3, to: Vec3, forward: Vec3, step: number): number {
  const along =
    (to[0] - from[0]) * forward[0] + (to[1] - from[1]) * forward[1] + (to[2] - from[2]) * forward[2]
  const next = phase + along / step
  const share = next - Math.floor(next)
  // Under 1 as a float too (a phase of 1 would put the first step on the
  // eye): what would round up comes round to 0, the same steps.
  return share >= 1 - 2 ** -24 ? 0 : share
}

/** The fog's extinction over a step at the eye (fogExtinction() times
 * MARCH_STEP) over which the march's phase fades out (tides-ndh): from fog
 * that goes opaque (FOG_OPAQUE) within a step to fog that lets through
 * about a three-thousandth of the light. */
export const MARCH_PHASE_FADE: readonly [number, number] = [5.5, 8]

/** How much of the march's phase the march takes (the shader's vMarchPhase
 * over uMarchPhase) with the eye in fog of extinction `stepExtinction` over
 * a step (fogExtinction() at the eye times MARCH_STEP): all of it out of
 * dense fog, none in it. */
export function marchPhaseShare(stepExtinction: number): number {
  const [a, b] = MARCH_PHASE_FADE
  const t = Math.min(Math.max((stepExtinction - a) / (b - a), 0), 1)
  return 1 - t * t * (3 - 2 * t)
}

// Height field shared by the cloud shell and the ground's shadow.
const FIELD = /* glsl */ `
uniform sampler2D uCloudMap;
uniform sampler2D uTerrainMap;
uniform float uCloudShift;
uniform float uCloudMeasured;
uniform float uCloudMaxKm;
uniform vec3 uSunDir;
uniform float uSeaLevel;

#define CLOUD_PI 3.141592653589793
#define CLOUD_CLEARANCE ${f(CLOUD_CLEARANCE)}
#define CLOUD_UNITS_PER_KM ${f(CLOUD_UNITS_PER_KM)}
#define CLOUD_LAYER_TOP ${f(CLOUD_LAYER_TOP)}
#define CLOUD_FLAT_ALTITUDE ${f(CLOUD_FLAT_ALTITUDE)}
#define TERRAIN_DISPLACEMENT ${f(TERRAIN_DISPLACEMENT)}

${poleSmoothingGlsl('cloudPoleSmoothed', POLE_SMOOTH_CLOUD_TAPS)}

// directionToUv(): SphereGeometry's texture coordinates of a local direction.
vec2 cloudUv(vec3 dir) {
  float u = atan(dir.z, -dir.x) / (2.0 * CLOUD_PI);
  return vec2(fract(u), 0.5 + asin(clamp(dir.y, -1.0, 1.0)) / CLOUD_PI);
}

// Ground altitude, smoothed to about the ground mesh's vertex spacing.
float cloudTerrain(vec2 uv) {
#ifdef CLOUD_FLAT
  return 0.0;
#else
  float lod = max(0.0, log2(float(textureSize(uTerrainMap, 0).x) / ${f(TERRAIN_READ_TEXELS)}));
  return textureLod(uTerrainMap, vec2(fract(uv.x), clamp(uv.y, 0.0, 1.0)), lod).r
    * TERRAIN_DISPLACEMENT;
#endif
}

// cloudTopKm() and cloudColumn() over ground at altitude terrain (sampled
// by the caller: the ground is smooth, so one sample serves a neighbourhood).
// x: opacity, y: base altitude, z: top altitude, w: top height above the
// ground (km).
vec4 cloudColumn(vec2 uv, float lod, float terrain) {
  vec2 st = vec2(fract(uv.x - uCloudShift), clamp(uv.y, 0.0, 1.0));
  // Smoothed near the poles (./poleSmoothing.ts).
  vec3 c = cloudPoleSmoothed(uCloudMap, st,
    max(lod, log2(float(textureSize(uCloudMap, 0).x)) + ${f(poleSmoothingLod(1))}),
    textureLod(uCloudMap, st, lod)).rgb;
  float trust = c.b * uCloudMeasured;
  float km = mix(1.5 + 7.0 * c.g * c.g, max(c.r * ${f(MAX_CLOUD_TOP_KM)}, ${f(MIN_MEASURED_TOP_KM)}), trust);
  float base = terrain + CLOUD_CLEARANCE;
  float shape = 0.25 + 0.75 * smoothstep(0.0, 0.65, c.g);
  return vec4(c.g, base, base + CLOUD_UNITS_PER_KM * km * shape, km);
}

// How much sunlight a cloud of this opacity stops: thin veils hardly any.
float cloudShade(float alpha) {
  return smoothstep(0.12, 0.8, alpha);
}

// Mip level for a footprint (scene units) on the cloud texture.
float cloudLod(float footprint) {
  float texel = 2.0 * CLOUD_PI * uSeaLevel / float(textureSize(uCloudMap, 0).x);
  return max(0.0, log2(footprint / texel));
}
`

// The mip the march from inside reads at the eye (tides-tvr.1): its own
// steps' there, a level ray's a step across the map it was tuned to
// (cloudMarchLod()). The same for every ray, so that all of them agree on
// whether the eye is in a cloud; the base doesn't depend on it. The shell's
// alone: the ground's shadow, which shares FIELD, never reads the eye.
const EYE_LOD_GLSL = /* glsl */ `
float cloudEyeLod() {
  return max(0.0, log2(float(textureSize(uCloudMap, 0).x) / ${f(MARCH_MAP_WIDTH)}));
}
`

// fogExtinction(), split: deep in the column col (cloudColumn()), where it
// isn't a gap, and the share of that at altitude alt, toward its top and
// base. The march's fog, and (tides-ndh) the vertex stage's phase.
const FOG_EXTINCTION_GLSL = /* glsl */ `
float cloudFogDensity(vec4 col) {
  return col.x < ${f(CLOUD_MIN_ALPHA)} ? 0.0 : col.x * -log(1.0 - min(col.x, 0.995)) / ${f(FOG_PATH)};
}
float cloudFogEdge(vec4 col, float alt) {
  float inside = min(alt - col.y, col.z - alt);
  return inside <= 0.0 ? 0.0 : smoothstep(0.0, ${f(FOG_SOFT)} * (col.z - col.y), inside);
}
`

// How far inside a cloud q is, in its column's thickness, and over showing:
// at most 0 outside it. Read as the march reads the eye (cloudEyeLod()).
const FOG_INSIDE_GLSL = /* glsl */ `
float cloudFogInside(vec3 q) {
  float r = length(q);
  vec2 uv = cloudUv(q / r);
  vec4 col = cloudColumn(uv, cloudEyeLod(), cloudTerrain(uv));
  float alt = r - uSeaLevel;
  return min(min(alt - col.y, col.z - alt) / max(col.z - col.y, 1e-6), col.x - ${f(CLOUD_MIN_ALPHA)});
}
`

// With reduced motion (FOG_EASE), fog thickens over the eye's first
// FOG_EASE_SECONDS in a cloud (tides-01v.8.15) from the cloud as its side
// looked from just outside, so that flying in neither flashes white nor
// shows what lies past the wall. uFogPast holds where the eye was, among
// the clouds (which drift), at FOG_EASE_SAMPLES times over those seconds
// back, less where it is now; the vertex stage reads how long the eye, where
// the march decides whether it starts in a cloud (tides-tvr.1), has been in
// one from it, the same at every vertex.
const FOG_EASE_GLSL = /* glsl */ `
#define FOG_EASE_SAMPLES ${FOG_EASE_SAMPLES}
uniform vec3 uFogPast[FOG_EASE_SAMPLES];
varying float vFogEase;

// How far the fog of a march from q has eased in (fogEaseShare()): the
// share of FOG_EASE_SECONDS since q, moved as the eye has, was last out of
// the cloud, smoothed. A still eye's, all of it; one moving outside a
// cloud, none, for the cloud it is about to enter.
float cloudFogEase(vec3 q) {
  if (dot(uFogPast[FOG_EASE_SAMPLES - 1], uFogPast[FOG_EASE_SAMPLES - 1]) < 1e-12) return 1.0;
  float prev = cloudFogInside(q);
  if (prev <= 0.0) return 0.0;
  for (int k = 0; k < FOG_EASE_SAMPLES; k++) {
    float inside = cloudFogInside(q + uFogPast[k]);
    if (inside <= 0.0) {
      return smoothstep(0.0, 1.0, (float(k) + prev / (prev - inside)) / float(FOG_EASE_SAMPLES));
    }
    prev = inside;
  }
  return 1.0;
}
`

// Where the march's steps fall along every ray, as a share of a step short
// of whole steps from the eye (tides-ndh): moved on with the eye along the
// view (marchPhaseAfter()), so that in flight the steps hold still over the
// clouds ahead rather than sliding with the eye. Not in dense fog, though:
// there the march's fog goes opaque within a step of the eye, so the short
// first step the phase makes would take a step more on many rays (in the
// deck, a third more for the clouds). The vertex stage scales it by
// marchPhaseShare() of the fog's extinction over a step at the eye, as the
// march's start reads it: all of it in clear air, veils, and fog that a
// step's light gets through, none in fog opaque well within a step. Between,
// the phase still moves on, and each time it comes round the steps jump
// back by the share left of it (a step at most): a jump the opaque fog
// hides all but the first step's worth of (faded on the fog's onset instead,
// those jumps sat in the soft top and base of every cloud, and through thin
// veils, half a step every step's travel). The same at every vertex (flat),
// as on every ray.
const MARCH_PHASE_GLSL = /* glsl */ `
uniform float uMarchPhase;
flat varying float vMarchPhase;
`

const MARCH_PHASE_VERTEX_GLSL = /* glsl */ `
float cloudFogStep(vec3 q) {
  float r = length(q);
  vec2 uv = cloudUv(q / r);
  vec4 col = cloudColumn(uv, cloudEyeLod(), cloudTerrain(uv));
  return cloudFogDensity(col) * cloudFogEdge(col, r - uSeaLevel) * ${f(MARCH_STEP)};
}
`

const VERTEX = /* glsl */ `
#include <common>
${ECLIPSE_GLSL.vertexHead}
varying vec3 vLocal;
varying vec3 vRayDir;
#ifdef FLIP_SIDED
// The camera in the mesh's frame, the fragment's depth in front of it and
// the near plane's, and the ground under the camera for the eclipse.
varying vec3 vEye;
varying float vViewDepth;
varying float vNear;
varying vec3 vEclipseEye;
${depthGlsl}
${FIELD}
${EYE_LOD_GLSL}
${FOG_EXTINCTION_GLSL}
${MARCH_PHASE_GLSL}
${MARCH_PHASE_VERTEX_GLSL}
#ifdef FOG_EASE
${FOG_INSIDE_GLSL}
${FOG_EASE_GLSL}
#endif
#endif

void main() {
  vLocal = position;
  vec4 world = modelMatrix * vec4(position, 1.0);
  // The camera's view ray, into the mesh's frame (rotation and uniform
  // scale only, so the transpose inverts it up to length).
  vec3 ray = isOrthographic
    ? -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2])
    : world.xyz - cameraPosition;
  vRayDir = transpose(mat3(modelMatrix)) * ray;
  ${ECLIPSE_GLSL.vertexBody}
  #ifdef FLIP_SIDED
  // Within reach the camera can sit a hair off the shell, and world
  // positions, thousands of units out at the flight scale, would bury that
  // gap in rounding. The view-space position (modelViewMatrix, formed by
  // three in double) keeps it, so here the ray, the eye and the depth all
  // come from there. The transpose inverts it as the Earth group is unscaled.
  vec4 view = modelViewMatrix * vec4(position, 1.0);
  vRayDir = transpose(mat3(modelViewMatrix)) * view.xyz;
  vEye = position - vRayDir;
  vEclipseEye = eclipsePoint(vEye);
  vViewDepth = -view.z;
  vNear = isOrthographic ? 0.0 : viewDepthNear(projectionMatrix);
  #ifdef CLOUD_FLAT
  vMarchPhase = 0.0;
  #else
  // Read at the eye as the march's start reads it, and so the same at
  // every vertex, as the phase must be on every ray (tides-ndh).
  vMarchPhase = uMarchPhase
    * (1.0 - smoothstep(${f(MARCH_PHASE_FADE[0])}, ${f(MARCH_PHASE_FADE[1])}, cloudFogStep(vEye)));
  #endif
  #ifdef FOG_EASE
  // At the eye, where the march decides whether it starts in a cloud
  // (tides-tvr.1): the same at every vertex.
  vFogEase = cloudFogEase(vEye);
  #endif
  gl_Position = projectionMatrix * view;
  #else
  gl_Position = projectionMatrix * viewMatrix * world;
  #endif
}
`

const FRAGMENT = /* glsl */ `
#include <common>
${ECLIPSE_GLSL.fragmentHead}
${FIELD}
${EYE_LOD_GLSL}
uniform float uOpacity;
uniform float uSunGain;
uniform float uAmbient;
varying vec3 vLocal;
varying vec3 vRayDir;
#ifdef FLIP_SIDED
uniform mat4 projectionMatrix;
${depthGlsl}
${MARCH_PHASE_GLSL}
varying vec3 vEye;
varying float vViewDepth;
varying float vNear;
varying vec3 vEclipseEye;
// The hit's own point for the eclipse: the vertex's lies past the globe.
uniform mat4 modelMatrix;
uniform vec2 uEclipseBody;
${ECLIPSE_GLSL.point}
#define CLOUD_ECLIPSE_HIT eclipsePoint(pShade)
// The highest ground the high tier's elevation map holds (TERRAIN_MAX_GREY).
#define TERRAIN_TOP ${f(TERRAIN_DISPLACEMENT * TERRAIN_MAX_GREY)}
// How far past a flank its cloud is read, and how many steps past a side.
#define WALL_DEPTH ${f(MARCH_STEP / 2)}
// The rest of a side, after those, is taken in one: through the column as
// it is there, to its top or base, past which the march goes on, but no
// further than SIDE_REST.
#define SIDE_STEPS 2
#define SIDE_REST ${f(4 * MARCH_STEP)}
// The mip whose tops stand for those around the camera: about 8 texels.
#define NEAR_TOPS_LOD 3.0

// Where the fog lets so little through that what lies past it can't show.
#define FOG_OPAQUE 0.004
// The fog's own steps per march step, over the column and altitude
// interpolated between the march's samples: fog thickens within a step.
#define FOG_SUBSTEPS 8
// A side the ray leaves: it carries on, the side a veil over what it meets
// (shaded as that is: stopping at dense veils instead, shaded as the veil,
// would draw an edge where the two meet).
#define CLOUD_VEILED (veilClear < 1.0)
#define CLOUD_VEIL { if (sVeil < 0.0) { sVeil = sHit; colVeil = colIn; upVeil = upThrough; } veilClear *= sideClear; side = false; sHit = -1.0; }
// A ray that meets no cloud past its fog draws the fog alone.
#define CLOUD_MISS { if (fogged) { cloudOut(vec4(fogLight, 1.0 - fogClear), FRAG_DEPTH_NEAREST, vec3(0.0), 0.0); return; } discard; }
#ifdef FOG_EASE
// With reduced motion, how far the fog has eased in (FOG_EASE_GLSL): the
// same at every vertex, so the same here but for rounding.
varying float vFogEase;
#endif

// The cloud ceiling (../cloud-layer.ts cloudCeiling()): its texels' greys,
// rows north first, and how far along a ray above it stays within its arc
// of where it was read, from anywhere above the sea.
uniform sampler2D uCloudCeiling;
#define CEILING_REACH (uSeaLevel * ${f(ceilingReach(1))})
// Reads of it at each end of the march, before the march's own steps.
#define CEILING_READS 6

// The radius below which cloud can stand within the ceiling's arc of q.
float cloudCeilingRadius(vec3 q) {
  vec2 uv = cloudUv(normalize(q));
  ivec2 size = textureSize(uCloudCeiling, 0);
  ivec2 cell = clamp(ivec2(vec2(uv.x, 1.0 - uv.y) * vec2(size)), ivec2(0), size - 1);
  return uSeaLevel + texelFetch(uCloudCeiling, cell, 0).r * TERRAIN_DISPLACEMENT
    + CLOUD_CLEARANCE + CLOUD_UNITS_PER_KM * uCloudMaxKm;
}

// The ground mesh's altitude at uv (cloudUv()): within reach, the limb
// sphere's (LIMB_SEGMENTS), its vertices raised by the ground texture's top
// level read at their texel corners (groundDisplacement.ts), and flat between
// them over each of a quad's two triangles. The columns stand on the ground
// smoothed (cloudTerrain()), so where the relief rises above that by more
// than the clearance their cloud runs into it.
#define GROUND_SEGMENTS vec2(${LIMB_SEGMENTS.map((n) => f(n)).join(', ')})
float cloudGroundAt(vec2 vertex) {
  return textureLod(uTerrainMap, vec2(vertex.x, GROUND_SEGMENTS.y - vertex.y) / GROUND_SEGMENTS, 0.0).r;
}
float cloudGround(vec2 uv) {
  // Vertex columns east from the dateline, rows south from the pole; each
  // quad split from its north-west corner to its south-east.
  vec2 cell = vec2(uv.x, 1.0 - uv.y) * GROUND_SEGMENTS;
  vec2 i = min(floor(cell), GROUND_SEGMENTS - 1.0);
  vec2 t = cell - i;
  bool east = t.y <= t.x;
  float h0 = cloudGroundAt(i);
  float h1 = cloudGroundAt(i + (east ? vec2(1.0, 0.0) : vec2(0.0, 1.0)));
  float h2 = cloudGroundAt(i + 1.0);
  vec2 w = east ? t : t.yx;
  return (h0 + w.x * (h1 - h0) + w.y * (h2 - h1)) * TERRAIN_DISPLACEMENT;
}
// Over how much height above that ground a cloud thins out, so the depth
// test cuts it where it is already gone.
#define GROUND_FADE ${f(GROUND_FADE)}

// cloudPathClear()
float cloudPathClear(float alpha, float thickness, float path) {
  return pow(1.0 - min(alpha, 0.995), path / max(thickness, 1e-4));
}

// The atmosphere's haze (AtmosphereRenderer's uniforms, from the sea level).
#define uSurface (uSeaLevel * ${f(ATMOSPHERE_SURFACE)})
#define uScaleHeight (uSeaLevel * ${f(ATMOSPHERE_SCALE_HEIGHT)})
#define uGain ${f(ATMOSPHERE_GAIN)}
#define uSky ${v3(ATMOSPHERE_SKY)}
#define uDusk ${v3(ATMOSPHERE_DUSK)}
${hazeGlsl}

// Within reach the atmosphere draws its haze before the clouds
// (earth-shells.ts CLOUD_REACH_RENDER_ORDER), each ray's as a whole, so a
// cloud would hide the haze in front of it too. This is that share: the
// haze between the eye and s along d (columnAhead() from each end), from
// inside a cloud none. Toward the top of the shell (shell), where the
// order changes, it eases to all of it, the haze past far clouds too, as
// the clouds looked when they drew first.
vec3 cloudHazeFront(vec3 eye, vec3 d, float s, float shell) {
  float grazing = sqrt(2.0 * CLOUD_PI * uSurface * uScaleHeight);
  vec3 at;
  vec3 atPast;
  float column = columnAhead(eye, d, grazing, at);
  float past = columnAhead(eye + d * s, d, grazing, atPast);
  float front = clamp(1.0 - past / max(column, 1e-9), 0.0, 1.0);
  front = mix(front, 1.0, smoothstep(shell - 2.0 * uScaleHeight, shell, length(eye)));
  return hazeGlow(column, grazing, at, uSunDir) * front;
}

// The fragment, premultiplied, at depth z (the program writes gl_FragDepth
// on every path), with share of the haze added over it as the atmosphere's
// additive blend would, after the output transforms.
void cloudOut(vec4 color, float z, vec3 haze, float share) {
  gl_FragColor = vec4(haze, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  vec3 hazeOut = gl_FragColor.rgb;
  gl_FragColor = color;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb = gl_FragColor.rgb * gl_FragColor.a + share * hazeOut;
  gl_FragDepth = z;
}
#else
#define CLOUD_MISS discard
#define CLOUD_VEILED false
#define CLOUD_ECLIPSE_HIT vEclipsePoint
#endif

#define RELIEF 1.2
#define MAX_SLOPE 0.75
#define WRAP 0.6
#define MARCH_STEP ${f(MARCH_STEP)}
#define MARCH_STEPS ${MARCH_STEPS}
#define MARCH_REFINE ${MARCH_REFINE}
// How far the ground under a march may rise above the ground at its entry.
#define TERRAIN_SLACK 0.01
#ifdef CLOUD_FLAT
#define SHADOW_STEPS 2
#define SHADOW_STEP 0.012
#else
#define SHADOW_STEPS 3
#define SHADOW_STEP 0.0065
#endif
#define SHADOW_SOFT 0.02
#define SHADOW_DARK 0.5
#define SKY 0.22
#define FORWARD 0.6
#define CLOUD_MIN_ALPHA ${f(CLOUD_MIN_ALPHA)}
// How much of its light the underside of the thickest cloud loses.
#define UNDERSIDE_DARK 0.65

// The stretch (from, until) of a step over which a quantity changing
// linearly from f0 to f1 is at most 0; from > until where it is nowhere.
vec2 cloudSpan(float f0, float f1) {
  if (f0 <= 0.0 && f1 <= 0.0) return vec2(0.0, 1.0);
  if (f0 > 0.0 && f1 > 0.0) return vec2(1.0, 0.0);
  float w = f0 / (f0 - f1);
  return f0 > 0.0 ? vec2(w, 1.0) : vec2(0.0, w);
}

#ifdef FLIP_SIDED
// lightCentroid(): how far along a stretch of even cloud, letting clear
// through, the light it sends back comes from on average. Half way through
// a thin one, nearer its front the thicker it is.
float cloudLightCentroid(float clear) {
  float c = max(clear, 1e-6);
  float tau = -log(c);
  return tau < 0.05 ? 0.5 - tau / 12.0 : 1.0 / tau - c / (1.0 - c);
}

// Adds what a stretch of cloud sends back, by weight, to shade (the sums of
// its depth down its column, its distance along the ray, and its column's
// top and base) and weight: as from t of a step over which its column (c0 to
// c1), the ray's altitude (a0 to a1) and distance (s0 to s1) change
// linearly, as the crossing takes them.
void cloudShadeAdd(inout vec4 shade, inout float weight, float w, vec4 c0, vec4 c1, float a0,
    float a1, float s0, float s1, float t) {
  vec4 c = mix(c0, c1, t);
  float depth = clamp((c.z - mix(a0, a1, t)) / max(c.z - c.y, 1e-6), 0.0, 1.0);
  shade += w * vec4(depth, mix(s0, s1, t), c.z, c.y);
  weight += w;
}
#endif

// The march meets the tops only at its steps, so it reads them no sharper
// than the map it was tuned to (MARCH_MAP_WIDTH texels around) gives them a
// step apart: the mip for a step of across (scene units) over the map. A
// sharper map's tops, found at one step and missed at the next, would
// stand in combs (tides-01v.12); the hit is still shaded at the pixel's mip.
float cloudMarchLod(float across) {
  return log2(max(across, 1e-9) / MARCH_STEP * float(textureSize(uCloudMap, 0).x) / ${f(MARCH_MAP_WIDTH)});
}

// sunbeamAirMass() and sunlightTint()
vec3 cloudSunTint(float mu, float km) {
  float h = max(0.0, km);
  float m;
  if (mu >= 0.0) {
    float zenith = min(90.0, degrees(acos(clamp(mu, -1.0, 1.0))));
    m = (1.0 / (cos(radians(zenith)) + 0.50572 * pow(96.07995 - zenith, -1.6364)) - 1.0)
      * exp(-h / 8.0);
  } else {
    float tangent = (${f(EARTH_RADIUS_KM)} + h) * sqrt(1.0 - mu * mu) - ${f(EARTH_RADIUS_KM)};
    m = ${f(airMass(0) - 1)} * exp(-max(0.0, tangent) / 8.0) * (2.0 - exp(-max(0.0, h - tangent) / 8.0));
  }
  vec3 t = exp(-vec3(${SUNLIGHT_EXTINCTION.map(f).join(', ')}) * m);
  return t / max(t.r, ${f(SUNSET_FLOOR)});
}

// horizonDipSin()
float cloudDipSin(float km) {
  float c = ${f(EARTH_RADIUS_KM)} / (${f(EARTH_RADIUS_KM)} + max(0.0, km));
  return sqrt(max(0.0, 1.0 - c * c));
}

// sunVisibility()
float cloudSunUp(float mu, float km) {
  return smoothstep(-0.01, 0.01, mu + cloudDipSin(km - ${f(SUNBEAM_FLOOR_KM)}));
}

// Fine detail where the map is magnified (detailOctaveWeights()): value-noise
// fBm in object space, so it has no dateline seam and no polar pinch, in the
// clouds' own frame, so it drifts with the static clouds and stays on the
// ground under real ones. It erodes the opacity, most at mid opacity, and
// roughens the tops; an octave large on screen erodes only near the cloud's
// edges (DETAIL_INTERIOR, tides-tvr.3).
#ifdef CLOUD_FLAT
#define DETAIL_OCTAVES ${DETAIL_OCTAVES_FLAT}
${detailTurnsGlsl(DETAIL_OCTAVES_FLAT)}
#else
#define DETAIL_OCTAVES ${DETAIL_OCTAVES}
${detailTurnsGlsl(DETAIL_OCTAVES)}
#endif
#define DETAIL_EDGE 0.8
#define DETAIL_INTERIOR ${f(DETAIL_INTERIOR)}
#define DETAIL_GRAIN_PX ${f(DETAIL_GRAIN_PX)}
#define DETAIL_HOLE_PX ${f(DETAIL_HOLE_PX)}
#define DETAIL_EDGE_NEAR ${f(DETAIL_EDGE_NEAR)}
#define DETAIL_EDGE_FAR ${f(DETAIL_EDGE_FAR)}
// Tilt of the tops per unit of noise slope, over the coarsest wavelength;
// each finer octave tilts them DETAIL_ROUGH as much as the last, and the
// whole is capped, so the texture's own slopes still read through.
#define DETAIL_RELIEF 0.35
#define DETAIL_ROUGH 0.6
#define DETAIL_MAX_SLOPE 0.35

${DETAIL_NOISE_GLSL}

// Pixels of a view DETAIL_VIEW_PX tall a device pixel of the view drawn
// stands for (detailPixelScale()): an octave's size on screen, against
// DETAIL_GRAIN_PX and DETAIL_HOLE_PX, is a share of the view.
uniform float uPixelScale;

#ifdef CLOUD_TYPED
${CLOUD_LOOK_GLSL}
#endif

// fBm at p (scene units, the clouds' frame) seen at footprint, edge
// (detailEdge()) of the way to the cloud's edge: x in about -1..1, the
// opacity's erosion, yzw its gradient per scene unit. Octaves stop where
// they would shrink under a few pixels; one large on screen erodes less
// inside a cloud (detailErosion()), but roughens the tops as ever; typed
// (tides-tvr.4.2), interior of the way (its look's DETAIL_INTERIOR).
#ifdef CLOUD_TYPED
vec4 cloudDetail(vec3 p, float footprint, float texel, float edge, float interior) {
#else
vec4 cloudDetail(vec3 p, float footprint, float texel, float edge) {
#endif
  float wavelength = ${f(DETAIL_BASE_TEXELS)} * texel;
  float amp = 0.5;
  float rough = 0.5;
  vec4 sum = vec4(0.0);
  // What an octave large on screen spares of the erosion inside a cloud
  // (detailErosion()), and a pixel (uPixelScale) over its wave.
#ifdef CLOUD_TYPED
  float spare = (1.0 - interior) * (1.0 - edge);
#else
  float spare = (1.0 - DETAIL_INTERIOR) * (1.0 - edge);
#endif
  float screenRatio = footprint * uPixelScale / wavelength;
  for (int k = 0; k < DETAIL_OCTAVES; k++) {
    float weight = 1.0 - smoothstep(${f(DETAIL_FADE_START)}, ${f(DETAIL_FADE_END)}, footprint / wavelength);
    if (weight <= 0.0) break;
    float erode = 1.0 - spare * (1.0 - smoothstep(1.0 / DETAIL_HOLE_PX, 1.0 / DETAIL_GRAIN_PX, screenRatio));
    vec4 o = detailNoise(DETAIL_TURNS[k] * p / wavelength + float(k) * 17.31);
    // o.yzw * turn: the gradient turned back (the transpose).
    sum += weight * vec4(erode * amp * (2.0 * o.x - 1.0), rough * 2.0 * (o.yzw * DETAIL_TURNS[k]) / wavelength);
    wavelength *= 0.5;
    screenRatio *= 2.0;
    amp *= 0.5;
    rough *= 0.5 * DETAIL_ROUGH;
  }
  return sum;
}

// Into and out of the clouds' frame: turned about the pole by the drift, so
// cloudUv() of the result is the texture coordinate the cloud was painted at.
vec3 cloudFrame(vec3 v, float turns) {
  float c = cos(2.0 * CLOUD_PI * turns);
  float s = sin(2.0 * CLOUD_PI * turns);
  return vec3(v.x * c - v.z * s, v.y, v.z * c + v.x * s);
}

// True height above sea level (km) of a point at altitude alt over a column
// based at base, for the horizon dip and the air mass.
float cloudKm(float alt, float base) {
  return (alt - base) / CLOUD_UNITS_PER_KM
    + (base - CLOUD_CLEARANCE) / TERRAIN_DISPLACEMENT * ${f(TERRAIN_KM_PER_GREY)};
}

// The light cloud of opacity alpha sends back along d from a point up (unit)
// at km, facing n, depth down its column (columnDepth()), occ shaded by
// taller cloud toward the Sun, and eclipsed as the ground at eclipsePoint.
vec3 cloudRadiance(vec3 up, vec3 n, vec3 d, float alpha, float depth, float km, float occ,
    vec3 eclipsePoint) {
  vec3 s = uSunDir;
  float mu = dot(up, s);
  float sunUp = cloudSunUp(mu, km);
  vec3 tint = cloudSunTint(mu, km);
  float eclipse = uEclipseActive > 0.5 ? eclipseSunlight(eclipsePoint).x : 1.0;
  float light = sunUp * (1.0 - SHADOW_DARK * occ) * eclipse;

  // Wrapped diffuse softens the day side; toward the terminator it gives
  // way to the tops' own slopes, so only the tops facing the low Sun catch
  // its light.
  float wrap = WRAP * smoothstep(-0.02, 0.2, mu);
  float diffuse = clamp((dot(n, s) + wrap) / (1.0 + wrap), 0.0, 1.0);
  // Down a column the light has come through the cloud above: the column's
  // share of the Sun rather than its tops' slopes', and as much less of it
  // as the cloud stops.
  diffuse = mix(diffuse, clamp((mu + wrap) / (1.0 + wrap), 0.0, 1.0), depth);
  // Thick cloud turned from the Sun reads grey.
  float albedo = 1.0 - 0.3 * smoothstep(0.5, 1.0, alpha) * (1.0 - diffuse);
  vec3 sky = vec3(0.55, 0.68, 0.9) * SKY * smoothstep(-0.1, 0.35, mu);
  // Henyey-Greenstein forward lobe: thin cloud glows looking toward the Sun.
  float cosT = dot(d, s);
  float hg = 0.25 * (1.0 - 0.36) / pow(1.36 - 1.2 * cosT, 1.5);
  float edge = 4.0 * alpha * (1.0 - alpha);
  return (albedo * (uSunGain * (tint * light * diffuse + sky) + uAmbient)
    + uSunGain * FORWARD * tint * light * hg * edge)
    * (1.0 - UNDERSIDE_DARK * depth * cloudShade(alpha));
}

#ifdef FLIP_SIDED
${FOG_EXTINCTION_GLSL}
#ifdef FOG_EASE
// cloudPathClear()'s extinction: a side's, which the fog eases from.
float cloudSideDensity(vec4 col) {
  return col.x < CLOUD_MIN_ALPHA ? 0.0 : -log(1.0 - min(col.x, 0.995)) / max(col.z - col.y, 1e-4);
}
// The fog's extinction sigma (density times edge, cloudFogEdge()), eased
// by ease from the side's density, which is all or none.
float cloudFogEased(float sigma, float side, float edge, float ease) {
  return ease < 1.0 ? mix(edge > 0.0 ? side : 0.0, sigma, ease) : sigma;
}
#endif

// The column (cloudColumn()) the march from inside reads at uv, r from the
// centre and s along the ray from the eye (mu, the sine of its elevation
// there), over ground at terrain, its steps ds apart: at a pixel's width
// there, stretched by the slant toward a top or a base, but within the
// deck's height, across a side, what a step meets; and no finer than a
// step's way across the map (cloudMarchLod(), tides-01v.12). How much of
// the deck the ray is in eases over a step past its base and past the
// tallest top, read where the ray is rather than (as it was) whether the
// last step was in it, so the mip changes smoothly along the ray and not as
// the steps slide along it (tides-16z). From above the tops around the
// camera, all of it is slant.
vec4 cloudMarchColumn(vec2 uv, float r, float mu, float terrain, float s, float ds, float spread,
    bool fromAbove) {
  float h = r - uSeaLevel - terrain - CLOUD_CLEARANCE;
  float deckH = CLOUD_UNITS_PER_KM * uCloudMaxKm;
  float deck = fromAbove ? 0.0
    : smoothstep(-MARCH_STEP, 0.0, h) * (1.0 - smoothstep(deckH, deckH + MARCH_STEP, h));
  float slant = mix(max(abs(mu), 0.05), 1.0, deck);
  float lod = max(cloudLod(spread * s / slant),
    cloudMarchLod(ds * sqrt(max(1.0 - mu * mu, 0.0))));
  // Within a step of the eye, eased to the mip the march's start reads the
  // eye at (cloudEyeLod()), all of it at the eye (tides-ndh): a first step
  // that the phase has made short then reads the cloud there as the start
  // did, rather than at its ray's own mip, which near a cloud's edge could
  // put it out of the cloud the start is in and end the fog there, until
  // the phase came round.
  lod = mix(cloudEyeLod(), lod, min(s / ds, 1.0));
  return cloudColumn(uv, lod, terrain);
}

#endif

void main() {
  vec3 d = normalize(vRayDir);
  // Derivatives before any discard: after one they are undefined.
  float footprint = max(length(dFdx(vLocal)), length(dFdy(vLocal)));
#ifdef FLIP_SIDED
  // The ray's spread: a pixel's width on the image plane a unit in front of
  // the eye, the same anywhere on screen. A pixel's angle falls off toward
  // the screen's edges, so turning the camera would change the mip each ray
  // reads, and close up, the detail that shows (tides-16z). The price of
  // holding still as the camera turns: toward the corners this is wider
  // than a pixel's own angle (by up to 1/cos² of the ray's angle off the
  // axis), so the clouds there read up to about a mip coarser.
  vec3 plane = vRayDir / vViewDepth;
  float spread = max(length(dFdx(plane)), length(dFdy(plane)));
#else
  // The ray's spread, a pixel's angle; unlike vLocal's, smooth across facets.
  float spread = max(length(dFdx(d)), length(dFdy(d)));
#endif
  float lod = cloudLod(footprint);

#ifdef CLOUD_FLAT
  float shell = uSeaLevel + CLOUD_FLAT_ALTITUDE;
#else
  float shell = uSeaLevel + CLOUD_LAYER_TOP;
#endif
  // Where the ray enters the true sphere (the mesh is only a polygon).
  float b = dot(vLocal, d);
  float disc = b * b - (dot(vLocal, vLocal) - shell * shell);
  if (disc <= 0.0) discard;
  float tIn = -b - sqrt(disc);

#ifdef FLIP_SIDED
  // Every ray within reach meets the far side of the shell, so the back
  // faces alone draw them all, inside the shell or out, and the march
  // covers the ray from the eye on, the near plane bounding only the depth
  // it writes (tides-tvr.1). s runs along d from the eye rather than from
  // vLocal, which lies past the globe.
  vec3 eye = vEye;
  float be = dot(eye, d);
  float discEye = be * be - (dot(eye, eye) - shell * shell);
  if (discEye <= 0.0) discard;
  float sIn = -be - sqrt(discEye);
  float sOut = -be + sqrt(discEye);
  // View depth scales with distance along the ray.
  float sNear = vNear * length(vRayDir) / vViewDepth;
  // The column the march stepped into at its hit, whether that was a side,
  // how much light gets through the cloud behind it, and how far down its
  // column the hit lies where the crossing tells (below; else -1).
  vec4 colIn = vec4(0.0);
  bool side = false;
  // Whether that side was met up through its base.
  bool upThrough = false;
  float sideClear = 1.0;
  // The sides the ray has gone through and out of, short of a cloud it
  // stays in: how much light gets through them, and where and in which
  // column it met the first (tides-01v.8.12). A ray that clips a cloud's
  // edge sees on past it.
  float veilClear = 1.0;
  float sVeil = -1.0;
  vec4 colVeil = vec4(0.0);
  bool upVeil = false;
  float depthHit = -1.0;
  // Where the sides and veils the ray goes through send their light back
  // from: each stretch's depth down its column, distance along the ray, and
  // its column's top and base, at its light's centroid, summed by the share
  // of the light it sends back (cloudShadeAdd()), and those shares
  // (tides-tvr.1). Where the ray goes up through a base, into a side or
  // through veils, the hit is shaded from the path the march took through
  // the cloud, in its own linear model of each step, rather than at the hit
  // from the column there: so that a veil, a side and a base seen side by
  // side shade alike where they meet, not as three kinds of hit, and a veil
  // that gives way to a cloud further on shades as itself until the cloud
  // past it shows.
  vec4 sideShade = vec4(0.0);
  float sideLight = 0.0;
  // Whether the camera is above the tops around it.
  bool fromAbove = false;
  // Whether the march started in a cloud, and that cloud's fog: how much
  // light gets through it, and how much it sends back (tides-01v.8.6); and
  // with reduced motion, how far it has eased in.
  bool fogged = false;
  float fogClear = 1.0;
  vec3 fogLight = vec3(0.0);
#ifdef FOG_EASE
  float fogEase = 1.0;
#endif
#endif

#if defined(CLOUD_FLAT) && defined(FLIP_SIDED)
  // The flat shell where the ray enters it, or from inside it, its underside
  // where the ray leaves.
  float sFlat = sIn >= sNear ? sIn : sOut;
  if (sFlat < sNear) CLOUD_MISS;
  vec3 p = eye + d * sFlat;
  float terrain = 0.0;
#elif defined(CLOUD_FLAT)
  vec3 p = vLocal + d * tIn;
  float terrain = 0.0;
#elif defined(FLIP_SIDED)
  // March from the eye (or where the ray comes within reach of the tallest
  // top this texture can have anywhere, if that is further) to where it
  // leaves that reach, or drops below the lowest base anywhere on its way to
  // the sea: a ray that skims over the sea comes back up under the deck.
  // Not from the near plane (tides-tvr.1): what the ray starts in, and what
  // it meets short of the near plane, would then hang on where the near
  // plane cuts it, which moves as the camera turns and climbs.
  // Rays that never come within reach, the sky from inside, end at once. A ray from
  // inside can cross half the layer, so each step reads its own ground for
  // the column's base, and its own mip for the footprint there. What lies
  // past the ground, the depth test hides: gl_FragDepth below. Mirrored by
  // cloud-layer.ts marchSpanFromEye.
  float outer = uSeaLevel + min(TERRAIN_TOP + CLOUD_CLEARANCE + CLOUD_UNITS_PER_KM * uCloudMaxKm,
    CLOUD_LAYER_TOP);
  float discOuter = be * be - (dot(eye, eye) - outer * outer);
  if (discOuter <= 0.0) discard;
  float sOuter = -be - sqrt(discOuter);
  // Where the march starts and its steps count from: the eye, or from
  // outside the reach, where the ray comes into it.
  float sOrigin = max(sOuter, 0.0);
  float sEnd = -be + sqrt(discOuter);
  float inner = uSeaLevel + CLOUD_CLEARANCE;
  float discInner = be * be - (dot(eye, eye) - inner * inner);
  float discSea = be * be - (dot(eye, eye) - uSeaLevel * uSeaLevel);
  float sSea = -be - sqrt(max(discSea, 0.0));
  if (discSea > 0.0 && sSea > 0.0) {
    // From below every base, the sea itself.
    sEnd = -be - sqrt(discInner) > sOrigin ? -be - sqrt(discInner) : sSea;
  }
  if (sEnd <= sOrigin) discard;
  // Steps of MARCH_STEP from the origin, the last cut short, so that from
  // ray to ray the steps slide rather than jump (as they would spread evenly
  // over each ray's span, a step's worth at the far end where the count
  // changes: bands, tides-01v.8.12). At least three over the span from the
  // origin, and longer only for rays skimming the sea from the shell's top,
  // by under 2%. Not steps from the near plane, whose reach along a ray
  // (near over the cosine of the ray's angle off the view axis) changes as
  // the camera turns, and as the near plane follows the ground, moving
  // every step over the clouds, which then swam (tides-16z). From the eye, a
  // ray's steps hold still as the camera turns about it, and all rays'
  // steps keep the same phase, so still no bands. Nor steps from the eye
  // that start at the near plane, as they did: the first, from the near
  // plane to the next, slid with it, and a first step from the eye to the
  // near plane, longer than a step when the near plane is far, read the
  // cloud between coarser the further the near plane (tides-tvr.1). From
  // the eye, though, every step slid over the clouds by the eye's motion
  // along its ray in flight, and what the march found between two steps,
  // tops, walls, veils and fog alike, rolled with a period of a step's
  // travel (tides-ndh). So the steps after the first fall a share of a
  // step short of whole steps from the eye (vMarchPhase), the same on every
  // ray, which the eye's motion along the view moves on (but in dense fog:
  // MARCH_PHASE_GLSL). In forward flight the steps along the view then hold
  // still over the clouds, and those off it nearly so: a ray at angle a off
  // the view still has its steps slide along it, by 1 - cos a of the
  // distance flown. Turning moves no step, nor does a sideways slip move the
  // phase. The first step stays at the eye, and may be short. The span is at
  // most MARCH_STEPS steps, and the march takes one more where the phase
  // pushes the last past it. Mirrored by cloud-layer.ts marchSteps.
  float span = sEnd - sOrigin;
  float ds = max(min(MARCH_STEP, span / 3.0), span / float(MARCH_STEPS));
  float phase = vMarchPhase;
  int steps = int(clamp(ceil(span / ds + phase - 1e-3), 1.0, float(MARCH_STEPS + 1)));
  // The march's steps at either end that lie above the ceiling would all
  // find clear air, so it leaves them out (tides-01v.8.10): from each end
  // the ray is read against the ceiling, then moved on to where it comes
  // under it, or by the ceiling's reach. The steps between are the same
  // steps, so they meet the same cloud.
  float sFirst = sOrigin;
  for (int k = 0; k < CEILING_READS; k++) {
    vec3 q = eye + d * sFirst;
    float ceiling = cloudCeilingRadius(q);
    if (length(q) <= ceiling) break;
    // Heading in, it goes under where it meets the sphere: taken no further
    // back than here, so a point judged above it by a rounding stops here.
    float discCeiling = be * be - (dot(eye, eye) - ceiling * ceiling);
    float sUnder = max(-be - sqrt(max(discCeiling, 0.0)), sFirst);
    if (discCeiling > 0.0 && sFirst < -be && sUnder - sFirst <= CEILING_REACH) {
      sFirst = sUnder;
      break;
    }
    sFirst += CEILING_REACH;
    if (sFirst >= sEnd) break;
  }
  float sLast = sEnd;
  for (int k = 0; k < CEILING_READS; k++) {
    if (sLast <= sFirst) break;
    vec3 q = eye + d * sLast;
    float ceiling = cloudCeilingRadius(q);
    if (length(q) <= ceiling) break;
    float discCeiling = be * be - (dot(eye, eye) - ceiling * ceiling);
    float sUnder = min(-be + sqrt(max(discCeiling, 0.0)), sLast);
    if (discCeiling > 0.0 && sLast > -be && sLast - sUnder <= CEILING_REACH) {
      sLast = sUnder;
      break;
    }
    sLast -= CEILING_REACH;
  }
  // A step clear of each, for the first to stand above the cloud.
  int iFirst = max(int(floor((sFirst - sOrigin) / ds + phase)) - 1, 0);
  int iLast = min(int(ceil((sLast - sOrigin) / ds + phase)) + 1, steps);
  // A column holds cloud from its base to its top, where it is at least
  // CLOUD_MIN_ALPHA. Over each step the march takes the ray's altitude and
  // its column (top, base and opacity) to change linearly, as the fog below
  // does, and finds the stretch where the ray is in cloud (cloudSpan()):
  // under the top, over the base, and where the cloud shows. Where that
  // starts, the ray meets the cloud: down through a top, up through a base,
  // or into a side, where the ray was already between the base and the top
  // of the column it steps into, or the cloud beside it came up to showing.
  // So a ray that clips a cloud between two steps still meets it, and from
  // ray to ray at the same place (tides-01v.8.12). That place is still
  // where the field taken linear over the step crosses. The steps hold
  // still as the camera turns (above), and in forward flight (vMarchPhase),
  // but flying sideways, or off the view, or with the eye in dense fog,
  // where the phase fades out, they slide along each ray by the eye's
  // motion, and the crossing moves within its step with them: tops and
  // walls rolled with a period of a step's travel. A top the march
  // stops at is pinned to the field after the march (MARCH_REFINE,
  // tides-ndh), from the step's two ends, which the march leaves as they
  // were when it stops: so nothing more is carried from step to step for it
  // (tides-16z's refinement, which stored every crossing's step through the
  // march, cost about half a millisecond a frame inside the deck however
  // few its reads). Sides and veils keep the step's crossing. Through
  // a faint column's top or base it carries on. From above the tops around
  // the camera, as from outside, a top is met however faint (the shading
  // drops it): carried on, grazing rays would find sides along every far
  // edge, a step apart. Mirrored by cloud-layer.ts marchCrossing. A march
  // that starts in a cloud crosses its fog first (fogExtinction()), to
  // where it leaves that cloud, and from there on as from anywhere else.
  // Past the fog's start, whose depth the depth test then sees
  // (gl_FragDepth below), nothing hides what lies beyond the ground, so the
  // march ends where it goes under the ground mesh itself (cloudGround()),
  // within the step: into a ridge, not only the ground the columns stand
  // on (tides-01v.8.13). The mesh's vertices lie a few steps apart.
  vec2 uvEye = vec2(0.0);
  float terrainEye = 0.0;
  if (iFirst <= iLast) {
    // Whether the camera is above the tops around it, for every step.
    uvEye = cloudUv(normalize(eye));
    terrainEye = cloudTerrain(uvEye);
    fromAbove = length(eye) - uSeaLevel > cloudColumn(uvEye, NEAR_TOPS_LOD, terrainEye).z;
  }
  float sPrev = sOrigin;
  float altPrev = 0.0;
  float gapPrev = 0.0;
  float underPrev = 0.0;
  float alphaPrev = 0.0;
  float sHit = -1.0;
  int iSide = 0;
  float sSkip = -1.0;
  // While in the fog: whether still, its extinction at the last step, and
  // the column it starts in. Its depth down its column and its opacity,
  // summed over the steps, each by the share of the light it sends back.
  bool fogging = false;
  float sigmaPrev = 0.0;
  vec4 colFog = vec4(0.0);
  vec4 colPrev = vec4(0.0);
  float densityPrev = 0.0;
  // Past the fog's start, how far above the ground mesh the last step was.
  float groundPrev = 0.0;
#ifdef FOG_EASE
  float sidePrev = 0.0;
#endif
  vec2 fogShade = vec2(0.0);
  if (iFirst == 0 && iFirst <= iLast) {
    // The march's first step, at the eye or where the ray comes within
    // reach: whether it starts in a cloud, read with the same mip on every
    // ray (cloudEyeLod()), as a step's own mip changes with the ray's
    // elevation (tides-tvr.1, tides-c08). Decided at the near plane, as it
    // was, an eye just under a base saw fog from the eye where the near
    // plane (near over the cosine of the ray's angle off the view axis)
    // reached into the cloud, and the base beyond it elsewhere: a line that
    // moved as the camera turned or climbed. The same with the eye in a
    // cloud and the near plane past its wall. Where the ray comes within
    // reach from outside it, no coarser than a pixel's width there, as a
    // step's own mip would be.
    vec3 q0 = eye + d * sOrigin;
    float r0 = length(q0);
    vec2 uv0 = sOrigin > 0.0 ? cloudUv(q0 / r0) : uvEye;
    // (log2(0) is undefined, so not read at the eye.)
    float lod0 = sOrigin > 0.0
      ? max(cloudEyeLod(), cloudLod(spread * sOrigin / max(abs(dot(d, q0 / r0)), 0.05)))
      : cloudEyeLod();
    vec4 col0 = cloudColumn(uv0, lod0, sOrigin > 0.0 ? cloudTerrain(uv0) : terrainEye);
    float alt0 = r0 - uSeaLevel;
    sPrev = sOrigin;
    colPrev = col0;
    altPrev = alt0;
    gapPrev = alt0 - col0.z;
    underPrev = col0.y - alt0;
    alphaPrev = col0.x;
    if (gapPrev <= 0.0 && underPrev <= 0.0 && col0.x >= CLOUD_MIN_ALPHA) {
      // The camera's cloud: its fog runs from the eye.
      fogged = fogging = true;
      colFog = col0;
      densityPrev = cloudFogDensity(col0);
      sigmaPrev = densityPrev * cloudFogEdge(col0, alt0);
#ifdef FOG_EASE
      fogEase = vFogEase > 0.9999 ? 1.0 : vFogEase;
      sidePrev = cloudSideDensity(col0);
      sigmaPrev = cloudFogEased(sigmaPrev, sidePrev, cloudFogEdge(col0, alt0), fogEase);
#endif
      groundPrev = alt0 - cloudGround(uv0);
    }
  }
  for (int i = max(iFirst, 1); i <= MARCH_STEPS + 1; i++) {
    if (i > iLast) break;
    float s = min(sOrigin + ds * (float(i) - phase), sEnd);
    if (s <= sSkip) continue;
    float stepLen = s - sPrev;
    vec3 q = eye + d * s;
    float r = length(q);
    vec2 uvq = cloudUv(q / r);
    float mu = dot(d, q / r);
    vec4 colq = cloudMarchColumn(uvq, r, mu, cloudTerrain(uvq), s, ds, spread, fromAbove);
    // Above the top, and below the base.
    float alt = r - uSeaLevel;
    float gap = alt - colq.z;
    float under = colq.y - alt;
    bool inCloud = gap <= 0.0 && under <= 0.0 && colq.x >= CLOUD_MIN_ALPHA;
    // How much of this step lies above the ground mesh, past a fog's start,
    // as the ray and the ground change linearly over it: past that the
    // march ends, with what the step met short of it.
    float clip = 1.0;
    if (fogged) {
      float aboveGround = alt - cloudGround(uvq);
      // From under the mesh (its faces cull from inside), once out of it.
      if (aboveGround < 0.0 && groundPrev > 0.0) clip = groundPrev / (groundPrev - aboveGround);
      groundPrev = aboveGround;
    }
    if (side) {
      // A column's alpha is its opacity top to bottom; a side is as opaque
      // as the cloud the ray goes on through, a few steps at most, to where
      // it leaves the column or the cloud thins out of showing.
      float through = min(min(cloudSpan(gapPrev, gap).y, cloudSpan(underPrev, under).y),
        cloudSpan(CLOUD_MIN_ALPHA - alphaPrev, CLOUD_MIN_ALPHA - colq.x).y);
      float wIn = max(min(through, clip), 0.0);
      float stretchClear = cloudPathClear(colq.x, colq.z - colq.y, stepLen * wIn);
      cloudShadeAdd(sideShade, sideLight, veilClear * sideClear * (1.0 - stretchClear),
        colPrev, colq, altPrev, alt, sPrev, s, wIn * cloudLightCentroid(stretchClear));
      sideClear *= stretchClear;
      if (clip < 1.0 || sideClear < 0.02) break;
      if (!inCloud) CLOUD_VEIL
      else if (i >= iSide + SIDE_STEPS) {
        float rest = mu > 0.0 ? -gap / mu : mu < 0.0 ? under / mu : SIDE_REST;
        // Through the column as it is here: down it from here to where the
        // ray leaves it, or SIDE_REST on.
        float thick = colq.z - colq.y;
        float len = min(rest, SIDE_REST);
        stretchClear = cloudPathClear(colq.x, thick, len);
        cloudShadeAdd(sideShade, sideLight, veilClear * sideClear * (1.0 - stretchClear),
          colq, colq, alt, alt + mu * len, s, s + len, cloudLightCentroid(stretchClear));
        sideClear *= stretchClear;
        if (rest >= SIDE_REST || sideClear < 0.02) break;
        CLOUD_VEIL
        // On from where it leaves the column, out of the cloud, unless the
        // ground rises across the way first.
        sSkip = s + rest;
        s = sSkip;
        alt += mu * rest;
        if (fogged) {
          float aboveGround = alt - cloudGround(cloudUv(normalize(eye + d * s)));
          if (aboveGround < 0.0 && groundPrev > 0.0) break;
          groundPrev = aboveGround;
        }
        gap = mu > 0.0 ? 1e-6 : alt - colq.z;
        under = mu < 0.0 ? 1e-6 : colq.y - alt;
      }
    } else if (i == iFirst) {
      // Past the steps above the ceiling: nothing before this one to cross
      // from.
      if (inCloud) {
        // The march starts in a cloud. Its fog runs from the eye (or where
        // the ray comes within reach), as thick up to here as here.
        fogged = fogging = true;
        colFog = colq;
        densityPrev = cloudFogDensity(colq);
        sigmaPrev = densityPrev * cloudFogEdge(colq, alt);
#ifdef FOG_EASE
        fogEase = vFogEase > 0.9999 ? 1.0 : vFogEase;
        sidePrev = cloudSideDensity(colq);
        sigmaPrev = cloudFogEased(sigmaPrev, sidePrev, cloudFogEdge(colq, alt), fogEase);
#endif
        groundPrev = alt - cloudGround(uvq);
        fogClear = exp(-sigmaPrev * (s - sOrigin));
        fogShade = (1.0 - fogClear)
          * vec2(clamp(-gap / max(colq.z - colq.y, 1e-6), 0.0, 1.0), colq.x);
      }
    } else {
      if (fogging) {
        // The fog over this step, by the trapezoid rule on its own steps.
        float density = cloudFogDensity(colq);
#ifdef FOG_EASE
        float sideDensity = fogEase < 1.0 ? cloudSideDensity(colq) : 0.0;
#endif
        for (int k = 1; k <= FOG_SUBSTEPS; k++) {
          float w = clip * float(k) / float(FOG_SUBSTEPS);
          vec4 colk = mix(colPrev, colq, w);
          float altk = mix(altPrev, alt, w);
          float sigma = mix(densityPrev, density, w) * cloudFogEdge(colk, altk);
#ifdef FOG_EASE
          sigma = cloudFogEased(sigma, mix(sidePrev, sideDensity, w), cloudFogEdge(colk, altk), fogEase);
#endif
          float clear = exp(-0.5 * (sigmaPrev + sigma) * clip * stepLen / float(FOG_SUBSTEPS));
          fogShade += fogClear * (1.0 - clear)
            * vec2(clamp((colk.z - altk) / max(colk.z - colk.y, 1e-6), 0.0, 1.0), colk.x);
          fogClear *= clear;
          sigmaPrev = sigma;
        }
        densityPrev = density;
#ifdef FOG_EASE
        sidePrev = sideDensity;
#endif
        if (fogClear < FOG_OPAQUE) break;
        fogging = inCloud;
      }
      vec2 underTop = cloudSpan(gapPrev, gap);
      vec2 overBase = cloudSpan(underPrev, under);
      vec2 shows = fromAbove && gapPrev > 0.0
        ? vec2(0.0, 1.0)
        : cloudSpan(CLOUD_MIN_ALPHA - alphaPrev, CLOUD_MIN_ALPHA - colq.x);
      float from = max(max(underTop.x, overBase.x), shows.x);
      float until = min(min(min(underTop.y, overBase.y), shows.y), clip);
      // From outside the cloud at the last step.
      if (from > 0.0 && from <= until) {
        sHit = sPrev + stepLen * from;
        colIn = colq;
        // Down through a top, unless beside the column, its top having
        // passed the ray's height between the steps. Anywhere else (up
        // through a base, or into the cloud as it came up to showing beside
        // the ray) the ray goes on through the cloud as through a side: up
        // a column steeply, as opaque as the column, and at a slant, as the
        // cloud it crosses, as where it meets a side beside the base.
        side = from != underTop.x || (!fromAbove && altPrev <= colq.z && altPrev >= colq.y);
        upThrough = from == overBase.x;
        if (!side) {
          depthHit = 0.0;
          // For the refinement after the march (tides-ndh): the step's end,
          // the ray's height over the top there, and how far through the
          // cloud the step has the ray, in the march's own altPrev, underPrev
          // and alphaPrev, which nothing reads after it. Its start is the
          // march's sPrev, gapPrev and colPrev, which the stop leaves as they
          // were. A value of its own, carried through the march to be set
          // only here, held registers all through it (about 0.05 ms a frame
          // over the tops).
          altPrev = s;
          underPrev = gap;
          alphaPrev = sPrev + stepLen * until;
          break;
        }
        iSide = i;
        sideClear = cloudPathClear(colq.x, colq.z - colq.y, stepLen * (until - from));
        cloudShadeAdd(sideShade, sideLight, veilClear * (1.0 - sideClear),
          colPrev, colq, altPrev, alt, sPrev, s, from + (until - from) * cloudLightCentroid(sideClear));
        // Through it within the step.
        if (until < 1.0) {
          if (sideClear < 0.02) break;
          CLOUD_VEIL
        }
      }
    }
    if (clip < 1.0) break;
    sPrev = s;
    colPrev = colq;
    altPrev = alt;
    gapPrev = gap;
    underPrev = under;
    alphaPrev = colq.x;
  }
  if (depthHit == 0.0) {
    // Down through a top: where within its step the ray meets the top
    // itself, rather than the top taken linear over the step, which slides
    // with the steps (tides-ndh). Each read, at the step's own mip there,
    // halves the stretch the ray comes down to the top over, as its height
    // over the top changes sign; on the last the crossing is solved
    // linearly. The ground under the reads is taken linear between the
    // step's ends (the elevation map's texels are several steps across),
    // and the step's end, in the cloud, needs no read. No further than the
    // step has the ray in cloud. The march's own steps stay as they were:
    // its register peak is within them, and this runs only on rays that
    // stop at a top. Mirrored by cloud-layer.ts refineTopCrossing.
    float lo = sPrev;
    float gLo = gapPrev;
    float hi = altPrev;
    float gHi = underPrev;
    float len = max(hi - sPrev, 1e-6);
    for (int k = 0; k < MARCH_REFINE; k++) {
      float sm = 0.5 * (lo + hi);
      vec3 qm = eye + d * sm;
      float rm = length(qm);
      float ground = mix(colPrev.y, colIn.y, (sm - sPrev) / len) - CLOUD_CLEARANCE;
      float gm = rm - uSeaLevel - cloudMarchColumn(cloudUv(qm / rm), rm, dot(d, qm / rm), ground,
        sm, ds, spread, fromAbove).z;
      if (gm <= 0.0) {
        hi = sm;
        gHi = gm;
      } else {
        lo = sm;
        gLo = gm;
      }
    }
    // Above the top at lo, at or under it at hi.
    sHit = min(lo + (hi - lo) * gLo / (gLo - gHi), alphaPrev);
  }
  if (fogged) {
    // The fog's light: as cloud at the eye's height, lit from straight
    // above, as far down its column and as thick as the fog it crossed.
    vec3 upEye = normalize(eye);
    vec2 shade = fogShade / max(1.0 - fogClear, 1e-6);
    fogLight = cloudRadiance(upEye, upEye, d, shade.y, shade.x,
      cloudKm(length(eye) - uSeaLevel, colFog.y), 0.0, vEclipseEye);
  }
  if (sHit < 0.0 && sVeil >= 0.0) {
    // Nothing past the veils: the first is the side the ray meets, as clear
    // as they all are.
    sHit = sVeil;
    colIn = colVeil;
    side = true;
    upThrough = upVeil;
    sideClear = veilClear;
    veilClear = 1.0;
  }
  if (sHit < 0.0) CLOUD_MISS;
  vec3 p = eye + d * sHit;
  float terrain = cloudTerrain(cloudUv(normalize(p)));
#else
  // March down to the first cloud top. The ground under the entry stands
  // in for the ground all along the march: it bounds where the march starts
  // (the tallest top this texture can have over it) and ends (the lowest
  // base), leaving one texture read a step.
  vec3 entry = vLocal + d * tIn;
  float terrain = cloudTerrain(cloudUv(normalize(entry)));
  float top = min(terrain + TERRAIN_SLACK + CLOUD_CLEARANCE + CLOUD_UNITS_PER_KM * uCloudMaxKm,
    CLOUD_LAYER_TOP);
  float outer = uSeaLevel + top;
  float discTop = b * b - (dot(vLocal, vLocal) - outer * outer);
  if (discTop <= 0.0) discard;
  tIn = -b - sqrt(discTop);
  float tEnd = -b + sqrt(discTop);
  float inner = uSeaLevel + max(terrain - TERRAIN_SLACK, 0.0) + CLOUD_CLEARANCE;
  float discInner = b * b - (dot(vLocal, vLocal) - inner * inner);
  if (discInner > 0.0) tEnd = -b - sqrt(discInner);
  int steps = int(clamp(ceil((tEnd - tIn) / MARCH_STEP), 3.0, float(MARCH_STEPS)));
  float dt = (tEnd - tIn) / float(steps);
  float tPrev = tIn;
  float gapPrev = 0.0;
  float tHit = -1.0;
  for (int i = 0; i <= MARCH_STEPS; i++) {
    if (i > steps) break;
    float t = tIn + dt * float(i);
    vec3 q = vLocal + d * t;
    float r = length(q);
    float mu = dot(d, q / r);
    float lodq = max(lod, cloudMarchLod(dt * sqrt(max(1.0 - mu * mu, 0.0))));
    float gap = r - uSeaLevel - cloudColumn(cloudUv(q / r), lodq, terrain).z;
    if (gap <= 0.0) {
      // Secant refinement between the last step above and this one below.
      tHit = i == 0 ? t : mix(tPrev, t, gapPrev / max(gapPrev - gap, 1e-6));
      break;
    }
    tPrev = t;
    gapPrev = gap;
  }
  if (tHit < 0.0) discard;
  vec3 p = vLocal + d * tHit;
  terrain = cloudTerrain(cloudUv(normalize(p)));
#endif
#ifdef FLIP_SIDED
  // A pixel's width at the hit, stretched by the slant (but for a side), as
  // the shell's own footprint gives it from outside.
  float eyeDist = length(p - eye);
  footprint = spread * eyeDist / (side ? 1.0 : max(abs(dot(d, normalize(p))), 0.05));
  lod = cloudLod(footprint);
#endif

  float r = length(p);
  vec3 up = p / r;
  vec2 uv = cloudUv(up);
  vec4 col = cloudColumn(uv, lod, terrain);
#ifdef FLIP_SIDED
  // A side, or a flank where the crossing fell short of the column over the
  // clear ground before it, is the face of the column a little way in (or
  // failing that the step's, which varies by step): the hit's own column is
  // clear or thinning, its top below the hit. A side's opacity is the
  // cloud's behind it (the march's); a flank's depth down its column is
  // then found below.
  if (side && upThrough && col.x >= CLOUD_MIN_ALPHA) {
    // Met up through its base, the hit's own column.
    col.x = max(1.0 - sideClear, CLOUD_MIN_ALPHA);
    depthHit = -1.0;
  } else if (side || (!fromAbove && colIn.x >= CLOUD_MIN_ALPHA && col.x < CLOUD_MIN_ALPHA)) {
    vec2 uvIn = cloudUv(normalize(p + d * WALL_DEPTH));
    vec4 colWall = cloudColumn(uvIn, lod, cloudTerrain(uvIn));
    if (colWall.x < CLOUD_MIN_ALPHA) colWall = colIn;
    col = vec4(side ? max(1.0 - sideClear, CLOUD_MIN_ALPHA) : colWall.x, colWall.yzw);
    depthHit = -1.0;
  }
#endif
  // A hit that doesn't show ends the ray, unless it is seen through veils,
  // which then show alone.
  if (col.x < CLOUD_MIN_ALPHA) {
    if (!CLOUD_VEILED) CLOUD_MISS;
    col.x = 0.0;
  }
  float texel = 2.0 * CLOUD_PI * uSeaLevel / float(textureSize(uCloudMap, 0).x);
  // Seen edge-on, a cloud is a longer path.
  float slant = 1.0 / max(abs(dot(d, up)), 0.3);
#ifdef FLIP_SIDED
  // A side's opacity already holds its path.
  if (side) slant = 1.0;
  // Thinning into the ground.
  float groundFade = smoothstep(0.0, GROUND_FADE, r - uSeaLevel - cloudGround(uv));
#else
  float groundFade = 1.0;
#endif
  // How far down its column the hit lies (columnDepth()): 0 on a top, 1 on
  // a base seen from below, between on a side; the flat shell is all top or
  // all base, and from outside only tops show. And where it is shaded from,
  // over the ground there: the hit, its column's top and base.
  vec3 pShade = p;
  vec4 colShade = col;
  float terrainShade = terrain;
#if defined(CLOUD_FLAT) && defined(FLIP_SIDED)
  float depth = length(eye) < shell ? 1.0 : 0.0;
#elif defined(FLIP_SIDED)
  float depth = depthHit >= 0.0
    ? depthHit
    : clamp((col.z - (r - uSeaLevel)) / max(col.z - col.y, 1e-6), 0.0, 1.0);
  // Through a side, up through a base or through veils, shaded from where
  // the light comes back from along the march's path through them
  // (sideShade): its depth, its place on the ray and its column there, with
  // a top's or a flank's own by what of it shows past the veils (before its
  // detail) (tides-tvr.1), however faint they are. Shaded from the hit
  // and the column there, as they were, a veil met alone and the same veil
  // with a side behind it, or a side near its base and the base beside it,
  // took depths a long way apart, and a veil that gave way to a cloud
  // further on took that cloud's height, slope and shadow: grey slabs
  // against white with straight edges, as the base lies at much the same
  // height everywhere and the classes change at fixed elevations of the ray.
  float hitLight = side ? 0.0 : veilClear * (1.0 - pow(1.0 - min(col.x, 0.995), slant)) * groundFade;
  float shadeW = sideLight + hitLight;
  // The sums are each weight times a bounded value, so no faint weight
  // divides into more than it holds.
  if (shadeW > 0.0) {
    vec4 place = (sideShade + hitLight * vec4(depth, eyeDist, col.z, col.y)) / shadeW;
    depth = place.x;
    pShade = eye + d * place.y;
    colShade.zy = place.zw;
    terrainShade = place.w - CLOUD_CLEARANCE;
  }
#else
  float depth = 0.0;
#endif
  float rShade = length(pShade);
  vec3 upShade = pShade / rShade;
  vec2 uvShade = cloudUv(upShade);
  // A pixel's width where the ray meets the top, stretched by the slant, at
  // the hit for its detail, and where it is shaded for its slope. vRayDir is
  // the eye's offset: the Earth group is unscaled.
#ifdef FLIP_SIDED
  float topFootprint = footprint;
  float footShade = spread * length(pShade - eye) / (side ? 1.0 : max(abs(dot(d, upShade)), 0.05));
  float lodShade = cloudLod(footShade);
#else
  float topFootprint = isOrthographic
    ? footprint
    : spread * (length(vRayDir) + length(p - vLocal)) / max(abs(dot(d, up)), 0.05);
  float footShade = footprint;
  float lodShade = lod;
#endif
  // The tops' slope, by forward differences a pixel or so apart, read
  // ahead of the detail, which shares the reads where it can. A mip down,
  // and the tilt capped (below): measured heights can jump kilometres
  // between neighbouring texels, which would stand tops on edge.
  float h = max(footShade, 3.0 * texel);
  float lodN = lodShade + 1.0;
  vec2 stepE = vec2(h / (2.0 * CLOUD_PI * rShade * max(length(upShade.xz), 0.05)), 0.0);
  vec2 stepN = vec2(0.0, h / (CLOUD_PI * rShade));
  float topC = cloudColumn(uvShade, lodN, terrainShade).z;
  vec4 colE = cloudColumn(uvShade + stepE, lodN, terrainShade);
  vec4 colN = cloudColumn(uvShade + stepN, lodN, terrainShade);
#ifdef CLOUD_TYPED
  // The tops' rise over the reads, tilted by the look's relief once it is
  // read (below).
  vec2 dz = vec2(colE.z - topC, colN.z - topC);
#else
  vec2 slope = RELIEF * vec2(colE.z - topC, colN.z - topC) / h;
#endif

  // How near the hit is to the cloud's edge, for the detail (tides-tvr.3;
  // detailEdge()): how many steps of the reads on it stops showing, by the
  // map's own fall in opacity over them, by central differences
  // (detailFall()), so that a rim facing any way reads alike: the slope's
  // reads east and north, and two more west and south. Worked out only
  // where the detail's coarsest wave is more than DETAIL_GRAIN_PX pixels on
  // screen, so further out every octave erodes in full as ever and nothing
  // more is read; and fixed to the map, so it neither swims nor sparkles as
  // the camera moves.
  float edge = 1.0;
  bool edgeNear = ${f(DETAIL_BASE_TEXELS)} * texel > DETAIL_GRAIN_PX * topFootprint * uPixelScale;
#ifdef FLIP_SIDED
  // A side is all edge.
  edgeNear = edgeNear && !side;
#endif
  if (edgeNear) {
    // At the hit, as the detail is: the slope's reads where it is shaded
    // there too.
    vec2 hitE = stepE;
    vec2 hitN = stepN;
    float lodHit = lodN;
    vec2 fallEN = vec2(colE.x, colN.x);
#ifdef FLIP_SIDED
    // Shaded from along the path through sides and veils, elsewhere.
    if (sideLight > 0.0) {
      float hHit = max(footprint, 3.0 * texel);
      hitE = vec2(hHit / (2.0 * CLOUD_PI * r * max(length(up.xz), 0.05)), 0.0);
      hitN = vec2(0.0, hHit / (CLOUD_PI * r));
      lodHit = lod + 1.0;
      fallEN = vec2(cloudColumn(uv + hitE, lodHit, terrain).x, cloudColumn(uv + hitN, lodHit, terrain).x);
    }
#endif
    float fall = 0.5 * length(fallEN
      - vec2(cloudColumn(uv - hitE, lodHit, terrain).x, cloudColumn(uv - hitN, lodHit, terrain).x));
    edge = 1.0 - smoothstep(DETAIL_EDGE_NEAR, DETAIL_EDGE_FAR,
      (col.x - CLOUD_MIN_ALPHA) / max(fall, 1e-4));
  }

  // The detail at the hit itself: where it is shaded can sweep far along the
  // ray from one pixel to the next where a cloud past a veil starts to show,
  // and noise read there would streak along every such edge.
#ifdef CLOUD_TYPED
  // How this kind of cloud looks (tides-tvr.4.2): read once the march has
  // stopped, the hit shows and its edge is known, at the hit's own place on
  // the map; typed frames only (CLOUD_TYPED), so untyped clouds are drawn by
  // tides-tvr.3's program itself.
  vec4 lookD;
  vec4 lookL;
  cloudLook(vec2(fract(uv.x - uCloudShift), clamp(uv.y, 0.0, 1.0)), lod, lookD, lookL);
  vec2 slope = lookD.x * dz / h;
  // Cirrus's detail is drawn out east-west: the same noise with its scale
  // across the pole axis stretched, mixed in by how much of the cloud is
  // cirrus, toward the poles less. A stretch varying over the map would
  // swirl the noise's domain, so the two are read and mixed, only where
  // there is some of each: a pass of the one call each, the round noise's
  // the same as tides-tvr.3's (folded into one loop with the stretched
  // one, it rounded a hair off it). Only the hit's detail: the march never
  // sees it.
  float wStretch = smoothstep(STRETCH_FROM, STRETCH_TO, lookL.x)
    * (1.0 - smoothstep(STRETCH_POLE_FROM, STRETCH_POLE_TO, abs(up.y)));
#ifdef CLOUD_FLAT
  // The low path reads one or the other.
  wStretch = step(0.5, wStretch);
#endif
  vec3 pDetail = cloudFrame(p, uCloudShift);
  vec4 detail = vec4(0.0);
  for (int i = 0; i < 2; i++) {
    float w = i == 0 ? 1.0 - wStretch : wStretch;
    if (w <= 0.0) continue;
    vec3 scale = i == 0 ? vec3(1.0) : CLOUD_STRETCH;
    vec4 pass = cloudDetail(pDetail * scale, topFootprint, texel, edge, lookD.y);
    // Its gradient, back from the stretched noise's to p's.
    pass.yzw *= scale;
    detail += w * pass;
  }
  // The erosion as tides-tvr.3 has it, then the look's past it, as a share
  // of the erosion made: nothing at confidence 0. The look's own in the
  // product would round such a hit's opacity a hair off tides-tvr.3's (a
  // pixel or two a frame, checked headless). A hole the erosion opened stays
  // one, whatever the look.
  float alpha = clamp(col.x + DETAIL_EDGE * detail.x * 4.0 * col.x * (1.0 - col.x), 0.0, 1.0);
  alpha = (alpha > 0.0 ? clamp(alpha + (lookD.z - DETAIL_EDGE) / DETAIL_EDGE * (alpha - col.x), 0.0, 1.0) : 0.0)
    * lookL.w;
#else
  vec4 detail = cloudDetail(cloudFrame(p, uCloudShift), topFootprint, texel, edge);
  float alpha = clamp(col.x + DETAIL_EDGE * detail.x * 4.0 * col.x * (1.0 - col.x), 0.0, 1.0);
#endif
  if (alpha < CLOUD_MIN_ALPHA) {
    if (!CLOUD_VEILED) CLOUD_MISS;
    alpha = 0.0;
  }
  // How much of what lies behind it the hit hides, short of the veils.
  float hitShow = (1.0 - pow(1.0 - min(alpha, 0.995), slant)) * groundFade;

  // The detail's own slope, along the top.
  vec3 east = normalize(vec3(upShade.z, 0.0, -upShade.x) + vec3(1e-5, 0.0, 0.0));
  vec3 north = cross(upShade, east);
#ifdef CLOUD_TYPED
  vec3 grain = cloudFrame(detail.yzw, -uCloudShift) * lookD.w * ${f(DETAIL_BASE_TEXELS)} * texel;
#else
  vec3 grain = cloudFrame(detail.yzw, -uCloudShift) * DETAIL_RELIEF * ${f(DETAIL_BASE_TEXELS)} * texel;
#endif
  vec2 grainSlope = vec2(dot(grain, east), dot(grain, north));
  slope += grainSlope * min(1.0, DETAIL_MAX_SLOPE / max(length(grainSlope), 1e-6));
  slope *= min(1.0, MAX_SLOPE / max(length(slope), 1e-6));
  vec3 n = normalize(upShade - slope.x * east - slope.y * north);

  // Taller cloud toward the Sun shades this top.
  vec3 s = uSunDir;
  vec3 lit = upShade * (uSeaLevel + colShade.z);
  float occ = 0.0;
  for (int j = 1; j <= SHADOW_STEPS; j++) {
    float ts = SHADOW_STEP * float(j * j);
    vec3 q = lit + s * ts;
    float rq = length(q);
    float aq = rq - uSeaLevel;
    if (aq > CLOUD_LAYER_TOP) break;
    vec4 cq = cloudColumn(cloudUv(q / rq), max(lodShade + 1.0, 2.0), terrainShade);
    occ = max(occ, cloudShade(cq.x) * smoothstep(0.0, SHADOW_SOFT, cq.z - aq));
  }
#ifdef CLOUD_TYPED
  // Thin cirrus hardly shades itself, nor darkens down its column.
  occ *= lookL.y;
  depth *= lookL.z;
#endif

  vec3 radiance = cloudRadiance(upShade, n, d, alpha, depth, cloudKm(colShade.z, colShade.y), occ,
    CLOUD_ECLIPSE_HIT);

  float opacity = hitShow * uOpacity;
#ifdef FLIP_SIDED
  // Seen through the veils in front of it.
  opacity = 1.0 - (1.0 - (1.0 - veilClear) * uOpacity) * (1.0 - opacity);
  #ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  #error "cloud layer: gl_FragDepth assumes a standard or reversed depth buffer"
  #endif
  // The hit's depth, so the displaced ground hides clouds behind it: the
  // back face lies past the globe. View depth scales with distance along
  // the ray. Fog starts at the eye, in front of everything; past it the
  // march ended at the ground. A hit short of the near plane (the march
  // runs from the eye, tides-tvr.1) is drawn at it: it stays where the ray
  // met it, for its shading and detail, which would otherwise slide with
  // the near plane as the camera turns.
  float z = vViewDepth * max(eyeDist, sNear) / length(vRayDir);
  // The fog over the hit (premultiplied, then back), and the haze in front
  // of where the hit is shaded from (pShade) as far as the fog lets it
  // through.
  float fogA = 1.0 - fogClear;
  float a = fogA + fogClear * opacity;
  cloudOut(vec4((fogA * fogLight + fogClear * opacity * radiance) / max(a, 1e-6), a),
    fogged ? FRAG_DEPTH_NEAREST : viewDepthToFragDepth(projectionMatrix, z),
    cloudHazeFront(eye, d, length(pShade - eye), shell), fogClear * opacity);
#else
  gl_FragColor = vec4(radiance, opacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
#endif
}
`

const GROUND_VERTEX_HEAD = /* glsl */ `
varying vec3 vCloudGround;
`

const GROUND_VERTEX_BODY = /* glsl */ `
vCloudGround = position;
`

const GROUND_FRAGMENT_HEAD = /* glsl */ `
${FIELD}
varying vec3 vCloudGround;

#define GROUND_SHADOW 0.5

// A sunbeam to this ground point, met at a few heights in the cloud layer
// (shadowCaster()): cloud spanning that height there shades the point.
float cloudGroundShadow(vec3 dir) {
  float mu = dot(dir, uSunDir);
  if (mu <= 0.0) return 1.0;
  vec2 uv = cloudUv(dir);
  float ground = cloudTerrain(uv);
  float r0 = uSeaLevel + ground;
  // Blurred: a soft penumbra, and no speckle from small puffs.
  float lod = max(cloudLod(length(fwidth(vCloudGround))) + 1.0, 2.5);
  float occ = 0.0;
#ifdef CLOUD_FLAT
  {
    float alt = CLOUD_FLAT_ALTITUDE;
#else
  for (int j = 0; j < 3; j++) {
    float alt = ground + CLOUD_CLEARANCE + CLOUD_UNITS_PER_KM * (j == 0 ? 1.5 : j == 1 ? 4.0 : 8.0);
#endif
    float rt = uSeaLevel + alt;
    float t = -r0 * mu + sqrt(max(0.0, r0 * r0 * (mu * mu - 1.0) + rt * rt));
    vec4 col = cloudColumn(cloudUv(normalize(dir * r0 + uSunDir * t)), lod, ground);
#ifdef CLOUD_FLAT
    occ = cloudShade(col.x);
#else
    occ = max(occ, cloudShade(col.x) * smoothstep(-0.008, 0.008, col.z - alt));
#endif
  }
  return 1.0 - GROUND_SHADOW * occ;
}
`

const GROUND_FRAGMENT_LIGHT = /* glsl */ `
{
  float cloudLit = cloudGroundShadow(normalize(vCloudGround));
  reflectedLight.directDiffuse *= cloudLit;
  reflectedLight.directSpecular *= cloudLit;
}
`

function inject(source: string, chunk: string, code: string): string {
  const include = `#include <${chunk}>`
  if (!source.includes(include)) {
    throw new Error(`cloud layer: shader has no ${include}`)
  }
  return source.replace(include, `${include}\n${code}`)
}

export interface CloudLayer {
  /** For the cloud shell's mesh. */
  material: THREE.ShaderMaterial
  /** Spread onto the ground's Phong material (with the eclipse patch, via
   * composePatches). */
  groundPatch: MaterialPatch
  /** Shared by both; set each frame. */
  uniforms: {
    uCloudMap: THREE.IUniform<THREE.Texture | null>
    uTerrainMap: THREE.IUniform<THREE.Texture | null>
    uCloudShift: THREE.IUniform<number>
    uCloudMeasured: THREE.IUniform<number>
    /** The tallest top the texture can give (km). */
    uCloudMaxKm: THREE.IUniform<number>
    /** 1 where the map shown has a cloud-type grid (tides-tvr.4.2), else 0;
     * this and the grid are the shell's alone, which the ground's shadow
     * never reads. */
    uCloudTyped: THREE.IUniform<number>
    /** Its blended type grid (./cloudBlend.ts), or the neutral one. */
    uCloudType: THREE.IUniform<THREE.Texture>
    uSunDir: THREE.IUniform<THREE.Vector3>
    uSeaLevel: THREE.IUniform<number>
    /** The live terrain scale (../terrain-scale.ts), when `live`. */
    uTerrainScale: THREE.IUniform<number>
  }
  /**
   * Shows `map`: whether it has measured heights (only geostationary imagery
   * carries cloud-top heights, R, and their confidence, B; the static and
   * daily textures are grey), and its blended cloud-type grid (tides-tvr.4.2),
   * null where it has none: untyped, the clouds are drawn as before types.
   */
  setMap(map: THREE.Texture, measured: boolean, types: THREE.Texture | null): void
  /** Altitude of the shell mesh above sea level. */
  shellAltitude: number
  /** Readies the shell's mesh for drawing to `camera`: before three sorts
   * what it draws (a scene's onBeforeRender), as it sets the draw order. */
  faceCamera(mesh: THREE.Object3D, camera: THREE.Camera): void
  dispose(): void
}

const eye = new THREE.Vector3()
const viewport = new THREE.Vector4()
const forward = new THREE.Vector3()
const toLocal = new THREE.Matrix4()

// The cloud ceiling's texture (cloudCeiling(), built by
// scripts/build-cloud-ceiling.mjs); until it has loaded, a
// single texel of white, under which the march skips nothing.
function ceilingTexture(
  grey: Uint8Array<ArrayBuffer> = new Uint8Array([255]),
  [width, height]: readonly [number, number] = [1, 1]
): THREE.DataTexture {
  const texture = new THREE.DataTexture(grey, width, height, THREE.RedFormat)
  texture.needsUpdate = true
  return texture
}

async function fetchCeiling(): Promise<THREE.DataTexture> {
  const response = await fetch(ceilingUrl)
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  const grey = new Uint8Array(await response.arrayBuffer())
  const [width, height] = TERRAIN_MAP_SIZE
  if (grey.length !== width * height) {
    throw new Error(`cloud ceiling is ${grey.length} bytes, not ${width}×${height}`)
  }
  return ceilingTexture(grey, TERRAIN_MAP_SIZE)
}

export function createCloudLayer(eclipse: EclipseShadow, flat: boolean, live: boolean = TERRAIN_BLEND): CloudLayer {
  const uniforms: CloudLayer['uniforms'] = {
    uCloudMap: { value: null },
    uTerrainMap: { value: null },
    uCloudShift: { value: 0 },
    uCloudMeasured: { value: 0 },
    uCloudMaxKm: { value: MAX_CLOUD_TOP_KM },
    uCloudTyped: { value: 0 },
    uCloudType: { value: neutralTypeTexture() },
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uSeaLevel: { value: 1 },
    uTerrainScale: terrainScaleUniform,
  }
  const defines: Record<string, string> = flat ? { CLOUD_FLAT: '' } : {}
  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...eclipse.uniforms,
      ...uniforms,
      uOpacity: { value: 0.92 },
      uSunGain: { value: (SUNLIGHT_INTENSITY / Math.PI) * CLOUD_EXPOSURE },
      uAmbient: { value: CLOUD_AMBIENT },
      uFogPast: { value: Array.from({ length: FOG_EASE_SAMPLES }, () => new THREE.Vector3()) },
      uMarchPhase: { value: 0 },
      uCloudCeiling: { value: ceilingTexture() },
      uPixelScale: { value: 1 },
    },
    defines,
    vertexShader: liveTerrain(VERTEX, live),
    fragmentShader: liveTerrain(FRAGMENT, live),
    transparent: true,
    depthWrite: false,
    // The shader premultiplies, so that within reach the haze it adds over a
    // cloud (cloudHazeFront) isn't clipped before the blend.
    premultipliedAlpha: true,
  })
  // The detail's sizes on screen (tides-tvr.3), from the view drawn: the
  // canvas's, or a render target's (its viewport, in its own pixels).
  material.onBeforeRender = (renderer) => {
    material.uniforms.uPixelScale.value = detailPixelScale(renderer.getCurrentViewport(viewport).w)
  }
  // The eye's recent path, while the fog eases in (FOG_EASE_SECONDS).
  const track: EyeSample[] = []
  // Where the eye was among the clouds when the march's phase last moved on.
  let marchEye: Vec3 | null = null
  const shellAltitude = flat ? CLOUD_FLAT_ALTITUDE : CLOUD_LAYER_TOP
  // The back faces within the ship camera's reach of the shell (earth-shells.ts
  // withinShellReach), the front ones elsewhere. Unlike the atmosphere's
  // shells, the depth test stays on: the shader writes each hit's depth.
  // The ship's warm-up compiles that program ahead (ship-warmup.ts).
  // Within reach the shell also draws after the atmosphere's haze, and
  // under the aurora's shell after the aurora, whose additive glow would
  // otherwise show through the fog (tides-01v.8.6; earth-shells.ts). The
  // faces and the order turn together, before the sort, so that no frame
  // draws one program at the other's place.
  material.userData.warmSides = [THREE.BackSide]
  // And typed (CLOUD_TYPED, below), on either side: the first typed frame
  // finds its program linked.
  material.userData.warmDefines = ['CLOUD_TYPED']
  let ceilingLoad: Promise<void> | null = null
  const faceCamera = (mesh: THREE.Object3D, camera: THREE.Camera) => {
    const seaLevel = uniforms.uSeaLevel.value
    const reach = withinShellReach(mesh, camera, seaLevel + shellAltitude)
    const side = reach ? THREE.BackSide : THREE.FrontSide
    if (material.side !== side) {
      material.side = side
      material.needsUpdate = true
    }
    mesh.worldToLocal(camera.getWorldPosition(eye))
    const underAurora = eye.length() < seaLevel * AURORA_SHELL_INNER
    mesh.renderOrder = !reach
      ? 0
      : underAurora
        ? CLOUD_UNDER_AURORA_RENDER_ORDER
        : CLOUD_REACH_RENDER_ORDER
    // The ease is its own program, so that without it the march pays nothing.
    const ease = !flat && prefersReducedMotion()
    if (('FOG_EASE' in material.defines) !== ease) {
      if (ease) material.defines.FOG_EASE = ''
      else delete material.defines.FOG_EASE
      material.needsUpdate = true
    }
    // So is the look by type (tides-tvr.4.2): untyped clouds are drawn by
    // tides-tvr.3's program itself, and pay nothing for the types.
    const typed = uniforms.uCloudTyped.value > 0.5
    if (('CLOUD_TYPED' in material.defines) !== typed) {
      if (typed) material.defines.CLOUD_TYPED = ''
      else delete material.defines.CLOUD_TYPED
      material.needsUpdate = true
    }
    // The eye's path among the clouds: in their frame, as they drift.
    if (ease && reach) {
      const t = performance.now() / 1000
      const shift = uniforms.uCloudShift.value
      const p = cloudFrame([eye.x, eye.y, eye.z], shift)
      // Afresh after a break longer than the ease (other cameras render
      // between, so leaving reach shows only as a gap).
      if (track.length > 0 && track[track.length - 1].t < t - FOG_EASE_SECONDS) track.length = 0
      while (track.length > 1 && track[1].t < t - FOG_EASE_SECONDS) track.shift()
      const newest = track[track.length - 1]
      if (newest && newest.t >= t) newest.p = p
      else track.push({ t, p })
      eyePastOffsets(track, FOG_EASE_SECONDS, FOG_EASE_SAMPLES).forEach((offset, k) =>
        material.uniforms.uFogPast.value[k].fromArray(cloudFrame(offset, -shift))
      )
    }
    // The march's steps move on with the eye along the view (tides-ndh), the
    // eye and the view in the clouds' frame, as they drift. Only for the
    // ship camera's march: the other cameras, which render between, leave
    // it, so that coming back within reach only jumps the phase.
    if (reach && !flat) {
      const shift = uniforms.uCloudShift.value
      const at = cloudFrame([eye.x, eye.y, eye.z], shift)
      camera.getWorldDirection(forward).transformDirection(toLocal.copy(mesh.matrixWorld).invert())
      const phase = material.uniforms.uMarchPhase
      const view = cloudFrame([forward.x, forward.y, forward.z], shift)
      if (marchEye) phase.value = marchPhaseAfter(phase.value, marchEye, at, view, MARCH_STEP)
      marchEye = at
    }
    // The ceiling, once the ship is near Earth, ahead of the march from
    // inside (in a browser: elsewhere there is no asset server).
    if (!flat && !ceilingLoad && limbBody() === 'earth' && typeof window !== 'undefined') {
      ceilingLoad = fetchCeiling()
        .then((texture) => {
          material.uniforms.uCloudCeiling.value.dispose()
          material.uniforms.uCloudCeiling.value = texture
        })
        .catch((error: unknown) => {
          console.warn('Cloud ceiling failed to load; the march skips nothing.', error)
        })
    }
  }
  const flag = flat ? '#define CLOUD_FLAT\n' : ''
  const groundPatch: MaterialPatch = {
    onBeforeCompile(shader) {
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = inject(
        GROUND_VERTEX_HEAD + shader.vertexShader,
        'begin_vertex',
        GROUND_VERTEX_BODY
      )
      shader.fragmentShader = inject(
        inject(shader.fragmentShader, 'common', flag + liveTerrain(GROUND_FRAGMENT_HEAD, live)),
        'lights_fragment_end',
        GROUND_FRAGMENT_LIGHT
      )
    },
    customProgramCacheKey: () => (flat ? 'cloud-shadow-flat' : 'cloud-shadow') + (live ? '-live' : ''),
  }
  const setMap = (map: THREE.Texture, measured: boolean, types: THREE.Texture | null) => {
    uniforms.uCloudMap.value = map
    uniforms.uCloudMeasured.value = measured ? 1 : 0
    uniforms.uCloudMaxKm.value = maxTopKm(measured)
    uniforms.uCloudTyped.value = types ? 1 : 0
    uniforms.uCloudType.value = types ?? neutralTypeTexture()
  }
  return {
    material,
    groundPatch,
    uniforms,
    setMap,
    shellAltitude,
    faceCamera,
    dispose: () => {
      material.uniforms.uCloudCeiling.value.dispose()
      material.dispose()
    },
  }
}
