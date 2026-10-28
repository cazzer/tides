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
// The amount, from the segment alone (tides-zmw.16): its optical depth tau
// through the true air (the sunlight's scale height, cloud-layer.ts
// SCALE_HEIGHT_KM, from the sea up: tides-d9f.3), by Simpson's rule over
// the exponential density, three samples, so high ground and the air
// between it and a high eye clear. (It took the shell's density, held at
// the base's under the base, 76 km up: every eye under it saw through the
// same thick air, so from 20 to 50 km the near sea and land paled as at
// the stop.) L is set by the nearest the sea horizon comes: from the stop
// over the sea (EARTH_GROUND_CLEARANCE up) it lies sqrt(2 R g) off, at
// (tau / L)^P = GROUND_HAZE_E (95% of the haze); every other horizon lies
// further, through more of the dense air low down. The power,
// GROUND_HAZE_POWER, keeps the near ground clearer than a plain exponential
// that reaches the same share at the horizon. From higher the haze gathers
// toward the horizon: from 20 km ground 100 km off takes a few percent,
// where the base's density laid a quarter.
//
// The colour, from the sky at the horizon that ground at the point's height
// would make: the column ahead of the ray from the eye tangent to the sphere
// through the point, in the eye's ray's vertical plane (level where the point
// stands above the eye). Over the sea that is the sea's own horizon, the
// sky's ray just above it, where columnAheadOverSea() is columnAhead(), so
// the sea horizon's seam with the sky (tides-01v.8.20) holds; far land takes
// the sky over its own horizon. Its share of half the grazing line's (a level
// ray's from the base), up to all, is how much of the ground's colour the
// haze hides. Not the eye's own ray, as tides-zmw.5 had: that column depends
// on the eye's height and the ray's depression, not on the ground point, so
// the haze laid on a fixed point changed as the eye bobbed over the terrain
// at the stop, and the ground's shading crawled. The tangent's dip still
// moves with the eye: a 0.004 bob moves a far point's reference column 7%
// over lowland, 11% over Tibet, but by the same share across the whole view,
// so the ground brightens or dims as one instead of sliding. Looking down,
// where the tangent along each point's azimuth would light the haze far off
// in a different direction for every azimuth (a pinch under the ship near
// the terminator), the light's point eases to the ground point itself.
// Only the ease toward the shell's top still takes the eye's own ray, which
// is the atmosphere's draw there.
//
// Only for the ship's camera under the cloud shell's top (update()); elsewhere
// the atmosphere still draws over the ground, so from outside nothing
// changes. Spread through composePatches onto the ground's Phong material.
//
// The streamed surface tiles (tides-zmw.9.7) take the same haze through
// surfacePatch, sharing these uniforms: their meshes aren't in the ground's
// frame, so their ray comes from view space through the ground's frame
// (uGroundHazeViewToLocal) and their eye is the ground frame's
// (uGroundHazeEyeLocal), both filled by update() for each camera before
// anything draws (EarthRenderer's per-camera scene hook), since the tiles
// draw before the ground.
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
import { EARTH_RADIUS_KM, SCALE_HEIGHT_KM } from '../cloud-layer'
import type { MaterialPatch } from './eclipseShadow'
import { SKY_VIEW_GLSL, SKY_VIEW_UNIFORMS } from './skyView'

/** (tau / L)^GROUND_HAZE_POWER at the nearest sea horizon (s / L = sqrt(3)
 * there): e^-3, 95% of the haze. */
export const GROUND_HAZE_E = 3

/** The haze's share is 1 - exp(-(tau / L)^this): a plain exponential's
 * share at the horizon, with clearer near ground. The shader squares
 * (groundHaze()): a change here must change it too (the test checks). */
export const GROUND_HAZE_POWER = 2

/** The true air's scale height over the sea level's radius: the ground
 * haze's density (groundHazeDensity()). */
export const GROUND_HAZE_AIR = SCALE_HEIGHT_KM / EARTH_RADIUS_KM

/** The haze's reach L (scene units) over a sea level of this radius: the
 * depth to the sea horizon from the stop, at GROUND_HAZE_E. */
export function groundHazeLength(seaLevel: number): number {
  const eye = new THREE.Vector3(0, seaLevel + EARTH_GROUND_CLEARANCE, 0)
  const cos = seaLevel / eye.y
  const horizon = new THREE.Vector3(seaLevel * Math.sqrt(1 - cos * cos), seaLevel * cos, 0)
  return groundHazeDepth(eye, horizon.sub(eye), seaLevel) / GROUND_HAZE_E ** (1 / GROUND_HAZE_POWER)
}

