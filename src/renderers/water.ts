// Open water that reads as water from low down, under any Sun (tides-07z),
// on the globe's ground (EarthRenderer's Phong material, through
// composePatches) and the streamed tiles (surface/tile-glint.ts), from the
// same GLSL. Before it the sea was Phong's: the day map's near-black ocean
// lit by Lambert, plus a Blinn-Phong highlight (three's default specular,
// shininess 100) only round the Sun's reflection. From the ship's stop that
// left most of the sea black at noon, a pinprick glint at dusk, and nothing
// moving. Four terms instead, all on water only (their strength is the
// material's specularStrength: the globe's specular (water) mask, or the
// tiles' glint strength), so the land is exactly as it was:
// - the sky (sky): what the sea mostly shows, the sky it mirrors, Fresnel
//   weighted (Schlick, F0 WATER_F0: 2% looking down, all of it at grazing),
//   from a small local sky model (./skyRadiance.ts) along the reflected ray,
//   in directSpecular so the cloud shadow, the eclipse and the terrain
//   shadow (patches whose code lands after it) dim it with the Sun;
// - the glint (direct): Phong's Blinn-Phong replaced, for every light, by a
//   Cox-Munk microfacet term: Beckmann's distribution over the sea's slope
//   variance (waterMss), Schlick's Fresnel and Smith's shadowing, so the
//   Sun's road widens and brightens toward the horizon and at a low Sun as
//   the real sea's does; under the level horizon (the tilted wave facets
//   could see a Sun the sea can't) it goes out;
// - the body (body): the day map's ocean is near black (its deep water a
//   few thousandths), darker than water's own colour; anything darker than
//   WATER_DEEP is lifted to it, the lighter shelves, lagoons and silt left
//   as the map has them;
// - the waves (normal): WATER_WAVES fixed sinusoids in the Earth's frame
//   (Earth-fixed, so the swell stays put under a moving eye), deep-water
//   dispersion for their speeds, the longer ones carrying more of the
//   slope (WATER_SLOPE_TILT) and bending the shorter ones' crests
//   (WATER_WARP), each faded out (as the ground detail's octaves,
//   groundDetail.ts, only sooner: WATER_FADE_START) before it shrinks to a
//   dozen pixels; the slope
//   variance a faded wave takes with it goes into the glint's roughness, so
//   far off the sea glitters as one rough surface instead of aliasing.
//   Still under prefers-reduced-motion (advance()).
//
// The wave phases come from the CPU in double (update(): k.eye, which is
// thousands of radians at Earth's radius, minus w t, both mod 2 pi), so the
// GPU adds only k.ray, which is small near the eye and smooth (the ray from
// view space through the ground's frame, as the haze's and the tiles'
// base's). The frame is the ground haze's (GroundHaze.frame), filled per
// camera before anything draws; update() runs after it.
//
// No varyings. The globe's pieces go in at: the body after
// specularmap_fragment, the waves just before emissivemap_fragment (after
// every patch's normal_fragment_maps code, so the ground detail's groundUp
// stays the unbent normal), the glint after lights_phong_pars_fragment
// (RE_Direct redefined), the sky after lights_fragment_end.
import * as THREE from 'three'
import { EARTH_KM_PER_UNIT } from '../surface-handover'
import type { MaterialPatch } from './eclipseShadow'
import type { GroundHaze } from './groundHaze'
import { SKY_RADIANCE_GLSL } from './skyRadiance'

/** Waves on the full tier; the low tier keeps the longest WATER_WAVES_LOW. */
export const WATER_WAVES = 12
export const WATER_WAVES_LOW = 6
/** The longest wave (m), each next WATER_WAVE_RATIO of it. */
export const WATER_WAVE_LONGEST = 120
export const WATER_WAVE_RATIO = 0.715
/** How far (radians) each wave's crests are pushed along by the longer
 * waves' (their sines, summed as they are drawn, longest first): a handful
 * of straight sinusoids crossing read as a woven grid; bent by the swell
 * under them they read as a sea. It moves the crests, not their slopes. */
