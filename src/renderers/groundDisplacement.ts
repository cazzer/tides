// Earth's ground displaced at its mesh's own vertex spacing (tides-zmw.2).
// three's displacement reads the map's full-size level at each vertex, but
// the vertices sit 8–32 texels apart: a peak lands on one vertex or between
// two, so mountains alias into one-vertex needles, which change shape when
// the limb sphere (ship/limb-detail.ts) swaps in. Here each vertex reads the
// ground texture (earthDemTexture.ts) at the level whose texels match the
// mesh's rows, at the texel corner it sits on: the mean of the 2 × 2 around
// it, half shared with each neighbour, so no single vertex stands out.
//
// The limb sphere geomorphs: from its swap in, its vertices start on the
// base sphere's triangles (their heights at the base's level, flat between
// them) and blend to their own heights on the way down, so the swap doesn't
// reshape the peaks on screen. The morph is over above any ship stop, where
// the terrain floor (ship/terrain-floor.ts) takes the limb sphere's own
// ground, and the swap comes well above that on any screen
// (EARTH_LIMB_SWAP_FLOOR), so the floor never changes under the ship.
import * as THREE from 'three'
import type { MaterialPatch } from './eclipseShadow'
import { LIMB_FACET_PX, LIMB_HYSTERESIS, limbFacetPx, type SphereSegments } from '../ship/limb-detail'

/** The texture level whose rows match a mesh's `meshRows` rows, for a
 * texture `textureRows` tall. */
export function groundLod(textureRows: number, meshRows: number): number {
  return Math.max(0, Math.log2(textureRows / meshRows))
}

/** The base sphere's facets (limbFacetPx) where the morph begins, just past
 * the limb sphere's swap (at LIMB_FACET_PX, give or take the limb view's 5%
 * hysteresis), and where it ends. */
export const MORPH_START_PX = 1.1 * LIMB_FACET_PX
export const MORPH_END_PX = 2

/**
 * Below this altitude over the sea, the morph is over whatever the screen:
 * on a short one the facets reach MORPH_END_PX only near the ground, or
 * never. It is just over the highest stop on either sphere's floor (0.066,
 * over the Karakoram; a test checks), and the morph runs over the altitudes
 * up to MORPH_TOP.
 */
export const MORPH_FLOOR = 0.07
export const MORPH_TOP = 2 * MORPH_FLOOR

/**
 * Below this altitude Earth's ground is always the limb sphere
 * (wantsLimbSphere's swapFloor): on a short screen the base sphere's facets
 * pass LIMB_FACET_PX only near the ground, or never, where a swap would move
 * the floor under the ship and cut the morph short. The limb view moves on
 * in LIMB_HYSTERESIS steps, so the swap comes at MORPH_TOP or above.
 */
export const EARTH_LIMB_SWAP_FLOOR = LIMB_HYSTERESIS * MORPH_TOP

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * How far the limb sphere's ground is blended toward the base sphere's
 * (`base` segments) seen from `eyeDistance` from the centre of a sphere of
 * `radius`, over `screenPx` rows with a `fovDeg` vertical FOV: 1 at the
 * swap, 0 by MORPH_END_PX's facets or MORPH_FLOOR.
 */
export function groundMorph(
  base: SphereSegments,
  eyeDistance: number,
  radius: number,
  screenPx: number,
  fovDeg: number
): number {
  if (eyeDistance <= radius) return 0
  const facets = limbFacetPx(base, eyeDistance / radius, screenPx, fovDeg)
  const byFacets = 1 - smoothstep(MORPH_START_PX, MORPH_END_PX, facets)
  return Math.min(byFacets, smoothstep(MORPH_FLOOR, MORPH_TOP, eyeDistance - radius))
}

const f = (x: number) => x.toFixed(1)

