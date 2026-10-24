// Aerial perspective on the ground from inside the atmosphere (tides-zmw.5).
// From inside its shell the atmosphere used to add each ray's whole haze over
// whatever the ray met (columnAheadOverSea(), shaders/atmosphere/haze.glsl):
// a function of the ray's direction alone, so near ground facing the horizon
// took the horizon's full haze, which the additive blend washed out to white
// over bright land, and ridges standing above the horizon took less than the
// ground in front of them. There the atmosphere now stops at the ground
// (pickShellFaces' stopAtGround), and the ground lays the same haze over
// itself (groundHaze()): a share 1 - exp(-s / L) of it at distance s, over
// the ground's colour, so near ground clears and far ground fades to the
// colour of the sky above its horizon. Over the dark sea that is what the
// atmosphere drew, so the sea horizon's seam with the sky (tides-01v.8.20)
// holds.
//
// L, the haze's reach. The model's own would be the column ahead of a level
// ray from its base over the base's density (grazing / 2 = sqrt(pi R H / 2),
// about 0.12 R): that leaves the sea horizon, seen from the ship's stop, a
// third of its haze, a step under the sky's. So L is set by the nearest the
// sea horizon comes instead: from the stop over the sea (EARTH_GROUND_CLEARANCE
// up) it lies sqrt(2 R g) off, GROUND_HAZE_E reach lengths (95% of the haze);
// every other horizon lies further.
//
// Only for the ship's camera inside the shell (update()); everywhere else the
// atmosphere still draws over the ground, so from outside nothing changes.
// Spread through composePatches onto the ground's Phong material.
import type * as THREE from 'three'
import hazeGlsl from '../shaders/atmosphere/haze.glsl'
import {
  ATMOSPHERE_DUSK,
  ATMOSPHERE_GAIN,
  ATMOSPHERE_OUTER,
  ATMOSPHERE_SCALE_HEIGHT,
  ATMOSPHERE_SKY,
  ATMOSPHERE_SURFACE,
  insideShell,
} from './earth-shells'
import { EARTH_GROUND_CLEARANCE } from '../ship/ship-bodies'
import type { MaterialPatch } from './eclipseShadow'

/** Reach lengths to the nearest sea horizon: e^-3, 95% of the haze there. */
export const GROUND_HAZE_E = 3

/** The haze's reach, as a fraction of the sea level's radius (see above). */
export function groundHazeLength(seaLevel: number): number {
  return Math.sqrt(2 * seaLevel * EARTH_GROUND_CLEARANCE) / GROUND_HAZE_E / seaLevel
}

const f = (x: number) => x.toFixed(6)
const v3 = (c: readonly [number, number, number]) => `vec3(${c.map(f).join(', ')})`

const VERTEX_HEAD = /* glsl */ `
varying vec3 vGroundHazeRay;
varying vec3 vGroundHazeEye;
`

// In the mesh's frame, from view space (modelViewMatrix, formed in double):
// world positions, thousands of units out in flight, would round away the
// eye's few metres off the ground. The Earth's group is unscaled, so the
// transpose inverts the rotation, as in shaders/shell/vertex.glsl.
const VERTEX_BODY = /* glsl */ `
vGroundHazeRay = transpose(mat3(modelViewMatrix)) * mvPosition.xyz;
vGroundHazeEye = -(transpose(mat3(modelViewMatrix)) * modelViewMatrix[3].xyz);
`

