// The bump map's relief on the ground's shading (tides-01v.13). The ground's
// Phong material displaces its vertices by the bump map but keeps the
// sphere's normals, so mountains get no light or shadow of their own. This
// tilts the normal by the bump map's slope: central differences a pixel's
// footprint (at least a texel) either side, read from the mip that wide, so
// the slope is smooth where the map is magnified and filtered where it isn't.
// The mesh's relief is exaggerated about 25x (../cloud-layer.ts), which on
// the map's few-km slopes would stand the ground on end and black out every
// lee slope under a low Sun, so the shading takes a fraction of it, softly
// capped.
//
// Only up close: it fades out as the footprint grows past a few texels, so
// the system view is untouched, and toward the poles, where the map's
// stretched rows would show as streaks (as the albedo's, ./poleSmoothing.ts).
// The ground detail (./groundDetail.ts) calls it on land only, before its
// own finer tilt, so the open water's glint is untouched; it adds no albedo,
// so the GIBS patch (./gibsPatch.ts) and the night lights are unaffected.
import { POLE_SMOOTH_FROM, POLE_SMOOTH_TO } from './poleSmoothing'

/** Footprints (in bump texels at the equator) over which the relief fades out. */
export const RELIEF_FADE_START = 2
export const RELIEF_FADE_END = 4
/** The shading's slope as a fraction of the displaced mesh's. */
export const RELIEF_SCALE = 0.3
/** Slope the relief tends to, never reaches: 45°. */
export const RELIEF_MAX_SLOPE = 1

const f = (x: number) => x.toFixed(6)

// three declares the displacement map for the vertex stage only; the
// fragment's declaration shares its uniform.
export const GROUND_RELIEF_GLSL = /* glsl */ `
uniform sampler2D displacementMap;
uniform float displacementScale;

// The relief's slope (rise per run, the Earth's frame) at uv, the point p on
// the sea-level sphere, seen at footprint (a pixel's width on the ground).
vec3 groundRelief(vec2 uv, vec3 p, float footprint) {
  float width = float(textureSize(displacementMap, 0).x);
  // A texel's width on the ground at the equator; the map is 2:1.
  float texel = 6.283185307 * length(p) / width;
  float lat = (uv.y - 0.5) * 180.0;
  float fade = (1.0 - smoothstep(${f(RELIEF_FADE_START)}, ${f(RELIEF_FADE_END)}, footprint / texel))
    * (1.0 - smoothstep(${f(POLE_SMOOTH_FROM)}, ${f(POLE_SMOOTH_TO)}, abs(lat)));
  if (fade <= 0.0) return vec3(0.0);
  float run = max(footprint, texel);
  float lod = log2(run / texel);
  vec2 d = vec2(run / (texel * width * max(cos(radians(lat)), 0.05)), 2.0 * run / (texel * width));
  float east = textureLod(displacementMap, vec2(fract(uv.x + d.x), uv.y), lod).r
    - textureLod(displacementMap, vec2(fract(uv.x - d.x), uv.y), lod).r;
  float north = textureLod(displacementMap, vec2(uv.x, min(uv.y + d.y, 1.0)), lod).r
    - textureLod(displacementMap, vec2(uv.x, max(uv.y - d.y, 0.0)), lod).r;
  vec3 n = normalize(p);
  vec3 e = normalize(cross(vec3(0.0, 1.0, 0.0), n));
  vec3 slope = ${f(RELIEF_SCALE)} * displacementScale * (east * e + north * cross(n, e)) / (2.0 * run);
  float s = length(slope);
  return fade * slope / sqrt(1.0 + s * s / ${f(RELIEF_MAX_SLOPE * RELIEF_MAX_SLOPE)});
}
`
