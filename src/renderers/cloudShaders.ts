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
// camera; see the FLIP_SIDED branches.
//
// The maths mirrors ../cloud-layer.ts; constants come from there.
import * as THREE from 'three'
import {
  airMass,
  CLOUD_CLEARANCE,
  CLOUD_FLAT_ALTITUDE,
  CLOUD_LAYER_TOP,
  CLOUD_UNITS_PER_KM,
  DETAIL_BASE_TEXELS,
  DETAIL_FADE_END,
  DETAIL_FADE_START,
  DETAIL_OCTAVES,
  DETAIL_OCTAVES_FLAT,
  EARTH_RADIUS_KM,
  MAX_CLOUD_TOP_KM,
  MIN_MEASURED_TOP_KM,
  SUNBEAM_FLOOR_KM,
  SUNLIGHT_EXTINCTION,
  SUNSET_FLOOR,
  TERRAIN_DISPLACEMENT,
  TERRAIN_KM_PER_GREY,
  TERRAIN_MAX_GREY,
} from '../cloud-layer'
import { CLOUD_AMBIENT, CLOUD_EXPOSURE, SUNLIGHT_INTENSITY } from '../lighting'
import { sceneRadius } from '../planets'
import { DETAIL_NOISE_GLSL, detailTurnsGlsl } from './detailNoise'
import { ECLIPSE_GLSL, type EclipseShadow, type MaterialPatch } from './eclipseShadow'
import { withinShellReach } from './earth-shells'
import { POLE_SMOOTH_CLOUD_TAPS, poleSmoothingGlsl, poleSmoothingLod } from './poleSmoothing'

const f = (x: number) => x.toFixed(6)

export const MARCH_STEP = 0.011
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
  float lod = max(0.0, log2(float(textureSize(uTerrainMap, 0).x) / 256.0));
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

