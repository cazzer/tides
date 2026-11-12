// The planets' rock detail (tides-01v.3, shaders/planet/detail.glsl) on
// Earth's Moon (tides-ufyr.3), whose Phong material three lights itself: at
// the ship's stop its 8k map is ~40 px a texel. The patch only darkens and
// lightens diffuseColor and tilts the normal before three's lighting; the
// Sun it is lit by stays the scene's DirectionalLight (sunlight.ts), and the
// only place it reads that light is the terminator fade below.
import type { MaterialPatch } from './eclipseShadow'
import {
  DETAIL_OCTAVES,
  DETAIL_STYLES,
  LOW_QUALITY_DETAIL_OCTAVES,
} from './planetMaterials'
import detailGlsl from '../shaders/planet/detail.glsl'

/** [TUNE] As setPlanetDetail's rock: albedo contrast and relief. */
export const MOON_SURFACE_DETAIL = { strength: 0.2, bump: 0.06 }

/** [TUNE] Sun height (cos) over which the bump fades in from the terminator. */
export const MOON_DETAIL_TERMINATOR = 0.08

const VERTEX_HEAD = /* glsl */ `
varying vec3 vMoonDetailPos;
varying float vMoonDetailRadius;
`

// The sphere is centred on its origin and scaled uniformly, so its radius in
// view units is |position| through the model-view.
const VERTEX_BODY = /* glsl */ `
vMoonDetailPos = position;
vMoonDetailRadius = length((modelViewMatrix * vec4(position, 0.0)).xyz);
`

function fragmentHead(octaves: number): string {
  return /* glsl */ `
varying vec3 vMoonDetailPos;
varying float vMoonDetailRadius;
uniform mat3 normalMatrix;
#define PLANET_DETAIL_OCTAVES ${octaves}
#define MOON_DETAIL_TERMINATOR ${MOON_DETAIL_TERMINATOR.toFixed(4)}
${detailGlsl}
`
}

// After normal_fragment_maps: diffuseColor and normal are set, and three's
// lighting has yet to read them. fp takes derivatives, so it sits outside
// any non-uniform branch.
const FRAGMENT_BODY = /* glsl */ `
#ifdef USE_MAP
{
  float moonDetailFp = planetDetailFootprint(vViewPosition, normalize(vNormal), vMoonDetailRadius);
  float moonDetailTexel = PI / float(textureSize(map, 0).y);
  vec3 moonDetailN = normalize(vMoonDetailPos);
  float moonDetailD;
  vec3 moonDetailDh;
  planetDetail(moonDetailN, moonDetailFp, moonDetailTexel, moonDetailD, moonDetailDh);
  diffuseColor.rgb *= max(0.0, 1.0 + uDetailStrength * moonDetailD);
  #if NUM_DIR_LIGHTS > 0
  if (moonDetailDh != vec3(0.0)) {
    // Faded out toward the terminator, or bumps tilted sunward would
    // speckle the night side and wobble the terminator.
    float moonDetailBump = uDetailBump * smoothstep(
      0.0, MOON_DETAIL_TERMINATOR, dot(normalize(vNormal), directionalLights[0].direction));
    vec3 moonDetailLit = normalize(moonDetailN - moonDetailBump
      * (moonDetailDh - dot(moonDetailDh, moonDetailN) * moonDetailN));
    // The whole normal from the local one: normalMatrix carries the
    // inverse scale.
    normal = normalize(normalMatrix * moonDetailLit);
  }
  #endif
}
#endif
`

function inject(source: string, chunk: string, code: string): string {
  const include = `#include <${chunk}>`
  if (!source.includes(include)) {
    throw new Error(`moon detail: shader has no ${include}`)
  }
  return source.replace(include, `${include}\n${code}`)
}

/** The rock detail for a lit (Phong) material with a map; `low` is the tier. */
export function moonDetailPatch(low: boolean): MaterialPatch {
  const octaves = low ? LOW_QUALITY_DETAIL_OCTAVES : DETAIL_OCTAVES
  return {
    onBeforeCompile(shader) {
      Object.assign(shader.uniforms, {
        uDetailStyle: { value: DETAIL_STYLES.rock },
        uDetailStrength: { value: MOON_SURFACE_DETAIL.strength },
        uDetailBump: { value: MOON_SURFACE_DETAIL.bump },
      })
      shader.vertexShader = inject(VERTEX_HEAD + shader.vertexShader, 'begin_vertex', VERTEX_BODY)
      shader.fragmentShader = inject(
        inject(shader.fragmentShader, 'common', fragmentHead(octaves)),
        'normal_fragment_maps',
        FRAGMENT_BODY
      )
    },
    customProgramCacheKey: () => `moon-detail-${octaves}`,
  }
}
