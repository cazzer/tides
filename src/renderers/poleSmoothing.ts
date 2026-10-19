// The poles of the equirectangular Earth maps (tides-9jn.4). The day map's
// sea ice, and the static clouds, were stretched from sparse polar imagery
// into streaks that run along meridians; on the globe they converge on the
// pole as a radial pinch, with the map's 180° seam as a bright spoke. Near
// the poles the maps are averaged around the parallel over a fixed distance
// on the ground, which smooths the streaks away and leaves the rest alone.
//
// The ground's Phong material gets this through composePatches; the cloud
// layer (./cloudShaders.ts) uses POLE_SMOOTHING_GLSL directly.
import type { MaterialPatch } from './eclipseShadow'

/** Latitudes (degrees) over which smoothing fades in toward the pole. */
export const POLE_SMOOTH_FROM = 80
export const POLE_SMOOTH_TO = 87
/** Half-width of the average around the parallel, in degrees of arc on the
 * ground. */
export const POLE_SMOOTH_ARC = 1.6
/** Texture taps across the average: the ground's day map, and the cloud
 * map (read many times a pixel by the cloud march, so fewer). */
export const POLE_SMOOTH_TAPS = 12
export const POLE_SMOOTH_CLOUD_TAPS = 6

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** How much of a texel at this latitude (degrees) comes from the average. */
export function poleSmoothing(latDeg: number): number {
  return smoothstep(POLE_SMOOTH_FROM, POLE_SMOOTH_TO, Math.abs(latDeg))
}

/** Half-width of the average in texture u: POLE_SMOOTH_ARC of ground is
 * more longitude the nearer the pole, up to the whole parallel. */
export function poleSmoothingSpanU(latDeg: number): number {
  const c = Math.cos((Math.abs(latDeg) * Math.PI) / 180)
  return Math.min(POLE_SMOOTH_ARC / Math.max(c, 1e-4), 180) / 360
}

const f = (x: number) => x.toFixed(6)

/** GLSL: `name`(map, uv, lod, colour) returns `colour` (the map's plain
 * sample at uv) blended toward the average around the parallel. lod is the
 * mip level for the average's taps. */
export function poleSmoothingGlsl(name: string, taps: number): string {
  return /* glsl */ `
vec4 ${name}(sampler2D map, vec2 uv, float lod, vec4 colour) {
  float lat = (uv.y - 0.5) * 180.0;
  float w = smoothstep(${f(POLE_SMOOTH_FROM)}, ${f(POLE_SMOOTH_TO)}, abs(lat));
  if (w <= 0.0) return colour;
  float span = min(${f(POLE_SMOOTH_ARC)} / max(cos(radians(abs(lat))), 1e-4), 180.0) / 360.0;
  vec4 sum = vec4(0.0);
  for (int i = 0; i < ${taps}; i++) {
    float o = (float(i) / ${f(taps - 1)} * 2.0 - 1.0) * span;
    sum += textureLod(map, vec2(fract(uv.x + o), uv.y), lod);
  }
  return mix(colour, sum / ${f(taps)}, w);
}
`
}

/** The mip level (log2 texels) whose texels span about a third of the
 * average's width, for a map `width` texels around. */
export function poleSmoothingLod(width: number): number {
  return Math.log2((width * (2 * POLE_SMOOTH_ARC)) / 3 / 360)
}

function inject(source: string, chunk: string, code: string): string {
  const include = `#include <${chunk}>`
  if (!source.includes(include)) {
    throw new Error(`pole smoothing: shader has no ${include}`)
  }
  return source.replace(include, code)
}

// The map sample, smoothed near the poles. Taps are a mip about a third of
// the average's width, or coarser if the pixel is (judged by v alone: u's
// derivatives blow up at the pole, which is what picked too coarse a mip).
const MAP_FRAGMENT = /* glsl */ `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  {
    vec2 size = vec2(textureSize(map, 0));
    float tapLod = max(
      log2(size.x) + ${f(poleSmoothingLod(1))},
      log2(max(fwidth(vMapUv.y) * size.y, 1.0))
    );
    sampledDiffuseColor = poleSmoothed(map, vMapUv, tapLod, sampledDiffuseColor);
  }
  diffuseColor *= sampledDiffuseColor;
#endif
`

/** For the ground's Phong material: its day map, smoothed at the poles. */
export function poleSmoothingPatch(): MaterialPatch {
  return {
    onBeforeCompile(shader) {
      shader.fragmentShader = inject(
        shader.fragmentShader.replace(
          '#include <common>',
          `#include <common>\n${poleSmoothingGlsl('poleSmoothed', POLE_SMOOTH_TAPS)}`
        ),
        'map_fragment',
        MAP_FRAGMENT
      )
    },
    customProgramCacheKey: () => 'pole-smoothing',
  }
}