export const WATER_WARP = 0.9
/** The sea's total slope variance (Cox-Munk's for a breeze of about 6 m/s),
 * and the part finer than the waves, always in the glint's roughness. */
export const WATER_MSS = 0.034
export const WATER_MSS_BASE = 0.012
/** Water's reflectance looking straight down. */
export const WATER_F0 = 0.02
/** Deep water's body colour (linear): the map's ocean darker than it is
 * lifted to it. */
export const WATER_DEEP: readonly [number, number, number] = [0.008, 0.022, 0.045]

const G = 9.81
const TAU = 2 * Math.PI
const LUMA = [0.2126, 0.7152, 0.0722] as const
const luma = (c: readonly number[]) => LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2]
export const WATER_DEEP_LUMA = luma(WATER_DEEP)
const METRES_PER_UNIT = EARTH_KM_PER_UNIT * 1000

export interface WaterWave {
  /** Its slot in uWavePhase. */
  index: number
  /** Unit direction of travel in the ground's frame (Y north). */
  dir: readonly [number, number, number]
  /** Wavelength, metres and scene units. */
  metres: number
  lambda: number
  /** Wavenumber (radians per scene unit) and angular speed (rad/s). */
  k: number
  omega: number
  /** Slope amplitude for a wave travelling level (its height times k). */
  slope: number
}

/** Each wave's slope amplitude: WATER_MSS - WATER_MSS_BASE over the full
 * set, a wave's mean projected variance being half its amplitude squared
 * times 2/3 (a random direction's level share). */
export const WATER_WAVE_SLOPE = Math.sqrt((2 * (WATER_MSS - WATER_MSS_BASE)) / WATER_WAVES / (2 / 3))

/** How the slope is shared out: each wave's goes as its wavelength to this
 * power (the set's variance unchanged), so the longer waves shape the sea
 * and the shortest, next to the pixel, don't weave it into a fine grid. */
export const WATER_SLOPE_TILT = 0.35
const tiltOf = (i: number) => WATER_WAVE_RATIO ** (WATER_SLOPE_TILT * ((i * 5) % WATER_WAVES))
const TILT_NORM = Math.sqrt(WATER_WAVES / Array.from({ length: WATER_WAVES }, (_, i) => tiltOf(i) ** 2).reduce((a, b) => a + b))

/** A wave's fade, in pixels' widths over its level wavelength: wider than
 * the ground detail's (DETAIL_FADE_START, 1/6): a sinusoid's glint aliases
 * into speckle well before noise does. */
export const WATER_FADE_START = 1 / 12
export const WATER_FADE_END = 1 / 6

/** The waves: directions on a golden spiral over the northern hemisphere
 * (a plane wave and its opposite are the same pattern, so this covers every
 * direction), wavelengths shuffled across them (i 5 mod 12) so the long
 * ones don't all run one way. */
export const WATER_WAVE_TABLE: readonly WaterWave[] = Array.from({ length: WATER_WAVES }, (_, index) => {
  const y = 1 - (index + 0.5) / WATER_WAVES
  const r = Math.sqrt(1 - y * y)
  const phi = index * 2.39996
  const metres = WATER_WAVE_LONGEST * WATER_WAVE_RATIO ** ((index * 5) % WATER_WAVES)
  const lambda = metres / METRES_PER_UNIT
  return {
    index,
    dir: [r * Math.cos(phi), y, r * Math.sin(phi)] as const,
    metres,
    lambda,
    k: TAU / lambda,
    omega: Math.sqrt((G * TAU) / metres),
    slope: WATER_WAVE_SLOPE * TILT_NORM * tiltOf(index),
  }
})

/** The tier's waves: all of them, or the low tier's longest. */
export function waterWaves(low: boolean): readonly WaterWave[] {
  if (!low) return WATER_WAVE_TABLE
  const cut = [...WATER_WAVE_TABLE].sort((a, b) => b.metres - a.metres)[WATER_WAVES_LOW - 1].metres
  return WATER_WAVE_TABLE.filter((w) => w.metres >= cut)
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}