// The atmosphere's uniforms, as macros over the haze's own for haze.glsl,
// dropped after it: other patches declare a uSeaLevel of their own.
const fragmentHead = (length: number) => /* glsl */ `
uniform float uGroundHaze;
uniform float uGroundHazeSeaLevel;
uniform vec3 uGroundHazeSun;
varying vec3 vGroundHazeRay;
varying vec3 vGroundHazeEye;

#define GROUND_HAZE_LENGTH ${f(length)}
#define uSeaLevel uGroundHazeSeaLevel
#define uSurface (uGroundHazeSeaLevel * ${f(ATMOSPHERE_SURFACE)})
#define uScaleHeight (uGroundHazeSeaLevel * ${f(ATMOSPHERE_SCALE_HEIGHT)})
#define uGain ${f(ATMOSPHERE_GAIN)}
#define uSky ${v3(ATMOSPHERE_SKY)}
#define uDusk ${v3(ATMOSPHERE_DUSK)}
${hazeGlsl}

// rgb: the haze the atmosphere draws along this ray from inside; a: the
// share of it in front of ground s away.
vec4 groundHaze(vec3 eye, vec3 dir, float s, out float cover) {
  float grazing = sqrt(6.2831853 * uSurface * uScaleHeight);
  vec3 at;
  float column = columnAheadOverSea(eye, dir, grazing, at);
  float share = 1.0 - exp(-s / (GROUND_HAZE_LENGTH * uSeaLevel));
  // As opaque as its column is long next to a level ray's from the base
  // (hazeAbove(), half the grazing line): the horizon's hides the ground, a
  // steep ray's, faint over the disc, hardly. Toward the top of the shell,
  // where the atmosphere goes back to adding its haze over the ground, it
  // eases out, as the clouds' share does (cloudShaders.ts cloudHazeFront()).
  float outer = uSeaLevel * ${f(ATMOSPHERE_OUTER)};
  cover = share * min(2.0 * column / grazing, 1.0)
    * (1.0 - smoothstep(outer - 2.0 * uScaleHeight, outer, length(eye)));
  return vec4(hazeGlow(column, grazing, at, uGroundHazeSun), share);
}
#undef uSeaLevel
#undef uSurface
#undef uScaleHeight
#undef uGain
#undef uSky
#undef uDusk
`

// After the output transforms, the haze through them as the atmosphere's own
// output, over the ground's colour rather than added to it: added, as the
// atmosphere's blend adds it to the sky, it washed bright ground out to
// white. Far off, the ground takes the colour of the sky above its horizon.
const FRAGMENT_BODY = /* glsl */ `
if (uGroundHaze > 0.0) {
  vec4 groundHazeLit = gl_FragColor;
  float cover;
  vec4 haze = groundHaze(vGroundHazeEye, normalize(vGroundHazeRay), length(vViewPosition), cover);
  gl_FragColor = vec4(haze.rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  groundHazeLit.rgb = groundHazeLit.rgb * (1.0 - cover) + gl_FragColor.rgb * haze.a;
  gl_FragColor = groundHazeLit;
}
`

function inject(source: string, chunk: string, code: string): string {
  const include = `#include <${chunk}>`
  if (!source.includes(include)) {
    throw new Error(`ground haze: shader has no ${include}`)
  }
  return source.replace(include, `${include}\n${code}`)
}

export interface GroundHaze {
  patch: MaterialPatch
  /** The ground mesh's onBeforeRender: whether this camera takes it. */
  update(ground: THREE.Object3D, camera: THREE.Camera): void
}

/** `sun`: the Sun's direction in the ground mesh's frame, kept up to date by
 * the caller (the cloud layer's uSunDir). `seaLevel`: the ground's radius. */
export function createGroundHaze(sun: THREE.IUniform<THREE.Vector3>, seaLevel: number): GroundHaze {
  const uniforms = {
    uGroundHaze: { value: 0 },
    uGroundHazeSeaLevel: { value: seaLevel },
    uGroundHazeSun: sun,
  }
  return {
    patch: {
      onBeforeCompile(shader) {
        Object.assign(shader.uniforms, uniforms)
        shader.vertexShader = inject(VERTEX_HEAD + shader.vertexShader, 'project_vertex', VERTEX_BODY)
        shader.fragmentShader = inject(
          inject(shader.fragmentShader, 'common', fragmentHead(groundHazeLength(seaLevel))),
          'colorspace_fragment',
          FRAGMENT_BODY
        )
      },
      customProgramCacheKey: () => 'ground-haze',
    },
    update(ground, camera) {
      uniforms.uGroundHaze.value = insideShell(ground, camera, seaLevel * ATMOSPHERE_OUTER) ? 1 : 0
    },
  }
}
