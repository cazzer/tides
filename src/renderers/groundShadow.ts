// Terrain shadows on the ground (tides-zmw.4), from the baked horizon map
// (../earth-horizon.ts, ./earthHorizonTexture.ts):
//
// - The Sun: where the horizon toward it stands above the Sun, the ground is
//   in the range's shadow, with a soft edge HORIZON_SOFTNESS either side.
//   Flat ground and the open sea have no horizon, nor (to the shader) has
//   ground rising less than the map's step, so the terminator and the glint
//   are as they were.
// - The sky: a valley sees less of it than a ridge, so its ambient light is
//   dimmed by the share it sees, to HORIZON_SKY_POWER, and the ground
//   detail's sky fill (./groundDetail.ts, which reads groundHorizonSky) by
//   that or its own slope's share, whichever is less: both measure the same
//   occlusion, so their product would count a tilted slope's twice.
//
// Both follow the ground's exaggeration: the map's tangents are scaled from
// the exaggeration it was baked at to the material's displacementScale. Both
// fade out where a pixel spans about one of the map's texels (the system
// view, where they would smudge the terminator) and toward the poles, as the
// relief does (./groundRelief.ts), and through the twilight into the night.
// Night lights (emissive) are untouched.
//
// Spread through composePatches onto the ground's Phong material, after
// groundDetailPatch: its light code then lands before the ground detail's
// split of the Sun's light into sunlight and sky fill, so the shadow dims
// only the sunlight.
import type * as THREE from 'three'
import { HORIZON_MAX_ANGLE, HORIZON_SOFTNESS } from '../earth-horizon'
import type { MaterialPatch } from './eclipseShadow'
import type { EarthHorizonUniforms } from './earthHorizonTexture'
import { POLE_SMOOTH_FROM, POLE_SMOOTH_TO } from './poleSmoothing'

/** Footprints (in horizon texels at the equator) over which the shadows fade
 * out: with the relief on the high tier (./groundRelief.ts, 2-4 of its 4k
 * texels), so no shadow shows without the slopes that cast it. Kept, they
 * speckled the terminator once a pixel spanned a texel or so. */
export const HORIZON_FADE_START = 0.5
export const HORIZON_FADE_END = 1
/** The sky's visible share is taken to this power: occlusion's strength.
 * Squared, a valley such as Kathmandu's (0.88 of the sky) takes 0.77 of the
 * sky light: the 39 km map misses the smaller valleys' share, and at 1 the
 * occlusion barely showed in the ranges' shadows. */
export const HORIZON_SKY_POWER = 2

const f = (x: number) => x.toFixed(6)

const FRAGMENT_HEAD = /* glsl */ `
uniform sampler2DArray uGroundHorizon;
uniform vec2 uGroundHorizonCode;
uniform float uGroundShadowScale;
uniform vec3 uGroundShadowSun;
`

