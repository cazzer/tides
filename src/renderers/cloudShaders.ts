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
// The maths mirrors ../cloud-layer.ts; constants come from there.
import * as THREE from 'three'
import {
  type EyeSample,
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
import ceilingUrl from '../assets/earth-cloud-ceiling.bin?url'
import hazeGlsl from '../shaders/atmosphere/haze.glsl'

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
// Steps for the longest path a march can take: a ray grazing the layer's
// base, from its top in and out again (sea level is Earth's scene radius,
// as EarthRenderer sets it). Short of that, a grazing ray's samples
// straddle the tops and the limb stair-steps along them (tides-01v.9).
// A march from inside the shell covers part of that chord, so it holds there.
const SEA_LEVEL = sceneRadius(2000 * EARTH_RADIUS_KM)
export const MARCH_STEPS = Math.ceil(
  (2 * Math.sqrt((SEA_LEVEL + CLOUD_LAYER_TOP) ** 2 - (SEA_LEVEL + CLOUD_CLEARANCE) ** 2)) /
    MARCH_STEP
)

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

// With reduced motion (FOG_EASE), fog thickens over the eye's first
// FOG_EASE_SECONDS in a cloud (tides-01v.8.15) from the cloud as its side
// looked from just outside, so that flying in neither flashes white nor
// shows what lies past the wall. uFogPast holds where the eye was, among
// the clouds (which drift), at FOG_EASE_SAMPLES times over those seconds
// back, less where it is now; the vertex stage reads how long the march's
// start has been in a cloud from it, the same at every vertex.
const FOG_EASE_GLSL = /* glsl */ `
#define FOG_EASE_SAMPLES ${FOG_EASE_SAMPLES}
uniform vec3 uFogPast[FOG_EASE_SAMPLES];
varying float vFogEase;

// How far inside a cloud q is, in its column's thickness, and over showing:
// at most 0 outside it. Read at the mip the march reads near the eye
// (cloudMarchLod() for a step across).
float cloudFogInside(vec3 q) {
  float r = length(q);
  vec2 uv = cloudUv(q / r);
  float lod = max(0.0, log2(float(textureSize(uCloudMap, 0).x) / ${f(MARCH_MAP_WIDTH)}));
  vec4 col = cloudColumn(uv, lod, cloudTerrain(uv));
  float alt = r - uSeaLevel;
  return min(min(alt - col.y, col.z - alt) / max(col.z - col.y, 1e-6), col.x - ${f(CLOUD_MIN_ALPHA)});
}

// How far the fog of a march from q has eased in (fogEaseShare()): the
// share of FOG_EASE_SECONDS since q, moved as the eye has, was last out of
// the cloud, smoothed. A still eye's, all of it; one moving outside a
// cloud, none, for the cloud the near plane is about to enter.
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
#ifdef FOG_EASE
${FIELD}
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
  vNear = isOrthographic ? 0.0 : projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
  #ifdef FOG_EASE
  // At the near plane's centre, where the march starts: the same at every
  // vertex.
  vFogEase = cloudFogEase(vEye + transpose(mat3(modelViewMatrix)) * vec3(0.0, 0.0, -vNear));
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
uniform float uOpacity;
uniform float uSunGain;
uniform float uAmbient;
varying vec3 vLocal;
varying vec3 vRayDir;
#ifdef FLIP_SIDED
uniform mat4 projectionMatrix;
varying vec3 vEye;
varying float vViewDepth;
varying float vNear;
varying vec3 vEclipseEye;
// The hit's own point for the eclipse: the vertex's lies past the globe.
uniform mat4 modelMatrix;
uniform vec2 uEclipseBody;
${ECLIPSE_GLSL.point}
#define CLOUD_ECLIPSE_HIT eclipsePoint(p)
// The highest ground the relief layer's bump map holds.
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

#define FOG_SOFT ${f(FOG_SOFT)}
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
#define CLOUD_MISS { if (fogged) { cloudOut(vec4(fogLight, 1.0 - fogClear), 0.0, vec3(0.0), 0.0); return; } discard; }
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
// sphere's (LIMB_SEGMENTS), its vertices raised by the bump map as three's
// displacement reads it (the base level, at the vertex), and flat between
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
// ground under real ones. It erodes the edges and roughens the tops.
#ifdef CLOUD_FLAT
#define DETAIL_OCTAVES ${DETAIL_OCTAVES_FLAT}
${detailTurnsGlsl(DETAIL_OCTAVES_FLAT)}
#else
#define DETAIL_OCTAVES ${DETAIL_OCTAVES}
${detailTurnsGlsl(DETAIL_OCTAVES)}
#endif
#define DETAIL_EDGE 0.8
// Tilt of the tops per unit of noise slope, over the coarsest wavelength;
// each finer octave tilts them DETAIL_ROUGH as much as the last, and the
// whole is capped, so the texture's own slopes still read through.
#define DETAIL_RELIEF 0.35
#define DETAIL_ROUGH 0.6
#define DETAIL_MAX_SLOPE 0.35

${DETAIL_NOISE_GLSL}

// fBm at p (scene units, the clouds' frame) seen at footprint: x in about
// -1..1, yzw its gradient per scene unit. Octaves stop where they would
// shrink under a few pixels.
vec4 cloudDetail(vec3 p, float footprint, float texel) {
  float wavelength = ${f(DETAIL_BASE_TEXELS)} * texel;
  float amp = 0.5;
  float rough = 0.5;
  vec4 sum = vec4(0.0);
  for (int k = 0; k < DETAIL_OCTAVES; k++) {
    float weight = 1.0 - smoothstep(${f(DETAIL_FADE_START)}, ${f(DETAIL_FADE_END)}, footprint / wavelength);
    if (weight <= 0.0) break;
    vec4 o = detailNoise(DETAIL_TURNS[k] * p / wavelength + float(k) * 17.31);
    // o.yzw * turn: the gradient turned back (the transpose).
    sum += weight * vec4(amp * (2.0 * o.x - 1.0), rough * 2.0 * (o.yzw * DETAIL_TURNS[k]) / wavelength);
    wavelength *= 0.5;
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
// fogExtinction(), split: deep in the column col (cloudColumn()), where it
// isn't a gap, and the share of that at altitude alt, toward its top and base.
float cloudFogDensity(vec4 col) {
  return col.x < CLOUD_MIN_ALPHA ? 0.0 : col.x * -log(1.0 - min(col.x, 0.995)) / ${f(FOG_PATH)};
}
float cloudFogEdge(vec4 col, float alt) {
  float inside = min(alt - col.y, col.z - alt);
  return inside <= 0.0 ? 0.0 : smoothstep(0.0, FOG_SOFT * (col.z - col.y), inside);
}
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
#endif

void main() {
  vec3 d = normalize(vRayDir);
  // Derivatives before any discard: after one they are undefined.
  float footprint = max(length(dFdx(vLocal)), length(dFdy(vLocal)));
  // The ray's spread, a pixel's angle; unlike vLocal's, smooth across facets.
  float spread = max(length(dFdx(d)), length(dFdy(d)));
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
  // covers the ray from the near plane on. s runs along d from the eye
  // rather than from vLocal, which lies past the globe.
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
  // March from the near plane (or where the ray comes within reach of the
  // tallest top this texture can have anywhere, if that is further) to where
  // it leaves that reach, or drops below the lowest base anywhere on its way
  // to the sea: a ray that skims over the sea comes back up under the deck.
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
  float sStart = max(sOuter, sNear);
  float sEnd = -be + sqrt(discOuter);
  float inner = uSeaLevel + CLOUD_CLEARANCE;
  float discInner = be * be - (dot(eye, eye) - inner * inner);
  float discSea = be * be - (dot(eye, eye) - uSeaLevel * uSeaLevel);
  float sSea = -be - sqrt(max(discSea, 0.0));
  if (discSea > 0.0 && sSea > 0.0) {
    // From below every base, the sea itself.
    sEnd = -be - sqrt(discInner) > sStart ? -be - sqrt(discInner) : sSea;
  }
  if (sEnd <= sStart) discard;
  // Steps of MARCH_STEP from the start, the last cut short, so that from
  // ray to ray the steps slide rather than jump (as they would spread evenly
  // over each ray's span, a step's worth at the far end where the count
  // changes: bands, tides-01v.8.12). At least three, and longer only for
  // rays skimming the sea from the shell's top, by under 2%.
  float ds = max(min(MARCH_STEP, (sEnd - sStart) / 3.0), (sEnd - sStart) / float(MARCH_STEPS));
  int steps = int(clamp(ceil((sEnd - sStart) / ds - 1e-3), 1.0, float(MARCH_STEPS)));
  // The march's steps at either end that lie above the ceiling would all
  // find clear air, so it leaves them out (tides-01v.8.10): from each end
  // the ray is read against the ceiling, then moved on to where it comes
  // under it, or by the ceiling's reach. The steps between are the same
  // steps, so they meet the same cloud.
  float sFirst = sStart;
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
  int iFirst = max(int(floor((sFirst - sStart) / ds)) - 1, 0);
  int iLast = min(int(ceil((sLast - sStart) / ds)) + 1, steps);
  // A column holds cloud from its base to its top, where it is at least
  // CLOUD_MIN_ALPHA. Over each step the march takes the ray's altitude and
  // its column (top, base and opacity) to change linearly, as the fog below
  // does, and finds the stretch where the ray is in cloud (cloudSpan()):
  // under the top, over the base, and where the cloud shows. Where that
  // starts, the ray meets the cloud: down through a top, up through a base,
  // or into a side, where the ray was already between the base and the top
  // of the column it steps into, or the cloud beside it came up to showing.
  // So a ray that clips a cloud between two steps still meets it, and from
  // ray to ray at the same place (tides-01v.8.12). Through a faint column's
  // top or base it carries on. From above the tops around the camera, as
  // from outside, a top is met however faint (the shading drops it): carried
  // on, grazing rays would find sides along every far edge, a step apart.
  // Mirrored by cloud-layer.ts marchCrossing. A march that starts in a cloud
  // crosses its fog first (fogExtinction()), to where it leaves that cloud,
  // and from there on as from anywhere else. Past the fog's start, whose
  // depth the depth test then sees (gl_FragDepth below), nothing hides what
  // lies beyond the ground, so the march ends where it goes under the
  // ground mesh itself (cloudGround()), within the step: into a ridge, not
  // only the ground the columns stand on (tides-01v.8.13). The mesh's
  // vertices lie a few steps apart.
  float sPrev = sStart;
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
  for (int i = iFirst; i <= MARCH_STEPS; i++) {
    if (i > iLast) break;
    float s = min(sStart + ds * float(i), sEnd);
    if (s <= sSkip) continue;
    float stepLen = s - sPrev;
    vec3 q = eye + d * s;
    float r = length(q);
    vec2 uvq = cloudUv(q / r);
    // A pixel's width on the map: stretched by the slant toward a top or a
    // base, but across a side, what a step within the deck's height meets;
    // and no finer than a step's way across the map (cloudMarchLod()).
    bool inDeck = !fromAbove && i > iFirst && underPrev <= 0.0
      && -underPrev < CLOUD_UNITS_PER_KM * uCloudMaxKm;
    float mu = dot(d, q / r);
    float lodq = max(cloudLod(spread * s / (inDeck ? 1.0 : max(abs(mu), 0.05))),
      cloudMarchLod(ds * sqrt(max(1.0 - mu * mu, 0.0))));
    vec4 colq = cloudColumn(uvq, lodq, cloudTerrain(uvq));
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
      sideClear *= cloudPathClear(colq.x, colq.z - colq.y, stepLen * max(min(through, clip), 0.0));
      if (clip < 1.0 || sideClear < 0.02) break;
      if (!inCloud) CLOUD_VEIL
      else if (i >= iSide + SIDE_STEPS) {
        float rest = mu > 0.0 ? -gap / mu : mu < 0.0 ? under / mu : SIDE_REST;
        sideClear *= cloudPathClear(colq.x, colq.z - colq.y, min(rest, SIDE_REST));
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
      vec2 uvEye = cloudUv(normalize(eye));
      float terrainEye = cloudTerrain(uvEye);
      float altEye = length(eye) - uSeaLevel;
      fromAbove = altEye > cloudColumn(uvEye, NEAR_TOPS_LOD, terrainEye).z;
      if (inCloud) {
        // The march starts in a cloud: the camera's, or one the near plane
        // cuts. Its fog runs from the eye (or where the ray comes within
        // reach), as thick up to here as here.
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
        fogClear = exp(-sigmaPrev * (s - max(sOuter, 0.0)));
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
          break;
        }
        iSide = i;
        sideClear = cloudPathClear(colq.x, colq.z - colq.y, stepLen * (until - from));
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
  // A pixel's width where the ray meets the top, stretched by the slant.
  // vRayDir is the eye's offset: the Earth group is unscaled.
#ifdef FLIP_SIDED
  float topFootprint = footprint;
#else
  float topFootprint = isOrthographic
    ? footprint
    : spread * (length(vRayDir) + length(p - vLocal)) / max(abs(dot(d, up)), 0.05);
#endif
  vec4 detail = cloudDetail(cloudFrame(p, uCloudShift), topFootprint, texel);
  float alpha = clamp(col.x + DETAIL_EDGE * detail.x * 4.0 * col.x * (1.0 - col.x), 0.0, 1.0);
  if (alpha < CLOUD_MIN_ALPHA) {
    if (!CLOUD_VEILED) CLOUD_MISS;
    alpha = 0.0;
  }
  // How far down its column the hit lies (columnDepth()): 0 on a top, 1 on
  // a base seen from below, between on a side; the flat shell is all top or
  // all base, and from outside only tops show.
#if defined(CLOUD_FLAT) && defined(FLIP_SIDED)
  float depth = length(eye) < shell ? 1.0 : 0.0;
#elif defined(FLIP_SIDED)
  float depth = depthHit >= 0.0
    ? depthHit
    : clamp((col.z - (r - uSeaLevel)) / max(col.z - col.y, 1e-6), 0.0, 1.0);
#else
  float depth = 0.0;
#endif

  // The tops' slope, by forward differences a pixel or so apart.
  float h = max(footprint, 3.0 * texel);
  vec3 east = normalize(vec3(up.z, 0.0, -up.x) + vec3(1e-5, 0.0, 0.0));
  vec3 north = cross(up, east);
  float cosLat = max(length(up.xz), 0.05);
  // A mip down, and the tilt capped: measured heights can jump kilometres
  // between neighbouring texels, which would stand tops on edge.
  float lodN = lod + 1.0;
  float topC = cloudColumn(uv, lodN, terrain).z;
  float topE = cloudColumn(uv + vec2(h / (2.0 * CLOUD_PI * r * cosLat), 0.0), lodN, terrain).z;
  float topN = cloudColumn(uv + vec2(0.0, h / (CLOUD_PI * r)), lodN, terrain).z;
  vec2 slope = RELIEF * vec2(topE - topC, topN - topC) / h;
  // The detail's own slope, along the top.
  vec3 grain = cloudFrame(detail.yzw, -uCloudShift) * DETAIL_RELIEF * ${f(DETAIL_BASE_TEXELS)} * texel;
  vec2 grainSlope = vec2(dot(grain, east), dot(grain, north));
  slope += grainSlope * min(1.0, DETAIL_MAX_SLOPE / max(length(grainSlope), 1e-6));
  slope *= min(1.0, MAX_SLOPE / max(length(slope), 1e-6));
  vec3 n = normalize(up - slope.x * east - slope.y * north);

  // Taller cloud toward the Sun shades this top.
  vec3 s = uSunDir;
  vec3 lit = up * (uSeaLevel + col.z);
  float occ = 0.0;
  for (int j = 1; j <= SHADOW_STEPS; j++) {
    float ts = SHADOW_STEP * float(j * j);
    vec3 q = lit + s * ts;
    float rq = length(q);
    float aq = rq - uSeaLevel;
    if (aq > CLOUD_LAYER_TOP) break;
    vec4 cq = cloudColumn(cloudUv(q / rq), max(lod + 1.0, 2.0), terrain);
    occ = max(occ, cloudShade(cq.x) * smoothstep(0.0, SHADOW_SOFT, cq.z - aq));
  }

  vec3 radiance = cloudRadiance(up, n, d, alpha, depth, cloudKm(col.z, col.y), occ, CLOUD_ECLIPSE_HIT);

  // Seen edge-on, a cloud is a longer path.
  float slant = 1.0 / max(abs(dot(d, up)), 0.3);
#ifdef FLIP_SIDED
  // A side's opacity already holds its path.
  if (side) slant = 1.0;
#endif
  float opacity = (1.0 - pow(1.0 - min(alpha, 0.995), slant)) * uOpacity;
#ifdef FLIP_SIDED
  // Thinning into the ground, and seen through the veils in front of it.
  opacity *= smoothstep(0.0, GROUND_FADE, r - uSeaLevel - cloudGround(uv));
  opacity = 1.0 - (1.0 - (1.0 - veilClear) * uOpacity) * (1.0 - opacity);
  #if defined(USE_LOGARITHMIC_DEPTH_BUFFER) || defined(USE_REVERSED_DEPTH_BUFFER)
  #error "cloud layer: gl_FragDepth assumes the standard depth buffer"
  #endif
  // The hit's depth, so the displaced ground hides clouds behind it: the
  // back face lies past the globe. View depth scales with distance along
  // the ray. Fog starts at the eye, in front of everything; past it the
  // march ended at the ground.
  float z = vViewDepth * eyeDist / length(vRayDir);
  // The fog over the hit (premultiplied, then back), and the haze in front
  // of the hit as far as the fog lets it through.
  float fogA = 1.0 - fogClear;
  float a = fogA + fogClear * opacity;
  cloudOut(vec4((fogA * fogLight + fogClear * opacity * radiance) / max(a, 1e-6), a),
    fogged ? 0.0 : 0.5 + 0.5 * (projectionMatrix[3][2] - projectionMatrix[2][2] * z) / z,
    cloudHazeFront(eye, d, eyeDist, shell), fogClear * opacity);
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
    uSunDir: THREE.IUniform<THREE.Vector3>
    uSeaLevel: THREE.IUniform<number>
  }
  /** Altitude of the shell mesh above sea level. */
  shellAltitude: number
  /** Readies the shell's mesh for drawing to `camera`: before three sorts
   * what it draws (a scene's onBeforeRender), as it sets the draw order. */
  faceCamera(mesh: THREE.Object3D, camera: THREE.Camera): void
  dispose(): void
}

const eye = new THREE.Vector3()

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

export function createCloudLayer(eclipse: EclipseShadow, flat: boolean): CloudLayer {
  const uniforms: CloudLayer['uniforms'] = {
    uCloudMap: { value: null },
    uTerrainMap: { value: null },
    uCloudShift: { value: 0 },
    uCloudMeasured: { value: 0 },
    uCloudMaxKm: { value: MAX_CLOUD_TOP_KM },
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uSeaLevel: { value: 1 },
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
      uCloudCeiling: { value: ceilingTexture() },
    },
    defines,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    // The shader premultiplies, so that within reach the haze it adds over a
    // cloud (cloudHazeFront) isn't clipped before the blend.
    premultipliedAlpha: true,
  })
  // The eye's recent path, while the fog eases in (FOG_EASE_SECONDS).
  const track: EyeSample[] = []
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
        inject(shader.fragmentShader, 'common', flag + GROUND_FRAGMENT_HEAD),
        'lights_fragment_end',
        GROUND_FRAGMENT_LIGHT
      )
    },
    customProgramCacheKey: () => (flat ? 'cloud-shadow-flat' : 'cloud-shadow'),
  }
  return {
    material,
    groundPatch,
    uniforms,
    shellAltitude,
    faceCamera,
    dispose: () => {
      material.uniforms.uCloudCeiling.value.dispose()
      material.dispose()
    },
  }
}
