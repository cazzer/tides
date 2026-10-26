// Fine detail on the ground where the day map is magnified (tides-01v.4):
// value-noise fBm in the Earth's own frame (./detailNoise.ts) roughens the
// land's albedo and tilts its normals, from DETAIL_BASE_TEXELS map texels
// down, each octave faded out before it shrinks to a few pixels so none of it
// sparkles (detailOctaveWeight()). From the system view no octave survives.
//
// It keys off the material's own inputs after the albedo lookup: the specular
// mask (open water, left smooth so its glint is untouched) and the albedo's
// colour (ice, given a gentler grain). Night lights (emissive) and the clouds'
// shadows (applied to the lit result) are untouched. A finer albedo source
// over part of the ground (the GIBS patch, tides-01v.7, ./gibsPatch.ts) sets
// groundDetailFine and groundDetailFineTexel there, which fade out the
// octaves it already resolves. Changing groundDetailTexel itself across the
// ground would warp the noise.
//
// The ground's own slope (tides-01v.13, tides-zmw.3, ./groundRelief.ts: the
// drawn mesh's, from ./groundDisplacement.ts, plus the elevation map's finer
// relief) tilts the land's normal first, from the same footprint; the
// detail's finer tilt adds to it.
//
// Skylight on the tilted ground (tides-01v.19): the Sun is the ground's only
// direct light, so under a low Sun every slope facing away went black.
// GROUND_SKY_FILL of the flat ground's sunlight comes instead from the sky
// dome, weighted by how much of the sky a slope sees; it fades with the Sun
// to nothing at the terminator. Where the normal isn't tilted (the sea, the
// system view) the two parts sum to the old sunlight, and the night side
// gains nothing.
//
// The detail's tilt was sized for ground drawn at 12x (DETAIL_TILT_RELIEF).
// With the live terrain scale on (terrain-scale.ts TERRAIN_BLEND) or the
// page at another relief, it follows the drawn relief (displacementScale
// over 12x's), as the ground's own slope does: at 1x a tilt sized for 12x
// relief stood ~12x too steep (tides-zmw.9.7, tides-zmw.21). At 12x without
// the blend, the shader is as it was.
//
// Spread through composePatches onto the ground's Phong material.
import { DETAIL_BASE_TEXELS, DETAIL_FADE_END, DETAIL_FADE_START, REFERENCE_TERRAIN_DISPLACEMENT } from '../cloud-layer'
import { REFERENCE_RELIEF, RELIEF } from '../relief'
import { TERRAIN_BLEND } from '../terrain-scale'
import { DETAIL_NOISE_GLSL, detailTurnsGlsl } from './detailNoise'
import { GROUND_RELIEF_GLSL } from './groundRelief'
import type { MaterialPatch } from './eclipseShadow'

/** Octaves on the full-quality ground; the low tier takes fewer. At the
 * ship's stop over the 10800 map only about three survive the fade, so the
 * cap bites only lower down, or over the low tier's 2k map. */
export const GROUND_DETAIL_OCTAVES = 5
export const GROUND_DETAIL_OCTAVES_LOW = 3

/** The relief the detail's tilt was sized at, and its displacementScale
 * there (as cloud-layer.ts works TERRAIN_DISPLACEMENT out, so the same
 * number at 12x). */
export const DETAIL_TILT_RELIEF = 12
export const DETAIL_TILT_DISPLACEMENT = REFERENCE_TERRAIN_DISPLACEMENT * (DETAIL_TILT_RELIEF / REFERENCE_RELIEF)
/** Whether this page's tilt follows the drawn relief: with the blend on, or
 * at another relief than the one it was sized at. */
export const DETAIL_FOLLOWS_RELIEF = TERRAIN_BLEND || RELIEF !== DETAIL_TILT_RELIEF

const f = (x: number) => x.toFixed(6)

const VERTEX_HEAD = /* glsl */ `
varying vec3 vGroundDetailPos;
`

const VERTEX_BODY = /* glsl */ `
vGroundDetailPos = position;
`