// After the lights. Declares groundHorizonSky for the ground detail's sky
// fill, whose code follows.
const LIGHT_BODY = /* glsl */ `
#if defined(USE_MAP) && defined(USE_SPECULARMAP) && NUM_DIR_LIGHTS > 0
#define GROUND_HORIZON
float groundHorizonSky = 1.0;
{
  float radius = length(vGroundDetailPos);
  vec3 up = vGroundDetailPos / radius;
  vec3 eye = normalize(vViewPosition);
  float footprint = isOrthographic
    ? max(length(dFdx(vGroundDetailPos)), length(dFdy(vGroundDetailPos)))
    : max(length(dFdx(eye)), length(dFdy(eye))) * length(vViewPosition)
      / max(abs(dot(eye, normalize(vNormal))), 0.05);
  float texel = 6.283185307 * radius / float(textureSize(uGroundHorizon, 0).x);
  float lat = (vMapUv.y - 0.5) * 180.0;
  vec3 sun = normalize(uGroundShadowSun);
  // Out with the twilight too (Sun 12° to 6° down), sparing the night side
  // the work: there only the faint ambient is left to occlude.
  float fade = (1.0 - smoothstep(${f(HORIZON_FADE_START)}, ${f(HORIZON_FADE_END)}, footprint / texel))
    * (1.0 - smoothstep(${f(POLE_SMOOTH_FROM)}, ${f(POLE_SMOOTH_TO)}, abs(lat)))
    * smoothstep(${f(Math.sin(-12 * Math.PI / 180))}, ${f(Math.sin(-6 * Math.PI / 180))}, dot(sun, up));
  // Outside the branch: the mips' derivatives need every pixel of a quad.
  vec4 hA = texture(uGroundHorizon, vec3(vMapUv, 0.0)) * uGroundHorizonCode.x;
  vec4 hB = texture(uGroundHorizon, vec3(vMapUv, 1.0)) * uGroundHorizonCode.x;
  if (fade > 0.0) {
    // Vector maths, no arrays: dynamically indexed, those spill on some GPUs.
    float k = uGroundShadowScale / radius / uGroundHorizonCode.y;
    // cos² of each scaled angle.
    vec4 tA = k * tan(min(hA, ${f(HORIZON_MAX_ANGLE)}));
    vec4 tB = k * tan(min(hB, ${f(HORIZON_MAX_ANGLE)}));
    float sky = dot(1.0 / (1.0 + tA * tA) + 1.0 / (1.0 + tB * tB), vec4(1.0));
    // The Sun's azimuth, as sunAzimuth() (../earth-horizon.ts) has it.
    vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), up));
    vec2 sunFlat = vec2(dot(sun, east), dot(sun, cross(up, east)));
    float bin = dot(sunFlat, sunFlat) > 1e-12 ? atan(sunFlat.x, sunFlat.y) * ${f(8 / (2 * Math.PI))} : 0.0;
    bin += bin < 0.0 ? 8.0 : 0.0;
    // The two directions either side of the Sun's azimuth, weighted by
    // nearness (wrapping round from NW to N).
    vec4 gapA = abs(bin - vec4(0.0, 1.0, 2.0, 3.0));
    vec4 gapB = abs(bin - vec4(4.0, 5.0, 6.0, 7.0));
    vec4 wA = max(1.0 - min(gapA, 8.0 - gapA), 0.0);
    vec4 wB = max(1.0 - min(gapB, 8.0 - gapB), 0.0);
    float toward = atan(k * tan(min(dot(wA, hA) + dot(wB, hB), ${f(HORIZON_MAX_ANGLE)})));
    float elevation = asin(clamp(dot(sun, up), -1.0, 1.0));
    // A horizon of a step or less never shadows (sunVisibility()).
    float quantum = k * uGroundHorizonCode.x / 255.0;
    float sunLit = mix(1.0,
      smoothstep(toward - ${f(HORIZON_SOFTNESS)}, toward + ${f(HORIZON_SOFTNESS)}, elevation),
      smoothstep(quantum, quantum + ${f(HORIZON_SOFTNESS)}, toward));
    sunLit = mix(1.0, sunLit, fade);
    groundHorizonSky = mix(1.0, pow(sky / 8.0, ${f(HORIZON_SKY_POWER)}), fade);
    reflectedLight.directDiffuse *= sunLit;
    reflectedLight.directSpecular *= sunLit;
    reflectedLight.indirectDiffuse *= groundHorizonSky;
  }
}
#endif
`

/** The patch's GLSL, for the streamed tiles to reuse by text
 * (surface/tile-shadow.ts, tides-zmw.9.15). */
export const GROUND_SHADOW_GLSL = { fragmentHead: FRAGMENT_HEAD, lightBody: LIGHT_BODY }

function inject(source: string, chunk: string, code: string): string {
  const include = `#include <${chunk}>`
  if (!source.includes(include)) {
    throw new Error(`ground shadow: shader has no ${include}`)
  }
  return source.replace(include, `${include}\n${code}`)
}

/** `sun`: the Sun's direction in the ground mesh's local frame, kept up to
 * date by the caller (the cloud layer's uSunDir). `horizon`: the map
 * (earthHorizon()). Needs groundDetailPatch earlier in the chain. */
export function groundShadowPatch(sun: THREE.IUniform<THREE.Vector3>, horizon: EarthHorizonUniforms): MaterialPatch {
  return {
    onBeforeCompile(shader) {
      shader.uniforms.uGroundShadowSun = sun
      shader.uniforms.uGroundHorizon = horizon.map
      shader.uniforms.uGroundHorizonCode = horizon.code
      // The material's own displacementScale uniform (the same object), so
      // the shadows follow a change to it. Not redeclared under its own
      // name: the relief (./groundRelief.ts) declares that.
      shader.uniforms.uGroundShadowScale = shader.uniforms.displacementScale
      shader.fragmentShader = inject(
        inject(shader.fragmentShader, 'common', FRAGMENT_HEAD),
        'lights_fragment_end',
        LIGHT_BODY
      )
    },
    customProgramCacheKey: () => 'ground-shadow',
  }
}