const VERTEX = /* glsl */ `
#include <common>
${ECLIPSE_GLSL.vertexHead}
varying vec3 vLocal;
varying vec3 vRayDir;
#ifdef FLIP_SIDED
// The camera in the mesh's frame, the fragment's depth in front of it and
// the near plane's.
varying vec3 vEye;
varying float vViewDepth;
varying float vNear;
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
  vViewDepth = -view.z;
  vNear = isOrthographic ? 0.0 : projectionMatrix[3][2] / (projectionMatrix[2][2] - 1.0);
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
// The highest ground the relief layer's bump map holds.
#define TERRAIN_TOP ${f(TERRAIN_DISPLACEMENT * TERRAIN_MAX_GREY)}
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
#endif

#if defined(CLOUD_FLAT) && defined(FLIP_SIDED)
  // The flat shell where the ray enters it, or from inside it, its underside
  // where the ray leaves (tides-01v.8.5 relights undersides).
  float sFlat = sIn >= sNear ? sIn : sOut;
  if (sFlat < sNear) discard;
  vec3 p = eye + d * sFlat;
  float terrain = 0.0;
#elif defined(CLOUD_FLAT)
  vec3 p = vLocal + d * tIn;
  float terrain = 0.0;
#elif defined(FLIP_SIDED)
  // March from the near plane (or where the ray comes within reach of the
  // tallest top this texture can have anywhere, if that is further) to where
  // it leaves that reach or drops below the lowest base anywhere. Rays that
  // never come within reach, the sky from inside, end at once. A ray from
  // inside can cross half the layer, so each step reads its own ground for
  // the column's base, and its own mip for the footprint there. What lies
  // past the ground, the depth test hides: gl_FragDepth below. Mirrored by
  // cloud-layer.ts marchSpanFromEye.
  float outer = uSeaLevel + min(TERRAIN_TOP + CLOUD_CLEARANCE + CLOUD_UNITS_PER_KM * uCloudMaxKm,
    CLOUD_LAYER_TOP);
  float discOuter = be * be - (dot(eye, eye) - outer * outer);
  if (discOuter <= 0.0) discard;
  float sStart = max(-be - sqrt(discOuter), sNear);
  float sEnd = -be + sqrt(discOuter);
  float inner = uSeaLevel + CLOUD_CLEARANCE;
  float discInner = be * be - (dot(eye, eye) - inner * inner);
  if (discInner > 0.0 && -be - sqrt(discInner) > sStart) sEnd = -be - sqrt(discInner);
  if (sEnd <= sStart) discard;
  int steps = int(clamp(ceil((sEnd - sStart) / MARCH_STEP), 3.0, float(MARCH_STEPS)));
  float ds = (sEnd - sStart) / float(steps);
  float sPrev = sStart;
  float gapPrev = 0.0;
  float sHit = -1.0;
  for (int i = 0; i <= MARCH_STEPS; i++) {
    if (i > steps) break;
    float s = sStart + ds * float(i);
    vec3 q = eye + d * s;
    float r = length(q);
    vec2 uvq = cloudUv(q / r);
    float lodq = cloudLod(spread * s / max(abs(dot(d, q / r)), 0.05));
    vec4 colq = cloudColumn(uvq, lodq, cloudTerrain(uvq));
    float gap = r - uSeaLevel - colq.z;
    if (gap <= 0.0) {
      if (i == 0) {
        // The march starts inside a column. If the camera itself is in it,
        // it is in a cloud: unshaded until tides-01v.8.6 fogs it, and a
        // clear column is the view from below the deck (tides-01v.8.5).
        // Otherwise only the near plane cuts the top, there.
        vec2 uvEye = cloudUv(normalize(eye));
        vec4 colEye = cloudColumn(uvEye, 0.0, cloudTerrain(uvEye));
        if (length(eye) - uSeaLevel <= colEye.z) {
          if (colEye.x < 0.02) discard;
          gl_FragColor = vec4(vec3(0.8), colEye.x * uOpacity);
          gl_FragDepth = 0.0;
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          return;
        }
        sHit = s;
        break;
      }
      sHit = mix(sPrev, s, gapPrev / max(gapPrev - gap, 1e-6));
      break;
    }
    sPrev = s;
    gapPrev = gap;
  }
  if (sHit < 0.0) discard;
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
    float gap = r - uSeaLevel - cloudColumn(cloudUv(q / r), lod, terrain).z;
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
  // A pixel's width at the hit, stretched by the slant, as the shell's own
  // footprint gives it from outside.
  float eyeDist = length(p - eye);
  footprint = spread * eyeDist / max(abs(dot(d, normalize(p))), 0.05);
  lod = cloudLod(footprint);
#endif

  float r = length(p);
  vec3 up = p / r;
  vec2 uv = cloudUv(up);
  vec4 col = cloudColumn(uv, lod, terrain);
  if (col.x < 0.02) discard;
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
  if (alpha < 0.02) discard;

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

  float mu = dot(up, s);
  // True height above sea level, for the horizon dip and the air mass.
  float km = (col.z - col.y) / CLOUD_UNITS_PER_KM
    + (col.y - CLOUD_CLEARANCE) / TERRAIN_DISPLACEMENT * ${f(TERRAIN_KM_PER_GREY)};
  float sunUp = cloudSunUp(mu, km);
  vec3 tint = cloudSunTint(mu, km);
  float eclipse = uEclipseActive > 0.5 ? eclipseSunlight(vEclipsePoint).x : 1.0;
  float light = sunUp * (1.0 - SHADOW_DARK * occ) * eclipse;

  // Wrapped diffuse softens the day side; toward the terminator it gives
  // way to the tops' own slopes, so only the tops facing the low Sun catch
  // its light.
  float wrap = WRAP * smoothstep(-0.02, 0.2, mu);
  float diffuse = clamp((dot(n, s) + wrap) / (1.0 + wrap), 0.0, 1.0);
  // Thick cloud turned from the Sun reads grey.
  float albedo = 1.0 - 0.3 * smoothstep(0.5, 1.0, alpha) * (1.0 - diffuse);
  vec3 sky = vec3(0.55, 0.68, 0.9) * SKY * smoothstep(-0.1, 0.35, mu);
  // Henyey-Greenstein forward lobe: thin cloud glows looking toward the Sun.
  float cosT = dot(d, s);
  float hg = 0.25 * (1.0 - 0.36) / pow(1.36 - 1.2 * cosT, 1.5);
  float edge = 4.0 * alpha * (1.0 - alpha);
  vec3 radiance = albedo * (uSunGain * (tint * light * diffuse + sky) + uAmbient)
    + uSunGain * FORWARD * tint * light * hg * edge;

  // Seen edge-on, a cloud is a longer path.
  float slant = 1.0 / max(abs(dot(d, up)), 0.3);
  float opacity = (1.0 - pow(1.0 - min(alpha, 0.995), slant)) * uOpacity;
  gl_FragColor = vec4(radiance, opacity);
#ifdef FLIP_SIDED
  #if defined(USE_LOGARITHMIC_DEPTH_BUFFER) || defined(USE_REVERSED_DEPTH_BUFFER)
  #error "cloud layer: gl_FragDepth assumes the standard depth buffer"
  #endif
  // The hit's depth, so the displaced ground hides clouds behind it: the
  // back face lies past the globe. View depth scales with distance along
  // the ray.
  float z = vViewDepth * eyeDist / length(vRayDir);
  gl_FragDepth = 0.5 + 0.5 * (projectionMatrix[3][2] - projectionMatrix[2][2] * z) / z;
#endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
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
  dispose(): void
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
    },
    defines,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
  })
  const shellAltitude = flat ? CLOUD_FLAT_ALTITUDE : CLOUD_LAYER_TOP
  // The back faces within the ship camera's reach of the shell (earth-shells.ts
  // withinShellReach), the front ones elsewhere. Unlike the atmosphere's
  // shells, the depth test stays on: the shader writes each hit's depth.
  // The ship's warm-up compiles that program ahead (ship-warmup.ts).
  material.userData.warmSides = [THREE.BackSide]
  material.onBeforeRender = (_renderer, _scene, camera, _geometry, object) => {
    const reach = withinShellReach(object, camera, uniforms.uSeaLevel.value + shellAltitude)
    const side = reach ? THREE.BackSide : THREE.FrontSide
    if (material.side !== side) {
      material.side = side
      material.needsUpdate = true
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
    dispose: () => material.dispose(),
  }
}
