// The date's sea ice in the globe's ground shader (tides-6ru.2): NSIDC's 2025
// ice for the sim date's day of the year, drawn by the ground itself rather
// than a shell floating over it, so it lies on the ground at any height on
// every tier (the low tier has no streamed tiles to carry it near the ground,
// tides-6ru.4), takes the clouds' shadows and the Moon's as the ground does
// (tides-6ru.3), and meets the streamed tiles' ice (./surface/tile-ice.ts)
// with no seam: the same layers, tap and maths (./seaIceLayers.ts).
//
// No texture unit of its own: the grids are two layers of the sea's texture
// array the water already binds (uWaterSea), and the sea is the ground's own
// elevation map (displacementMap), which the ground detail's relief already
// reads in the fragment stage. Not the specular map: it is 0 over the day
// map's all-year Arctic ice, which is sea the year's ice may have left.
//
// As the tiles': the alpha is the sea times the most of the cover and the
// all-year ice, and the colour the ice's where the cover is, open water's
// where only the all-year ice is (the day map's ice repainted as the sea it
// is that week; flat, no glint). The water's glint and body give way under
// it (specularStrength), and the ground detail treats the ice as ice and the
// repainted sea as no land (./groundDetail.ts, SEA_ICE_GROUND).
//
// Placement: the tap after specularmap_fragment, so before the ground
// detail's normal_fragment_maps code and the water's body (just before
// emissivemap_fragment), which read specularStrength; the colour just after
// emissivemap_fragment, before the lights take diffuseColor. The array's
// declaration is the water's (composed before this patch); the tap is in
// main(), so the declaration's place among the heads doesn't matter.
//
// Switched by uniforms only (one program, no variant): uSeaIceOn while the
// ice is attached and its frames written, uSeaIceGround while the ground
// draws it (outside the seasons tour, whose shell draws it from afar).
import type * as THREE from 'three'
import { DEM_METRES_PER_UNIT } from '../earth-dem'
import type { MaterialPatch } from './eclipseShadow'
import { SEA_ICE_ALBEDO_GLSL, SEA_ICE_OVER_GLSL, SEA_ICE_TAP_GLSL, SEA_ICE_TAP_HEAD, seaIceSurface } from './seaIceLayers'
import { WATER_SEA_UNIFORM } from './waterClimate'

const VERTEX_HEAD = /* glsl */ `
varying vec3 vSeaIceUp;
`

const VERTEX_BODY = /* glsl */ `
vSeaIceUp = position;
`

const FRAGMENT_HEAD = /* glsl */ `
#define SEA_ICE_GROUND
varying vec3 vSeaIceUp;
uniform float uSeaIceOn;
uniform float uSeaIceGround;
uniform float uSeaIceMix;
// The ice's (or the repainted sea's) share of the albedo, the ice's share
// of its colour, and the repainted sea's share of the albedo.
float seaIceAlpha = 0.0;
float seaIceShare = 0.0;
float seaIceOpen = 0.0;
${SEA_ICE_TAP_HEAD}
`

// Only poleward of 30°: the grids reach no further. The elevation's level
// by the map's north-south slope alone: toward the poles its columns
// converge, and the east-west slope would pick a level whose texels average
// the coast's land into the sea, cutting the ice back by hundreds of km in
// blocks. The derivative before the branch on the place.
const BODY = /* glsl */ `
#if defined(USE_MAP) && defined(GROUND_RELIEF)
if (uSeaIceOn * uSeaIceGround > 0.0) {
  float seaIceDemV = float(textureSize(displacementMap, 0).y) * max(abs(dFdx(vMapUv.y)), abs(dFdy(vMapUv.y)));
  float seaIceDemLod = max(log2(max(seaIceDemV, 1e-6)), 0.0);
  vec3 seaIceUp = normalize(vSeaIceUp);
  if (abs(seaIceUp.y) > 0.5) {
    ${SEA_ICE_TAP_GLSL('seaIceUp')}
    ${SEA_ICE_OVER_GLSL(`textureLod(displacementMap, vMapUv, seaIceDemLod).r * ${DEM_METRES_PER_UNIT.toFixed(6)}`)}
    specularStrength *= 1.0 - seaIceAlpha;
    seaIceOpen = seaIceAlpha * (1.0 - seaIceShare);
  }
}
#endif
`

const COLOUR = /* glsl */ `
if (seaIceAlpha > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, ${SEA_ICE_ALBEDO_GLSL}, seaIceAlpha);
`

/** The patch's GLSL (the test checks it). */
export const SEA_ICE_GROUND_GLSL = { vertexHead: VERTEX_HEAD, vertexBody: VERTEX_BODY, head: FRAGMENT_HEAD, body: BODY, colour: COLOUR }

function inject(source: string, chunk: string, code: string): string {
  const include = `#include <${chunk}>`
  if (!source.includes(include)) throw new Error(`sea ice ground: shader has no ${include}`)
  return source.replace(include, `${include}\n${code}`)
}

/**
 * The date's sea ice on the globe's ground, reading the layers through
 * `sea`, the water's uWaterSea (the same uniform object). Composed after the
 * water's patch, which declares the array; alone, it declares it itself.
 */
export function seaIceGroundPatch(sea: THREE.IUniform<THREE.DataArrayTexture>): MaterialPatch {
  const uniforms = {
    uWaterSea: sea,
    uSeaIceOn: seaIceSurface.on,
    uSeaIceGround: seaIceSurface.ground,
    uSeaIceMix: seaIceSurface.mix,
  }
  return {
    onBeforeCompile(shader) {
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = inject(VERTEX_HEAD + shader.vertexShader, 'begin_vertex', VERTEX_BODY)
      const head = shader.fragmentShader.includes(WATER_SEA_UNIFORM) ? FRAGMENT_HEAD : `${WATER_SEA_UNIFORM}\n${FRAGMENT_HEAD}`
      shader.fragmentShader = inject(
        inject(inject(shader.fragmentShader, 'common', head), 'specularmap_fragment', BODY),
        'emissivemap_fragment',
        COLOUR
      )
    },
    customProgramCacheKey: () => 'sea-ice-ground',
  }
}