// The base sphere's triangles as THREE.SphereGeometry lays them out:
// vertex columns east from the date line, rows south from the north pole,
// each quad split from its north-west corner to its south-east, and each
// pole's vertices shifted half a column (east at the north, west at the
// south). Its polar rows are fans: one triangle per quad with its apex on
// the pole, where heights blend toward the apex along the meridians.
const vertexHead = ([width, height]: SphereSegments) => /* glsl */ `
uniform sampler2D uGroundHeights;
uniform float uGroundLod;
uniform float uGroundBaseLod;
uniform float uGroundMorph;
#define GROUND_BASE vec2(${f(width)}, ${f(height)})
float groundBaseVertex(vec2 vertex, float lod) {
  float shift = vertex.y == 0.0 ? 0.5 : (vertex.y == GROUND_BASE.y ? -0.5 : 0.0);
  vec2 uv = vec2((vertex.x + shift) / GROUND_BASE.x, 1.0 - vertex.y / GROUND_BASE.y);
  return textureLod(uGroundHeights, uv, lod).r;
}
float groundBaseHeight(vec2 uv) {
  float lod = uGroundBaseLod;
  vec2 cell = vec2(uv.x, 1.0 - uv.y) * GROUND_BASE;
  vec2 i = min(floor(cell), GROUND_BASE - 1.0);
  vec2 t = cell - i;
  float nw = groundBaseVertex(i, lod);
  float se = groundBaseVertex(i + 1.0, lod);
  if (i.y == 0.0) return mix(nw, mix(groundBaseVertex(i + vec2(0.0, 1.0), lod), se, t.x), t.y);
  if (i.y == GROUND_BASE.y - 1.0) return mix(mix(nw, groundBaseVertex(i + vec2(1.0, 0.0), lod), t.x), se, t.y);
  bool east = t.y <= t.x;
  float mid = groundBaseVertex(i + (east ? vec2(1.0, 0.0) : vec2(0.0, 1.0)), lod);
  vec2 w = east ? t : t.yx;
  return nw + w.x * (mid - nw) + w.y * (se - mid);
}
float groundHeight(vec2 uv) {
  float own = textureLod(uGroundHeights, uv, uGroundLod).r;
  if (uGroundMorph > 0.0) own = mix(own, groundBaseHeight(uv), uGroundMorph);
  return own;
}
`

const VERTEX_BODY = /* glsl */ `
#ifdef USE_DISPLACEMENTMAP
  transformed += normalize(objectNormal) * (groundHeight(vDisplacementMapUv) * displacementScale + displacementBias);
#endif
`

function replace(source: string, chunk: string, code: string): string {
  const include = `#include <${chunk}>`
  if (!source.includes(include)) throw new Error(`ground displacement: shader has no ${include}`)
  return source.replace(include, code)
}

export interface GroundDisplacement {
  /** For the ground's material, with a displacementMap set (it keeps that
   * map for the fragment's relief and its uv). */
  patch: MaterialPatch
  /** The ground texture, the drawn mesh's and the base sphere's levels
   * (groundLod) and the morph (groundMorph; 0 off the limb sphere), set
   * before each draw. */
  uniforms: {
    uGroundHeights: THREE.IUniform<THREE.Texture | null>
    uGroundLod: THREE.IUniform<number>
    uGroundBaseLod: THREE.IUniform<number>
    uGroundMorph: THREE.IUniform<number>
  }
}

/** The ground's displacement for a mesh whose base sphere has `base` segments. */
export function createGroundDisplacement(base: SphereSegments): GroundDisplacement {
  const uniforms = {
    uGroundHeights: { value: null },
    uGroundLod: { value: 0 },
    uGroundBaseLod: { value: 0 },
    uGroundMorph: { value: 0 },
  }
  return {
    uniforms,
    patch: {
      onBeforeCompile(shader) {
        Object.assign(shader.uniforms, uniforms)
        shader.vertexShader = replace(
          replace(shader.vertexShader, 'displacementmap_pars_vertex', `#include <displacementmap_pars_vertex>\n${vertexHead(base)}`),
          'displacementmap_vertex',
          VERTEX_BODY
        )
      },
      customProgramCacheKey: () => `ground-displacement-${base.join('x')}`,
    },
  }
}