/** The true air's density at radius r over the sea's (groundHazeDensity()). */
function hazeDensity(r: number, seaLevel: number): number {
  return Math.exp(-Math.max(r - seaLevel, 0) / (seaLevel * GROUND_HAZE_AIR))
}

/**
 * The segment's optical depth over the sea level's density, as the shader
 * takes it (groundHaze(); the test pins the two together): from `eye` (from
 * the centre) along `ray`, to the ground.
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
 * atmosphere's draw at the cloud shell's top, where the cover eases to
 * `ownCover`, the own ray's haze.glsl hazeCover()).
 */
export function groundHazeWeights(
  eye: number,
  depth: number,
  columnShare: number,
  seaLevel: number,
  flat: boolean,
  ownCover = 0
): { cover: number; haze: number; own: number } {
  const share = 1 - Math.exp(-((depth / groundHazeLength(seaLevel)) ** GROUND_HAZE_POWER))
  const top = seaLevel + groundHazeTop(flat)
  const ease = THREE.MathUtils.smoothstep(eye, top - 2 * seaLevel * ATMOSPHERE_SCALE_HEIGHT, top)
  const haze = share + (1 - share) * ease
  return {
    cover: THREE.MathUtils.lerp(share * Math.min(2 * columnShare, 1), ownCover, ease),
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
${SKY_VIEW_GLSL}
#define uSeaLevel uGroundHazeSeaLevel
#define uSurface (uGroundHazeSeaLevel * ${f(ATMOSPHERE_SURFACE)})
#define uScaleHeight (uGroundHazeSeaLevel * ${f(ATMOSPHERE_SCALE_HEIGHT)})
#define uGain ${f(ATMOSPHERE_GAIN)}
#define uSky ${v3(ATMOSPHERE_SKY)}
#define uDusk ${v3(ATMOSPHERE_DUSK)}
${hazeGlsl}

// The true air's density, the sea level's 1 (GROUND_HAZE_AIR).
float groundHazeDensity(float r) {
  return exp(-max(r - uSeaLevel, 0.0) / (uSeaLevel * ${f(GROUND_HAZE_AIR)}));
}

// From the eye along ray (eye to ground, in the mesh's frame). rgb: the haze
// the atmosphere draws over the horizon that ground at the point's height
// would make (eased to the eye's own ray's at the shell's top); a: the share
// of it laid over the ground, from the segment's optical depth; cover: the
// share of the ground it hides, as much as the haze is a horizon's (its
// column next to a level ray's from the base, hazeAbove(), half the grazing
// line), easing to the eye's own ray's cover (hazeCover(), what the
// atmosphere hides over the ground at the shell's top; tides-d9f.3).
// Mirrored by groundHazeDepth() and groundHazeWeights().
vec4 groundHaze(vec3 eye, vec3 ray, out float cover) {
  float grazing = sqrt(6.2831853 * uSurface * uScaleHeight);
  float s = length(ray);
  vec3 dir = ray / s;
  float rE = length(eye);
  float rP = length(eye + ray);
  float tau = s * (groundHazeDensity(rE) + 4.0 * groundHazeDensity(length(eye + 0.5 * ray)) + groundHazeDensity(rP)) / 6.0;
  float reach = tau / uGroundHazeLength;
  float share = 1.0 - exp(-reach * reach); // GROUND_HAZE_POWER 2
  // The ray tangent to the sphere through the point, in the eye's ray's
  // vertical plane (any across it looking straight down: that moves only at).
  vec3 up = eye / rE;
  vec3 across = dir - up * dot(dir, up);
  float a2 = dot(across, across);
  across = a2 > 1e-10 ? across * inversesqrt(a2) : normalize(cross(up, abs(up.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
  float dip2 = clamp((rE - rP) * (rE + rP) / (rE * rE), 0.0, 1.0);
  vec3 at;
  vec3 tangent = across * sqrt(1.0 - dip2) - up * sqrt(dip2);
  float column = columnAhead(eye, tangent, grazing, at);
  // Light it at the point itself as the ray steepens: the tangent's at swings
  // with the azimuth and would pinch under the ship. Near the horizon (the
  // sea's seam) the weight is a few thousandths.
  float down = max(-dot(dir, up), 0.0);
  at = mix(at, eye + ray, down * down);
  float ease = smoothstep(uGroundHazeTop - 2.0 * uScaleHeight, uGroundHazeTop, rE);
  float haze = mix(share, 1.0, ease);
  // The colour's direction too: the tangent sweeps every azimuth round the
  // nadir, and the sky along it (by its angle to the Sun) would split the
  // haze under the ship into sectors.
  vec3 look = normalize(mix(tangent, dir, down * down));
  vec3 glow = hazeGlow(column, grazing, at, uGroundHazeSun, look, eye);
  float ownCover = 0.0;
  if (ease > 0.0) {
    vec3 atOwn;
    float own = columnAheadOverSea(eye, dir, grazing, atOwn);
    glow = mix(glow, hazeGlow(own, grazing, atOwn, uGroundHazeSun, dir, eye), ease / haze);
    ownCover = hazeCover(own, dir, eye, uGroundHazeSun);
  }
  cover = mix(share * min(2.0 * column / grazing, 1.0), ownCover, ease);
  return vec4(glow, haze);
}

// The sky over the sea at up (unit, the ground's frame) along rd, as the
// atmosphere draws it from just over the sea: the high tier's table while
// the eye is under the shell's top (eased out over its last two scale
// heights, as the haze's own colour), else the analytic sky. Scene radiance
// before tone mapping. The water's reflection and its skylit body
// (water.ts) read it.
vec3 groundHazeSky(vec3 up, vec3 rd) {
  vec3 point = up * uSeaLevel;
  float table = uSkyViewOn * uGroundHaze
    * (1.0 - smoothstep(uGroundHazeTop - 2.0 * uScaleHeight, uGroundHazeTop, length(vGroundHazeEye)));
  vec3 sky = vec3(0.0);
  if (table < 1.0) {
    vec3 at;
    float column = columnAhead(point, rd, sqrt(6.2831853 * uSurface * uScaleHeight), at);
    sky = hazeSky(column, at, uGroundHazeSun, rd, point);
  }
  if (table > 0.0) sky = mix(sky, skyViewGlow(rd, point, uGroundHazeSun), table);
  return sky;
}
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

// The surface tiles' variant: view space to the ground's frame by this
// frame's matrix (from double on the CPU), the eye the ground frame's.
const SURFACE_VERTEX_HEAD = /* glsl */ `
uniform mat3 uGroundHazeViewToLocal;
uniform vec3 uGroundHazeEyeLocal;
`

const SURFACE_VERTEX_BODY = /* glsl */ `
vGroundHazeRay = uGroundHazeViewToLocal * mvPosition.xyz;
vGroundHazeEye = uGroundHazeEyeLocal;
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
  /** The same haze for a mesh outside the ground's frame (the surface
   * tiles), on the same uniforms. */
  surfacePatch: MaterialPatch
  /** The surface variant's frame, filled by update(): view space to the
   * ground mesh's frame, and the eye in it (the tiles' composer,
   * tides-zmw.9.16, reads the same uniform objects). */
  frame: {
    uGroundHazeViewToLocal: THREE.IUniform<THREE.Matrix3>
    uGroundHazeEyeLocal: THREE.IUniform<THREE.Vector3>
  }
  /** For each camera before anything draws: whether this camera takes the
   * haze, and the surface variant's frame. */
  update(ground: THREE.Object3D, camera: THREE.Camera): void
}

const _toLocal = new THREE.Matrix4()

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
    ...SKY_VIEW_UNIFORMS,
  }
  const frame = {
    uGroundHazeViewToLocal: { value: new THREE.Matrix3() },
    uGroundHazeEyeLocal: { value: new THREE.Vector3() },
  }
  const fragment = (source: string) =>
    inject(inject(source, 'common', FRAGMENT_HEAD), 'colorspace_fragment', FRAGMENT_BODY)
  return {
    patch: {
      onBeforeCompile(shader) {
        Object.assign(shader.uniforms, uniforms)
        shader.vertexShader = inject(VERTEX_HEAD + shader.vertexShader, 'project_vertex', VERTEX_BODY)
        shader.fragmentShader = fragment(shader.fragmentShader)
      },
      customProgramCacheKey: () => 'ground-haze',
    },
    surfacePatch: {
      onBeforeCompile(shader) {
        Object.assign(shader.uniforms, uniforms, frame)
        shader.vertexShader = inject(
          VERTEX_HEAD + SURFACE_VERTEX_HEAD + shader.vertexShader,
          'project_vertex',
          SURFACE_VERTEX_BODY
        )
        shader.fragmentShader = fragment(shader.fragmentShader)
      },
      customProgramCacheKey: () => 'ground-haze-surface',
    },
    frame,
    update(ground, camera) {
      uniforms.uGroundHaze.value = insideShell(ground, camera, top) ? 1 : 0
      // The ground's frame from the camera's (view space, unscaled: the
      // Earth's group and the camera carry no scale), in double.
      _toLocal.copy(ground.matrixWorld).invert().multiply(camera.matrixWorld)
      frame.uGroundHazeViewToLocal.value.setFromMatrix4(_toLocal)
      frame.uGroundHazeEyeLocal.value.setFromMatrixPosition(_toLocal)
    },
  }
}
