// The ground's slope for its shading (tides-01v.13, tides-zmw.3). The ground's
// Phong material displaces its vertices but keeps the sphere's normals, so
// mountains would get no light or shadow of their own. The normal tilts by
// the slope the mesh is drawn with (groundDisplacement.ts' vGroundSlope, at
// the full exaggeration, interpolated over its triangles), so lit slopes
// match the silhouette, plus a share of the elevation map's finer relief
// about it: central differences a pixel's footprint (at least a texel)
// either side, read from the mip that wide. On relief a few mesh cells
// across or broader the fine slope averages to the mesh's, and the share
// only adds detail. On sharper relief it doesn't: the mesh's slope is a
// vertex's central difference over box-filtered heights, which smooths a
// ridge one or two cells wide to a quarter or half of its faces' slope, and
// the share gives part of that back. Such a ridge's lit slope is about
// 50-65% of its drawn faces', 25-50% once the detail fades. The mesh is
// drawn at ?relief= (../cloud-layer.ts, ../relief.ts: true scale by
// default, 12x until tides-zmw.21; the detail follows, its share unchanged),
// and at 12x, where it was tuned, its full slope on the map's few-km slopes
// would stand the detail on end and black out every lee slope under a low
// Sun, so the detail is a fraction of it, softly capped.
//
// The detail fades out as the footprint grows past a few texels, and toward
// the poles, where the map's stretched rows would show as streaks (as the
// albedo's, ./poleSmoothing.ts); the mesh's own slope fades where its cells
// shrink under a few pixels and toward the poles too
// (groundDisplacement.ts groundDrawnSlope()). The ground detail
// (./groundDetail.ts) calls it on land only, before its own finer tilt, so
// the open water's glint is untouched; it adds no albedo, so the GIBS patch
// (./gibsPatch.ts) and the night lights are unaffected.
import { POLE_SMOOTH_FROM, POLE_SMOOTH_TO } from './poleSmoothing'

/** Footprints (in map texels at the equator) over which the detail fades out. */
export const RELIEF_FADE_START = 2
export const RELIEF_FADE_END = 4
/** The share of the map's finer relief about the mesh's slope. */
export const RELIEF_DETAIL = 0.3
/** Slope the detail tends to, never reaches: 45°. */
export const RELIEF_MAX_SLOPE = 1

const f = (x: number) => x.toFixed(6)

// three declares the displacement map for the vertex stage only; the
// fragment's declaration shares its uniform. It is read at the day map's uv:
// both maps cover the sphere untransformed.
export const GROUND_RELIEF_GLSL = /* glsl */ `
uniform sampler2D displacementMap;
uniform float displacementScale;
#define GROUND_RELIEF_DETAIL ${f(RELIEF_DETAIL)}

// The map's slope (rise per run, the Earth's frame, the mesh's exaggeration)
// at uv, latitude lat, the point p on the sea-level sphere, over a run of at
// least a texel, of a map width wide.
vec3 groundRelief(vec2 uv, float lat, vec3 p, float run, float texel, float width) {
  // Texels shrink east-west toward the poles: the east taps span more of
  // them, so read a coarser mip.
  float c = max(cos(radians(lat)), 0.05);
  float lod = log2(run / texel);
  vec2 d = vec2(run / (texel * width * c), 2.0 * run / (texel * width));
  float east = textureLod(displacementMap, vec2(fract(uv.x + d.x), uv.y), lod - log2(c)).r
    - textureLod(displacementMap, vec2(fract(uv.x - d.x), uv.y), lod - log2(c)).r;
  float north = textureLod(displacementMap, vec2(uv.x, min(uv.y + d.y, 1.0)), lod).r
    - textureLod(displacementMap, vec2(uv.x, max(uv.y - d.y, 0.0)), lod).r;
  vec3 n = normalize(p);
  vec3 e = normalize(cross(vec3(0.0, 1.0, 0.0), n));
  return displacementScale * (east * e + north * cross(n, e)) / (2.0 * run);
}

// The slope to shade at uv, p, seen at footprint (a pixel's width on the
// ground): the mesh's, plus the map's detail about it.
vec3 groundSlope(vec2 uv, vec3 p, float footprint, vec3 mesh) {
  float width = float(textureSize(displacementMap, 0).x);
  // A texel's width on the ground at the equator; the map is 2:1.
  float texel = 6.283185307 * length(p) / width;
  float lat = (uv.y - 0.5) * 180.0;
  float fade = (1.0 - smoothstep(${f(RELIEF_FADE_START)}, ${f(RELIEF_FADE_END)}, footprint / texel))
    * (1.0 - smoothstep(${f(POLE_SMOOTH_FROM)}, ${f(POLE_SMOOTH_TO)}, abs(lat)));
  if (fade <= 0.0) return mesh;
  vec3 detail = GROUND_RELIEF_DETAIL * (groundRelief(uv, lat, p, max(footprint, texel), texel, width) - mesh);
  float s = length(detail);
  return mesh + fade * detail / sqrt(1.0 + s * s / ${f(RELIEF_MAX_SLOPE * RELIEF_MAX_SLOPE)});
}
`
