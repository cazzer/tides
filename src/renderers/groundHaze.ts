// Aerial perspective on the ground from inside the atmosphere (tides-zmw.5).
// From inside its shell the atmosphere used to add each ray's whole haze over
// whatever the ray met (columnAheadOverSea(), shaders/atmosphere/haze.glsl):
// a function of the ray's direction alone, so near ground facing the horizon
// took the horizon's full haze, which the additive blend washed out to white
// over bright land, and ridges standing above the horizon took less than the
// ground in front of them. Under the cloud shell's top (groundHazeTop(), where
// the clouds add the haze in front of themselves) the atmosphere now stops at
// the ground (pickShellFaces' stopAtGround), and the ground lays haze over
// itself (groundHaze(), groundHazeWeights()): a share 1 - exp(-(tau / L)^P)
// of a horizon's haze, tau the optical depth of the segment from the eye to
// the ground (groundHazeDepth()), which also hides as much of the ground's
// colour as the haze is a horizon's. Not a true over: the haze keeps its full
// brightness at the share, so far ground takes the colour of the sky above
// its horizon, and near ground clears. Toward the cloud shell's top both
// weights ease, as the clouds' do (cloudShaders.ts cloudHazeFront()), to all
// of the haze along the eye's own ray, added, which is what the atmosphere
// draws over the ground above it.
//
// The amount, from the segment alone (tides-zmw.16). Under the haze's base
// the density is the base's (columnAhead()'s convention), so there tau is
// the distance; above it the segment thins (Simpson's rule over the
// exponential density, three samples), so high ground and the air between
// it and a high eye clear. L is set by the nearest the sea horizon comes:
// from the stop over the sea (EARTH_GROUND_CLEARANCE up) it lies sqrt(2 R g)
// off, all under the base, at (tau / L)^P = GROUND_HAZE_E (95% of the haze);
// every other horizon lies further. (The model's own reach, the column ahead
// of a level ray from the base over the base's density, grazing / 2 =
// sqrt(pi R H / 2), about 0.12 R, would leave that horizon a third of its
// haze, a step under the sky's.) The power, GROUND_HAZE_POWER, keeps the
// near ground clearer than a plain exponential that reaches the same share
// at the horizon: 1.3% of the haze 0.01 units off, 5% at 0.02 (that one 18%
// and 32%).
//
// The colour, from the sky at the horizon that ground at the point's height
// would make: the column ahead of the ray from the eye tangent to the sphere
// through the point, in the eye's ray's vertical plane (level where the point
// stands above the eye). Over the sea that is the sea's own horizon, the
// sky's ray just above it, where columnAheadOverSea() is columnAhead(), so
// the sea horizon's seam with the sky (tides-01v.8.20) holds; far land takes
// the sky over its own horizon. Its share of the grazing line's is how much
// of the ground's colour the haze hides. Not the eye's own ray, as tides-zmw.5
// had: that column depends on the eye's height and the ray's depression, not
// on the ground point, so the haze laid on a fixed point changed as the eye
// bobbed over the terrain at the stop, and the ground's shading crawled. The
// tangent's dip moves little with the eye, and the segment's depth with it.
// Only the ease toward the shell's top still takes the eye's own ray, which
// is the atmosphere's draw there.
//
// Only for the ship's camera under the cloud shell's top (update()); elsewhere
// the atmosphere still draws over the ground, so from outside nothing
// changes. Spread through composePatches onto the ground's Phong material.
import * as THREE from 'three'
import hazeGlsl from '../shaders/atmosphere/haze.glsl'
import {
  ATMOSPHERE_DUSK,
  ATMOSPHERE_GAIN,
  ATMOSPHERE_SCALE_HEIGHT,
  ATMOSPHERE_SKY,
  ATMOSPHERE_SURFACE,
  groundHazeTop,
  insideShell,
} from './earth-shells'
import { EARTH_GROUND_CLEARANCE } from '../ship/ship-bodies'
import type { MaterialPatch } from './eclipseShadow'

/** Reach lengths to the nearest sea horizon: e^-3, 95% of the haze there. */
export const GROUND_HAZE_E = 3