/** A wave's weight at `footprint` (a pixel's width on the sea, scene units)
 * for its level wavelength `lambdaEff` (its wavelength over its level
 * share): the ground detail's fade. */
export function waveWeight(footprint: number, lambdaEff: number): number {
  return 1 - smoothstep(WATER_FADE_START, WATER_FADE_END, footprint / lambdaEff)
}

type Vec3 = readonly [number, number, number]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** The slope variance `waves` still draw at `footprint` over ground whose
 * up is `up` (unit, the ground's frame), as the GLSL sums it. */
export function waterVisibleVariance(footprint: number, up: Vec3, waves: readonly WaterWave[]): number {
  let seen = 0
  for (const w of waves) {
    const along = dot(w.dir, up)
    const level2 = Math.max(1 - along * along, 0)
    seen += waveWeight(footprint, w.lambda / Math.sqrt(level2)) * 0.5 * w.slope * w.slope * level2
  }
  return seen
}

/** The glint's slope variance: all of the sea's but what the waves draw. */
export function waterMss(footprint: number, up: Vec3, waves: readonly WaterWave[]): number {
  return Math.max(WATER_MSS - waterVisibleVariance(footprint, up, waves), WATER_MSS_FLOOR)
}
const WATER_MSS_FLOOR = 1e-3

/** The roughness the tier's waves leave in the glint, on average, with
 * every wave drawn: WATER_MSS_BASE, plus the dropped waves' on the low tier. */
export function waterBaseMss(waves: readonly WaterWave[]): number {
  return WATER_MSS - waves.reduce((sum, w) => sum + 0.5 * w.slope * w.slope * (2 / 3), 0)
}

/** The variance the faded waves have handed to the glint at `footprint`
 * (over waterBaseMss). */
export function waterLostVariance(footprint: number, up: Vec3, waves: readonly WaterWave[]): number {
  return waterMss(footprint, up, waves) - waterBaseMss(waves)
}

/** Each wave's phase at the eye (`eye` from the centre, the ground's frame)
 * at `time` s, into `out` by its index, mod 2 pi: the GPU adds k.ray. */
export function waterPhases(eye: Vec3, time: number, out: Float32Array | number[]): void {
  for (const w of WATER_WAVE_TABLE) {
    const phase = ((w.k * dot(w.dir, eye)) % TAU) - ((w.omega * time) % TAU)
    out[w.index] = phase - TAU * Math.floor(phase / TAU)
  }
}

/** The body's colour for a map colour `c` (linear), at `strength` water,
 * as the GLSL mixes it. */
export function waterBody(c: Vec3, strength: number): [number, number, number] {
  const lift = Math.min(Math.max(1 - luma(c) / WATER_DEEP_LUMA, 0), 1)
  return [0, 1, 2].map((i) => c[i] + strength * WATER_DEEP[i] * lift) as [number, number, number]
}

/** The glint's reflected radiance over the light's colour, for unit vectors
 * toward the light `l` and the eye `v`, the normal `n` and the level up
 * `up`, at slope variance `mss`, as the GLSL's waterGlint(). */
export function waterGlint(l: Vec3, v: Vec3, n: Vec3, up: Vec3, mss: number): number {
  const hv: Vec3 = [l[0] + v[0], l[1] + v[1], l[2] + v[2]]
  const hl = 1 / Math.sqrt(Math.max(dot(hv, hv), 1e-12))
  const h: Vec3 = [hv[0] * hl, hv[1] * hl, hv[2] * hl]
  const sat = (x: number) => Math.min(Math.max(x, 0), 1)
  const nl = sat(dot(n, l))
  const nv = sat(dot(n, v))
  const nh2 = Math.max(sat(dot(n, h)) ** 2, 1e-4)
  const vh = sat(dot(v, h))
  const d = beckmann(nh2, mss)
  const fresnel = WATER_F0 + (1 - WATER_F0) * (1 - vh) ** 5
  const g1 = (x: number) => (2 * x) / (x + Math.sqrt(mss + (1 - mss) * x * x))
  return (smoothstep(-0.02, 0.02, dot(up, l)) * fresnel * d * g1(nl) * g1(nv)) / (4 * Math.max(nv, 1e-3))
}

/** Beckmann's distribution of facet normals at cos^2 `nh2` off the mean,
 * for slope variance `mss`. */
export function beckmann(nh2: number, mss: number): number {
  return Math.exp((nh2 - 1) / (nh2 * mss)) / (Math.PI * mss * nh2 * nh2)
}

const f = (x: number) => x.toFixed(6)
const e = (x: number) => x.toExponential(9)
const v3 = (c: readonly number[]) => `vec3(${c.map(f).join(', ')})`

// three r180's RE_Direct_BlinnPhong (lights_phong_pars_fragment as three
// ships it, blank lines stripped; the test pins it to three's text). The
// water's direct light is this with the specular line swapped for the
// glint, skipped where the strength is 0 (the land), which leaves those
// pixels as they were.
export const BLINN_PHONG_DIRECT = /* glsl */ `void RE_Direct_BlinnPhong( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in BlinnPhongMaterial material, inout ReflectedLight reflectedLight ) {
\tfloat dotNL = saturate( dot( geometryNormal, directLight.direction ) );
\tvec3 irradiance = dotNL * directLight.color;
\treflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
\treflectedLight.directSpecular += irradiance * BRDF_BlinnPhong( directLight.direction, geometryViewDir, geometryNormal, material.specularColor, material.specularShininess ) * material.specularStrength;
}`

const BLINN_PHONG_SPECULAR = BLINN_PHONG_DIRECT.split('\n').find((line) => line.startsWith('\treflectedLight.directSpecular +='))!
const WATER_SPECULAR =
  '\tif ( material.specularStrength > 0.0 ) reflectedLight.directSpecular += material.specularStrength * waterGlint( directLight.direction, geometryViewDir, geometryNormal ) * directLight.color;'

const DIRECT = `${BLINN_PHONG_DIRECT.replace('RE_Direct_BlinnPhong(', 'RE_Direct_Water(').replace(BLINN_PHONG_SPECULAR, WATER_SPECULAR)}
#undef RE_Direct
#define RE_Direct RE_Direct_Water
`

// Globals the pieces share (the direct light is a function, so what it
// reads of the waves is global), the sky, the glint and the body.
const head = () => /* glsl */ `
uniform float uWavePhase[${WATER_WAVES}];
vec3 waterRay;
vec3 waterUpGround;
vec3 waterUpView;
mat3 waterViewToGround;
float waterMss;
${SKY_RADIANCE_GLSL}
// Smith's shadowing for a facet slope variance a2.
float waterG1(float x, float a2) {
  return 2.0 * x / (x + sqrt(a2 + (1.0 - a2) * x * x));
}
// The glint over the light's colour (waterGlint() mirrors it): Beckmann,
// Schlick, Smith, out under the level horizon. No NaN with l = -v (h 0).
float waterGlint(vec3 l, vec3 v, vec3 n) {
  vec3 hv = l + v;
  vec3 h = hv * inversesqrt(max(dot(hv, hv), 1e-12));
  float nl = saturate(dot(n, l));
  float nv = saturate(dot(n, v));
  float nh = saturate(dot(n, h));
  float nh2 = max(nh * nh, 1e-4);
  float vh = 1.0 - saturate(dot(v, h));
  float vh2 = vh * vh;
  float a2 = waterMss;
  float d = exp((nh2 - 1.0) / (nh2 * a2)) / (PI * a2 * nh2 * nh2);
  float fresnel = ${f(WATER_F0)} + ${f(1 - WATER_F0)} * vh2 * vh2 * vh;
  return smoothstep(-0.02, 0.02, dot(waterUpView, l)) * fresnel * d * waterG1(nl, a2) * waterG1(nv, a2) / (4.0 * max(nv, 1e-3));
}
// The map's ocean darker than deep water lifted to it (waterBody() mirrors it).
vec3 waterBody(vec3 c) {
  return c + ${v3(WATER_DEEP)} * saturate(1.0 - dot(c, vec3(${LUMA.map(f).join(', ')})) / ${f(WATER_DEEP_LUMA)});
}
`

// After the strength is known.
const BODY = /* glsl */ `
diffuseColor.rgb = mix(diffuseColor.rgb, waterBody(diffuseColor.rgb), specularStrength);
`

// One wave, unrolled (no arrays indexed in the loop: those spill on some
// GPUs): its level part at this ground, its fade, its slope.
const wave = (w: WaterWave) => /* glsl */ `
  waterD = ${v3(w.dir)};
  waterDt = waterD - waterUpGround * dot(waterD, waterUpGround);
  waterDt2 = dot(waterDt, waterDt);
  waterW = 1.0 - smoothstep(${f(WATER_FADE_START)}, ${f(WATER_FADE_END)}, waterFootprint * sqrt(waterDt2) * ${e(1 / w.lambda)});
  waterS = sin(uWavePhase[${w.index}] + ${e(w.k)} * dot(waterD, waterRay) + waterWarp);
  waterGrad -= (waterW * ${f(w.slope)} * waterS) * waterDt;
  waterWarp += waterW * ${f(WATER_WARP)} * waterS;
  waterSeen += waterW * ${e(0.5 * w.slope * w.slope)} * waterDt2;`

// After the prelude (waterRay, waterUpGround, waterUpView and
// waterViewToGround set). The footprint is the ground detail's (a pixel's
// width on the ground, stretched by the slant, here the level sea's), from
// derivatives taken before any branch; the orthographic system view takes
// none. Past three times the longest wave every wave has faded (bar those
// running nearly vertical here, which have no slope to speak of).
const normal = (waves: readonly WaterWave[]) => /* glsl */ `
waterMss = ${f(WATER_MSS)};
{
  vec3 waterEye = normalize(vViewPosition);
  float waterSpread = max(length(dFdx(waterEye)), length(dFdy(waterEye)));
  float waterFootprint = isOrthographic ? 1e9
    : waterSpread * length(vViewPosition) / max(abs(dot(waterEye, waterUpView)), 0.05);
  if (specularStrength > 0.0 && waterFootprint < ${e(3 * Math.max(...waves.map((w) => w.lambda)))}) {
    vec3 waterGrad = vec3(0.0);
    float waterSeen = 0.0;
    vec3 waterD;
    vec3 waterDt;
    float waterDt2;
    float waterW;
    float waterS;
    float waterWarp = 0.0;${[...waves].sort((a, b) => b.lambda - a.lambda).map(wave).join('')}
    waterMss = max(${f(WATER_MSS)} - waterSeen, ${f(WATER_MSS_FLOOR)});
    normal = normalize(normal - specularStrength * (waterGrad * waterViewToGround));
  }
}
`

// After lights_fragment_end, before the shadows dim directSpecular: the sky
// along the reflected ray, Fresnel weighted, over the Sun's colour.
const SKY = /* glsl */ `
#if NUM_DIR_LIGHTS > 0
if (material.specularStrength > 0.0) {
  float waterCos = 1.0 - saturate(dot(geometryNormal, geometryViewDir));
  float waterCos2 = waterCos * waterCos;
  float waterFresnel = ${f(WATER_F0)} + ${f(1 - WATER_F0)} * waterCos2 * waterCos2 * waterCos;
  reflectedLight.directSpecular += material.specularStrength * waterFresnel
    * skyRadiance(reflect(-geometryViewDir, geometryNormal), waterUpView, directionalLights[0].direction)
    * directionalLights[0].color;
}
#endif
`

/** The water's GLSL for `waves` (the test checks it; the tiles reuse it):
 * head (globals, after common), body (after the strength), normal (the
 * waves, after a prelude), direct (after lights_phong_pars_fragment), sky
 * (after lights_fragment_end). */
export function WATER_GLSL(waves: readonly WaterWave[]) {
  return { head: head(), body: BODY, normal: normal(waves), direct: DIRECT, sky: SKY }
}

/** Each chain's prelude, run first in the normal piece: the ray, the level
 * up in both frames and the frame. The globe's from view space through the
 * haze's frame; the tiles' from their base's (tile-material.ts). */
export const WATER_PRELUDE = {
  globe: {
    head: /* glsl */ `
uniform mat3 uWaterViewToGround;
uniform vec3 uWaterEyeGround;
`,
    body: /* glsl */ `
waterViewToGround = uWaterViewToGround;
waterRay = uWaterViewToGround * -vViewPosition;
waterUpGround = normalize(uWaterEyeGround + waterRay);
waterUpView = waterUpGround * uWaterViewToGround;
`,
  },
  tiles: {
    head: '',
    body: /* glsl */ `
waterViewToGround = uSurfaceViewToGround;
waterRay = surfaceRay;
waterUpGround = surfaceUp;
waterUpView = surfaceUp * uSurfaceViewToGround;
`,
  },
} as const

export interface Water {
  /** The phases, by wave index (shared by every program that takes the water). */
  uniforms: { uWavePhase: THREE.IUniform<Float32Array> }
  /** Moves the waves on by `dt` seconds, unless `reduced` (prefers-reduced-motion). */
  advance(dt: number, reduced: boolean): void
  /** For each camera before anything draws, after the frame's update
   * (GroundHaze.update): the phases at its eye. */
  update(): void
}

/** The water's clock and phases on the haze's `frame` (its eye). */
export function createWater(frame: GroundHaze['frame']): Water {
  const uniforms = { uWavePhase: { value: new Float32Array(WATER_WAVES) } }
  const eye: [number, number, number] = [0, 0, 0]
  let time = 0
  return {
    uniforms,
    advance(dt, reduced) {
      if (!reduced) time += dt
    },
    update() {
      frame.uGroundHazeEyeLocal.value.toArray(eye)
      waterPhases(eye, time, uniforms.uWavePhase.value)
    },
  }
}

function inject(source: string, include: string, code: string, before = false): string {
  if (!source.includes(include)) throw new Error(`water: shader has no ${include}`)
  return source.replace(include, before ? `${code}\n${include}` : `${include}\n${code}`)
}

/** Injects `code` after three's `#include <chunk>` (before it with `before`). */
export function injectWater(source: string, chunk: string, code: string, before = false): string {
  return inject(source, `#include <${chunk}>`, code, before)
}

/** The water on the globe's ground, on `water`'s phases and the haze's
 * `frame`; `low`, the low tier's waves. */
export function waterPatch(water: Water, frame: GroundHaze['frame'], low: boolean): MaterialPatch {
  const waves = waterWaves(low)
  const glsl = WATER_GLSL(waves)
  const uniforms = {
    ...water.uniforms,
    uWaterViewToGround: frame.uGroundHazeViewToLocal,
    uWaterEyeGround: frame.uGroundHazeEyeLocal,
  }
  return {
    onBeforeCompile(shader) {
      Object.assign(shader.uniforms, uniforms)
      let fragment = injectWater(shader.fragmentShader, 'common', WATER_PRELUDE.globe.head + glsl.head)
      fragment = injectWater(fragment, 'lights_phong_pars_fragment', glsl.direct)
      fragment = injectWater(fragment, 'specularmap_fragment', `#ifdef USE_SPECULARMAP\n${glsl.body}#endif\n`)
      fragment = injectWater(fragment, 'emissivemap_fragment', WATER_PRELUDE.globe.body + glsl.normal, true)
      shader.fragmentShader = injectWater(fragment, 'lights_fragment_end', glsl.sky)
    },
    customProgramCacheKey: () => `water-${waves.length}`,
  }
}