// normalMatrix is the vertex stage's uniform, shared by the program: it
// turns the noise's gradient into view space without spending varyings.
const fragmentHead = (octaves: number, relief: boolean) => /* glsl */ `
varying vec3 vGroundDetailPos;
uniform mat3 normalMatrix;
${relief ? `#define GROUND_RELIEF\n${GROUND_RELIEF_GLSL}` : ''}

#define GROUND_DETAIL_OCTAVES ${octaves}
${detailTurnsGlsl(octaves)}
${DETAIL_NOISE_GLSL}

// Albedo varies by up to this fraction either side over land; ice by less.
#define GROUND_DETAIL_ALBEDO 0.18
#define GROUND_DETAIL_ALBEDO_ICE 0.04
// Tilt per unit of noise slope over the coarsest wavelength, each finer
// octave GROUND_DETAIL_ROUGH as much as the last, capped.
#define GROUND_DETAIL_RELIEF 0.35
#define GROUND_DETAIL_RELIEF_ICE 0.08
#define GROUND_DETAIL_ROUGH 0.7
#define GROUND_DETAIL_MAX_SLOPE 0.5
// The share of the Sun's light on flat ground that comes from the sky.
#define GROUND_SKY_FILL 0.2

// fBm at p (scene units, the Earth's frame) seen at footprint over a map of
// texel, a fraction fine of it also covered by a source of fineTexel: x in
// about -1..1, yzw its gradient per scene unit.
vec4 groundDetail(vec3 p, float footprint, float texel, float fineTexel, float fine) {
  float wavelength = ${f(DETAIL_BASE_TEXELS)} * texel;
  float amp = 0.5;
  float rough = 0.5;
  vec4 sum = vec4(0.0);
  for (int k = 0; k < GROUND_DETAIL_OCTAVES; k++) {
    float weight = 1.0 - smoothstep(${f(DETAIL_FADE_START)}, ${f(DETAIL_FADE_END)}, footprint / wavelength);
    if (weight <= 0.0) break;
    weight *= 1.0 - fine * smoothstep(0.5, 1.0, wavelength / (${f(DETAIL_BASE_TEXELS)} * fineTexel));
    vec4 o = detailNoise(DETAIL_TURNS[k] * p / wavelength + float(k) * 23.17);
    sum += weight * vec4(amp * (2.0 * o.x - 1.0), rough * 2.0 * (o.yzw * DETAIL_TURNS[k]) / wavelength);
    wavelength *= 0.5;
    amp *= 0.5;
    rough *= 0.5 * GROUND_DETAIL_ROUGH;
  }
  return sum;
}
`

// The albedo source's texel (scene units). A finer source over part of the
// ground (tides-01v.7) sets the fine pair, by a patch after this one's.
const TEXEL_BODY = /* glsl */ `
#if defined(USE_MAP) && defined(USE_SPECULARMAP)
float groundDetailTexel = 6.283185307 * length(vGroundDetailPos) / float(textureSize(map, 0).x);
float groundDetailFineTexel = groundDetailTexel;
float groundDetailFine = 0.0;
#endif
`

// The detail's tilt over the drawn relief's share of 12x's (only where the
// relief's displacementScale is declared).
const SCALED_TILT = /* glsl */ `
#ifdef GROUND_RELIEF
    slope *= displacementScale / ${DETAIL_TILT_DISPLACEMENT.toExponential(9)};
#endif`