/** The haze's share is 1 - exp(-(tau / L)^this): a plain exponential's
 * share at the horizon, with clearer near ground. */
export const GROUND_HAZE_POWER = 2

/** The haze's reach L (scene units) over a sea level of this radius. */
export function groundHazeLength(seaLevel: number): number {
  return Math.sqrt(2 * seaLevel * EARTH_GROUND_CLEARANCE) / GROUND_HAZE_E ** (1 / GROUND_HAZE_POWER)
}

/** The haze's density at radius r, the base's below it (groundHazeDensity()). */
function hazeDensity(r: number, seaLevel: number): number {
  const base = seaLevel * ATMOSPHERE_SURFACE
  return Math.exp(-Math.max(r - base, 0) / (seaLevel * ATMOSPHERE_SCALE_HEIGHT))
}

/**
 * The segment's optical depth over the base's density, as the shader takes
 * it (groundHaze(); the test pins the two together): from `eye` (from the
 * centre) along `ray`, to the ground.
 */
export function groundHazeDepth(eye: THREE.Vector3, ray: THREE.Vector3, seaLevel: number): number {
  const mid = eye.clone().addScaledVector(ray, 0.5).length()
  const end = eye.clone().add(ray).length()
  return (
    (ray.length() *
      (hazeDensity(eye.length(), seaLevel) + 4 * hazeDensity(mid, seaLevel) + hazeDensity(end, seaLevel))) /
    6
  )
}

/**
 * The shader's weights (groundHaze() below; the test pins the two
 * together), for an eye `eye` from the centre, ground at optical `depth`
 * (groundHazeDepth()) under a horizon whose haze column is `columnShare` of
 * the grazing line's: `cover`, the share of the ground's colour the haze
 * hides, `haze`, the share of the haze laid over it, and `own`, the share of
 * that haze's colour taken from the eye's own ray (the ease to the
 * atmosphere's draw at the cloud shell's top).
 */
export function groundHazeWeights(
  eye: number,
  depth: number,
  columnShare: number,
  seaLevel: number,
  flat: boolean
): { cover: number; haze: number; own: number } {
  const share = 1 - Math.exp(-((depth / groundHazeLength(seaLevel)) ** GROUND_HAZE_POWER))
  const top = seaLevel + groundHazeTop(flat)
  const ease = THREE.MathUtils.smoothstep(eye, top - 2 * seaLevel * ATMOSPHERE_SCALE_HEIGHT, top)
  const haze = share + (1 - share) * ease
  return {
    cover: share * Math.min(2 * columnShare, 1) * (1 - ease),
    haze,
    own: ease > 0 ? ease / haze : 0,
  }
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
const FRAGMENT_HEAD = /* glsl */ `
uniform float uGroundHaze;
uniform float uGroundHazeSeaLevel;
uniform float uGroundHazeLength;
uniform float uGroundHazeTop;
uniform vec3 uGroundHazeSun;
varying vec3 vGroundHazeRay;
varying vec3 vGroundHazeEye;

#define uSeaLevel uGroundHazeSeaLevel
#define uSurface (uGroundHazeSeaLevel * ${f(ATMOSPHERE_SURFACE)})
#define uScaleHeight (uGroundHazeSeaLevel * ${f(ATMOSPHERE_SCALE_HEIGHT)})
#define uGain ${f(ATMOSPHERE_GAIN)}
#define uSky ${v3(ATMOSPHERE_SKY)}
#define uDusk ${v3(ATMOSPHERE_DUSK)}
${hazeGlsl}

#define GROUND_HAZE_POWER ${f(GROUND_HAZE_POWER)}

// The haze's density, the base's below it, as columnAhead() counts an eye.
float groundHazeDensity(float r) {
  return exp(-max(r - uSurface, 0.0) / uScaleHeight);
}

// From the eye along ray (eye to ground, in the mesh's frame). rgb: the haze
// the atmosphere draws over the horizon that ground at the point's height
// would make (eased to the eye's own ray's at the shell's top); a: the share
// of it laid over the ground, from the segment's optical depth; cover: the
// share of the ground it hides, as much as the haze is a horizon's (its
// column next to a level ray's from the base, hazeAbove(), half the grazing
// line). Mirrored by groundHazeDepth() and groundHazeWeights().
vec4 groundHaze(vec3 eye, vec3 ray, out float cover) {
  float grazing = sqrt(6.2831853 * uSurface * uScaleHeight);
  float s = length(ray);
  vec3 dir = ray / s;
  float rE = length(eye);
  float rP = length(eye + ray);
  float tau = s * (groundHazeDensity(rE) + 4.0 * groundHazeDensity(length(eye + 0.5 * ray)) + groundHazeDensity(rP)) / 6.0;
  float share = 1.0 - exp(-pow(tau / uGroundHazeLength, GROUND_HAZE_POWER));
  // The ray tangent to the sphere through the point, in the eye's ray's
  // vertical plane (any across it looking straight down: that moves only at).
  vec3 up = eye / rE;
  vec3 across = dir - up * dot(dir, up);
  float a2 = dot(across, across);
  across = a2 > 1e-10 ? across * inversesqrt(a2) : normalize(cross(up, abs(up.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
  float dip2 = clamp((rE - rP) * (rE + rP) / (rE * rE), 0.0, 1.0);
  vec3 at;
  float column = columnAhead(eye, across * sqrt(1.0 - dip2) - up * sqrt(dip2), grazing, at);
  float ease = smoothstep(uGroundHazeTop - 2.0 * uScaleHeight, uGroundHazeTop, rE);
  float haze = mix(share, 1.0, ease);
  vec3 glow = hazeGlow(column, grazing, at, uGroundHazeSun);
  if (ease > 0.0) {
    vec3 atOwn;
    float own = columnAheadOverSea(eye, dir, grazing, atOwn);
    glow = mix(glow, hazeGlow(own, grazing, atOwn, uGroundHazeSun), ease / haze);
  }
  cover = share * min(2.0 * column / grazing, 1.0) * (1.0 - ease);
  return vec4(glow, haze);
}
#undef GROUND_HAZE_POWER
#undef uSeaLevel
#undef uSurface
#undef uScaleHeight
#undef uGain
#undef uSky
#undef uDusk
`

// After the output transforms, the haze through them as the atmosphere's own
// output.
const FRAGMENT_BODY = /* glsl */ `
if (uGroundHaze > 0.0) {
  vec4 groundHazeLit = gl_FragColor;
  float cover;
  vec4 haze = groundHaze(vGroundHazeEye, vGroundHazeRay, cover);
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
 * the caller (the cloud layer's uSunDir, while the atmosphere takes
 * sunDirectionLocal(timestamp): the pairing the clouds' haze relies on too).
 * `seaLevel`: the ground's radius.
 * `flat`: the cloud shell is the low tier's (groundHazeTop()). */
export function createGroundHaze(
  sun: THREE.IUniform<THREE.Vector3>,
  seaLevel: number,
  flat: boolean
): GroundHaze {
  const top = seaLevel + groundHazeTop(flat)
  const uniforms = {
    uGroundHaze: { value: 0 },
    uGroundHazeSeaLevel: { value: seaLevel },
    uGroundHazeLength: { value: groundHazeLength(seaLevel) },
    uGroundHazeTop: { value: top },
    uGroundHazeSun: sun,
  }
  return {
    patch: {
      onBeforeCompile(shader) {
        Object.assign(shader.uniforms, uniforms)
        shader.vertexShader = inject(VERTEX_HEAD + shader.vertexShader, 'project_vertex', VERTEX_BODY)
        shader.fragmentShader = inject(
          inject(shader.fragmentShader, 'common', FRAGMENT_HEAD),
          'colorspace_fragment',
          FRAGMENT_BODY
        )
      },
      customProgramCacheKey: () => 'ground-haze',
    },
    update(ground, camera) {
      uniforms.uGroundHaze.value = insideShell(ground, camera, top) ? 1 : 0
    },
  }
}