// After the albedo lookup, the specular mask and the normal; before the
// emissive map and the lights.
const fragmentBody = (followScale: boolean) => /* glsl */ `
#if defined(USE_MAP) && defined(USE_SPECULARMAP)
vec3 groundUp = normal;
{
  // A pixel's width on the ground, stretched by the slant: from the view
  // ray's spread, which unlike the position's is smooth across facets (the
  // orthographic system view's is faceted, but far too coarse for detail).
  vec3 eye = normalize(vViewPosition);
  float groundFootprint = isOrthographic
    ? max(length(dFdx(vGroundDetailPos)), length(dFdy(vGroundDetailPos)))
    : max(length(dFdx(eye)), length(dFdy(eye))) * length(vViewPosition)
      / max(abs(dot(eye, normal)), 0.05);
  float groundLand = 1.0 - specularStrength;
#ifdef GROUND_RELIEF
  if (groundLand > 0.0) {
#ifdef GROUND_MESH_SLOPE
    vec3 groundMeshSlope = groundDrawnSlope(vGroundDetailPos, groundFootprint);
#else
    vec3 groundMeshSlope = vec3(0.0);
#endif
    normal = normalize(normal - normalMatrix * (groundLand * groundSlope(vMapUv, vGroundDetailPos, groundFootprint, groundMeshSlope)));
  }
#endif
  if (groundLand > 0.0
      && groundFootprint < ${f(DETAIL_FADE_END * DETAIL_BASE_TEXELS)} * groundDetailTexel) {
    vec4 detail = groundDetail(vGroundDetailPos, groundFootprint, groundDetailTexel, groundDetailFineTexel, groundDetailFine);
    // Ice and snow: bright and colourless.
    vec3 albedo = diffuseColor.rgb;
    float chroma = max(albedo.r, max(albedo.g, albedo.b)) - min(albedo.r, min(albedo.g, albedo.b));
    float ice = smoothstep(0.3, 0.55, dot(albedo, vec3(0.2126, 0.7152, 0.0722)))
      * (1.0 - smoothstep(0.05, 0.12, chroma));
    diffuseColor.rgb *= 1.0 + groundLand * mix(GROUND_DETAIL_ALBEDO, GROUND_DETAIL_ALBEDO_ICE, ice) * detail.x;
    vec3 up = normalize(vGroundDetailPos);
    vec3 slope = (detail.yzw - dot(detail.yzw, up) * up)
      * mix(GROUND_DETAIL_RELIEF, GROUND_DETAIL_RELIEF_ICE, ice)
      * ${f(DETAIL_BASE_TEXELS)} * groundDetailTexel;${followScale ? SCALED_TILT : ''}
    slope *= groundLand * min(1.0, GROUND_DETAIL_MAX_SLOPE / max(length(slope), 1e-6));
    normal = normalize(normal - normalMatrix * slope);
  }
}
#endif
`

// After the lights, before the cloud shadow and the eclipse (patches earlier
// in the chain, whose code lands after this) dim the sunlight, skylight and
// all.
const LIGHT_BODY = /* glsl */ `
#if defined(USE_MAP) && defined(USE_SPECULARMAP) && NUM_DIR_LIGHTS > 0
{
  float groundSunUp = saturate(dot(groundUp, directionalLights[0].direction));
  float groundSkyView = 0.5 + 0.5 * dot(normal, groundUp);
#ifdef GROUND_HORIZON
  groundSkyView = min(groundSkyView, groundHorizonSky);
#endif
  reflectedLight.directDiffuse = (1.0 - GROUND_SKY_FILL) * reflectedLight.directDiffuse
    + GROUND_SKY_FILL * groundSunUp * groundSkyView * directionalLights[0].color
      * BRDF_Lambert(material.diffuseColor);
}
#endif
`

function inject(source: string, chunk: string, code: string): string {
  const include = `#include <${chunk}>`
  if (!source.includes(include)) {
    throw new Error(`ground detail: shader has no ${include}`)
  }
  return source.replace(include, `${include}\n${code}`)
}

/** `low`: the low quality tier, which takes fewer octaves. The relief
 * comes with the material's displacement map. `followScale`: the tilt
 * follows the drawn relief (the blend's on, or the page isn't at 12x). */
export function groundDetailPatch(low: boolean, followScale: boolean = DETAIL_FOLLOWS_RELIEF): MaterialPatch {
  const octaves = low ? GROUND_DETAIL_OCTAVES_LOW : GROUND_DETAIL_OCTAVES
  return {
    onBeforeCompile(shader) {
      shader.vertexShader = inject(VERTEX_HEAD + shader.vertexShader, 'begin_vertex', VERTEX_BODY)
      shader.fragmentShader = inject(
        inject(
          inject(
            inject(shader.fragmentShader, 'common', fragmentHead(octaves, shader.displacementMap)),
            'specularmap_fragment',
            TEXEL_BODY
          ),
          'normal_fragment_maps',
          fragmentBody(followScale)
        ),
        'lights_fragment_end',
        LIGHT_BODY
      )
    },
    customProgramCacheKey: () => `ground-detail-${octaves}${followScale ? '-scaled' : ''}`,
  }
}
