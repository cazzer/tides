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
//   along the reflected ray as the atmosphere draws it (the ground haze's
//   groundHazeSky(): the high tier's sky-view table, else the analytic
//   sky), in directSpecular so the cloud shadow, the eclipse and the
//   terrain shadow (patches whose code lands after it) dim it with the Sun;
//   and the same sky's light in the water's body, what the near sea shows
//   (it reflects 2-5% there), as skylight in indirectDiffuse on deep
//   water's colour (not the map's: the globe's and the tiles' differ); both
//   by day only (SKY_DAY);
// - the glint (direct): Phong's Blinn-Phong replaced, for every light, by a
//   Cox-Munk microfacet term: Beckmann's distribution over the sea's slope
//   variances along and across its axis (waterVarAlong, waterVarCross:
//   anisotropic, so the road stretches the way the waves run), Schlick's
//   Fresnel and Smith's shadowing, so the
//   Sun's road widens and brightens toward the horizon and at a low Sun as
//   the real sea's does; under the level horizon (the tilted wave facets
//   could see a Sun the sea can't) it goes out; and broken into sparkle,
//   the facets a pixel spans that catch the Sun drawn as a count over its
//   mean (WATER_FACET_M), so the road is points of sunlight round a narrow
//   core rather than one smooth lobe;
// - the body (in normal): the day map's ocean, tinted by the depth under it
//   (./waterDepth.ts waterTinted: lighter and greener over the banks and
//   shelves, darker over deep water and the trenches, the map's own lighter
//   banks and silt left as they are); anything still darker than WATER_DEEP
//   is lifted to it; by day only (SKY_DAY), so the night fill and the
//   Moon's light find the night sea as dark as they did;
// - the waves (normal): WATER_WAVES fixed sinusoids in the Earth's frame
//   (Earth-fixed, so the swell stays put under a moving eye), deep-water
//   dispersion for their speeds, the longer ones carrying more of the
//   slope (WATER_SLOPE_TILT) and bending the shorter ones' crests
//   (WATER_WARP), each faded out on its phase step across the pixel (the
//   ray's own derivatives, so a long footprint fades only the waves running
//   along it) well before its glint lines, a fraction of its wavelength
//   wide, would alias (WATER_GLINT_HARMONIC: before, the 120 m swell's
//   lines striped the sunset road near the eye); the slope variance a faded
//   wave takes with it (1 - W^2 of it, as W^2 is what's drawn) goes into
//   the glint's roughness on the axis it ran along, at the wind sea's scale
//   (Cox-Munk's roughness is the wind's; the swell's height scales only
//   what's drawn), so far off the sea glitters as one rough surface instead
//   of aliasing; where every wave has faded only that variance is summed.
//   The swell's crests bend and its amplitude gathers into groups on
//   Earth-fixed noise a kilometre or two across (WATER_SWELL_KM), so it
//   doesn't run as one ruler-straight grating under the eye;
// - the sea's state (normal): how rough it runs and which way, from the
//   wave climate (waterClimate.ts: the wind sea's Cox-Munk variance, the
//   swell's height, the settled axis the waves pull toward, WATER_ALIGN),
//   broken up by Earth-fixed noise tens of kilometres across
//   (WATER_NOISE_KM), so from a few kilometres up the sea isn't one
//   roughness everywhere: in the glint, and in the sky's reflection, read
//   off facets the undrawn roughness tilts toward the eye (WATER_SKY_ROUGH).
//   Still under prefers-reduced-motion (advance(): the climate is a texture,
//   the noise fixed to the Earth).
//
// The wave phases come from the CPU in double (update(): k.eye, which is
// thousands of radians at Earth's radius, minus w t, both mod 2 pi), so the
// GPU adds only k.ray, which is small near the eye and smooth (the ray from
// view space through the ground's frame, as the haze's and the tiles'
// base's). The frame is the ground haze's (GroundHaze.frame), filled per
// camera before anything draws; update() runs after it.
//
// No varyings; two samplers (the climate, the depth). The globe's pieces go in at: the body and the waves just
// before emissivemap_fragment (after
// every patch's normal_fragment_maps code, so the ground detail's groundUp
// stays the unbent normal), the glint after lights_phong_pars_fragment
// (RE_Direct redefined), the sky after lights_fragment_end. The sky calls
// the ground haze's groundHazeSky(), so every program with the water takes
// the ground haze too (its head, like the water's, before main()).
import * as THREE from 'three'
import { EARTH_KM_PER_UNIT } from '../surface-handover'
import type { MaterialPatch } from './eclipseShadow'
import type { GroundHaze } from './groundHaze'
import { WATER_DEPTH_GLSL, WATER_DEPTH_NEUTRAL, WATER_DEPTH_SAMPLE, WATER_TINT_DEEP, waterTinted } from './waterDepth'
import { climateTexture, WATER_CLIMATE_GLSL } from './waterClimate'
import { EARTH_RADIUS_KM } from '../cloud-layer'

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
/** sin(the Sun's elevation) over which the sea's day terms (the body's
 * floor, the sky's reflection and its light in the body) come in: none at
 * -0.10 (the night fill and the Moon have the night sea as they did), all
 * at 0.05. */
export const SKY_DAY = [-0.1, 0.05] as const
/** The elevation (deg) the sky's light on the body is read at, 90 deg round
 * from the Sun: there hazeSky()'s radiance is its cosine-weighted mean over
 * the dome (the skylight's irradiance over pi) within a few percent from
 * twilight to noon (groundHaze.test.ts checks it, for the analytic sky
 * only: the high tier's table is taken to share its shape), so one read
 * stands in for the dome. */
export const WATER_SKY_LIGHT_ELEVATION = 25
/** The skylit body's gain. The day map's deep ocean and WATER_DEEP are
 * calibrated for the Sun's Lambert light on the map, and under the sky alone
 * they undershoot the sea's upwelling light: at 1 the near sea under a low
 * Sun stayed navy-black; at 3 the low tier's sea under a 4 deg Sun read
 * darker than the day map's had (lighter than deep water, under the old sky
 * fill); 5 meets it, and by 6 the sea goes matte. The glint and the Sun's
 * direct light on the body are as they were. */
export const WATER_BODY_SKY = 5
/** How far the roughness the waves don't draw tilts the facets the sky's
 * reflection is read from, in standard deviations of its slope over the
 * median sea's (WATER_SKY_ROUGH_MEDIAN), at a grazing view: toward the eye
 * where the sea is rougher, away where it is calmer. Tilting every facet
 * toward the eye by its whole roughness darkened the sea as a whole, back
 * toward the black this sky reflection was there to lift. */
export const WATER_SKY_ROUGH = 1.5
/** The median sea's slope deviation along one axis (half of WATER_MSS). */
export const WATER_SKY_ROUGH_MEDIAN = Math.sqrt(WATER_MSS / 2)
/** The glint's sparkle. A pixel spans its area over WATER_FACET_M^2 of the
 * sea's facets, each catching the Sun (its disc, WATER_SUN_SR) with the
 * chance the glint's own slope distribution gives its half vector; the
 * count it catches is drawn (Poisson, from a hash of its Earth-fixed cell, a
 * power of two in metres under the pixel's narrower step, and of the half
 * vector's slope cell, WATER_SPARKLE_SLOPE wide, so a glint moves with the
 * waves' normals and the eye) and the glint scaled by it over its mean. The
 * mean is the smooth lobe; where a pixel expects few facets the road breaks
 * into points of sunlight and the core narrows to where it expects many.
 * Each cell redraws WATER_TWINKLE_HZ times a second at its own phase, on the
 * water's clock (still under prefers-reduced-motion). The cells repeat every
 * WATER_SPARKLE_PERIOD_M (the eye passes the GPU its place mod that, in
 * double). */
export const WATER_FACET_M = 1.5
/** Under a low Sun a share of the glint stays smooth, the glow the finest
 * facets give, so the sunset road keeps its gold (lit points clip to white):
 * WATER_SPARKLE_GLOW of it at the Sun's elevation WATER_SPARKLE_GLOW_DEG[0]
 * (deg) and under, none from WATER_SPARKLE_GLOW_DEG[1], so a higher Sun's
 * road stays all sparkle. */
export const WATER_SPARKLE_GLOW = 0.25
export const WATER_SPARKLE_GLOW_DEG = [5, 12] as const
export const WATER_SUN_SR = 6.8e-5
export const WATER_SPARKLE_SLOPE = 0.005
export const WATER_TWINKLE_HZ = 6
export const WATER_SPARKLE_PERIOD_M = 4096

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
export const WATER_SLOPE_TILT = 0.2
const tiltOf = (i: number) => WATER_WAVE_RATIO ** (WATER_SLOPE_TILT * ((i * 5) % WATER_WAVES))
const TILT_NORM = Math.sqrt(WATER_WAVES / Array.from({ length: WATER_WAVES }, (_, i) => tiltOf(i) ** 2).reduce((a, b) => a + b))

/** A wave's fade, in cycles per pixel: drawn whole while a pixel steps less
 * than WATER_FADE_START of its wavelength, gone past WATER_FADE_END. */
export const WATER_FADE_START = 1 / 12
export const WATER_FADE_END = 1 / 6
/** How much sooner than its own wavelength a wave fades: a sinusoid's glint
 * under a low Sun is a line a fraction of its wavelength wide (its
 * harmonics), and that line, not the wave, is what aliases. A rougher wave
 * (its gain, F) fades sooner still, as F^1/4. */
export const WATER_GLINT_HARMONIC = 2.5

/** The wave climate's pull on each wave's slope: 1 + WATER_ALIGN R cos 2Δ,
 * Δ between the wave and the local sea's axis, R how settled the axis is
 * (waterClimate.ts). Its mean over directions is 1. */
export const WATER_ALIGN = 0.8
/** The wavelengths (m) over which a wave goes from wind sea (its slope
 * scaled as the wind waves' Cox-Munk variance) to swell (as the swell's
 * height, squared). */
export const WATER_SWELL_FROM = 15
export const WATER_SWELL_TO = 60
/** The sea's large-scale noise, fixed to the Earth: its octaves (km), each
 * faded where a pixel spans an eighth of it; how far it scales the sea's
 * slope variance (2^(WATER_NOISE_SCALE n), n the octaves' weighted mean,
 * its spread about 0.25, clamped to 0.3 to 3: calm and rough patches a few
 * times apart, as a 4 m/s and a 12 m/s wind's) and turns its axis
 * (WATER_NOISE_TURN n radians). */
export const WATER_NOISE_KM = [40, 13, 4.5] as const
const WATER_NOISE_WEIGHT = [1, 0.5, 0.25] as const
const NOISE_WEIGHT_SUM = WATER_NOISE_WEIGHT.reduce((a, b) => a + b, 0)
export const WATER_NOISE_SCALE = 2.5
export const WATER_NOISE_TURN = 0.6
/** The swell's own irregularity, fixed to the Earth: two octaves of noise
 * (km) push each wave's crests along by up to about WATER_SWELL_BEND
 * radians, differently for each wave, so its crests curve and wander
 * instead of running ruler-straight for kilometres, and gather its
 * amplitude into groups (1 + WATER_SWELL_GROUPS m). The bend's steepest
 * pull (WATER_SWELL_BEND_K, rad per km: noise climbs at most about 2 a cell)
 * counts in each wave's fade. */
export const WATER_SWELL_KM = [1.6, 0.55] as const
export const WATER_SWELL_BEND = 6
export const WATER_SWELL_GROUPS = 0.5
export const WATER_SWELL_BEND_K = WATER_SWELL_BEND * 2 * (1 / WATER_SWELL_KM[0] + 0.5 / WATER_SWELL_KM[1])

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

type Vec3 = readonly [number, number, number]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** The sea at a place as the GLSL forms it: the climate's scales
 * (waterClimate.ts mssScale and swellScale), the large-scale noise's scale,
 * how settled the sea's axis is (0 to 1) and that axis (unit, level, the
 * ground's frame). */
export interface WaterSea {
  windScale: number
  swellScale: number
  noise: number
  settled: number
  axis: Vec3
}

/** The median sea, its axis `axis`: every wave at its own slope. */
export function medianSea(axis: Vec3): WaterSea {
  return { windScale: 1, swellScale: 1, noise: 1, settled: 0, axis }
}

/** A wave's level part over ground whose up is `up`, and its squared length. */
function levelPart(w: WaterWave, up: Vec3): { dt: Vec3; dt2: number } {
  const along = dot(w.dir, up)
  const dt: Vec3 = [w.dir[0] - up[0] * along, w.dir[1] - up[1] * along, w.dir[2] - up[2] * along]
  return { dt, dt2: Math.max(dot(dt, dt), 1e-8) }
}

/** cos 2Δ between a wave's level direction and the sea's axis. */
function axisCos2(w: WaterWave, up: Vec3, sea: WaterSea): number {
  const { dt, dt2 } = levelPart(w, up)
  const a = dot(dt, sea.axis)
  return (2 * a * a) / dt2 - 1
}

/** How far a wave is swell rather than wind sea, by its wavelength. */
export function waveSwell(w: WaterWave): number {
  return smoothstep(WATER_SWELL_FROM, WATER_SWELL_TO, w.metres)
}

/** A wave's gain F on its slope variance in `sea` over ground whose up is
 * `up` (its amplitude goes as the square root). */
export function waveGain(w: WaterWave, up: Vec3, sea: WaterSea): number {
  const t = waveSwell(w)
  const scale = sea.windScale + (sea.swellScale * sea.swellScale - sea.windScale) * t
  return sea.noise * scale * (1 + WATER_ALIGN * sea.settled * axisCos2(w, up, sea))
}

/** A wave's gain on the variance it hands the glint when it fades: the wind
 * sea's (Cox-Munk's slope variance is the wind's), whatever its class; the
 * swell's height scales only what's drawn. */
export function waveGlintGain(w: WaterWave, up: Vec3, sea: WaterSea): number {
  return sea.noise * sea.windScale * (1 + WATER_ALIGN * sea.settled * axisCos2(w, up, sea))
}

/** A wave's phase step (radians) across a pixel `footprint` wide (scene
 * units, square on the level sea). The GLSL takes the pixel's two steps and
 * adds the longer waves' warp; the mirrors fade on the wavelength alone. */
export function waveStep(w: WaterWave, up: Vec3, footprint: number): number {
  return w.k * Math.sqrt(levelPart(w, up).dt2) * footprint
}

/** A wave's weight at a phase `step` per pixel for its `gain`. */
export function waveWeight(step: number, gain = 1): number {
  return 1 - smoothstep(WATER_FADE_START * TAU, WATER_FADE_END * TAU, step * WATER_GLINT_HARMONIC * gain ** 0.25)
}

/** A wave's slope variance in `sea` at `gain`. */
function waveVariance(w: WaterWave, up: Vec3, gain: number): number {
  return gain * 0.5 * w.slope * w.slope * levelPart(w, up).dt2
}

const weightAt = (w: WaterWave, up: Vec3, sea: WaterSea, footprint: number) =>
  waveWeight(waveStep(w, up, footprint), waveGain(w, up, sea))

/** The slope variance `waves` still draw at `footprint` over ground whose
 * up is `up` (unit, the ground's frame): a wave drawn at weight W carries
 * W^2 of its variance. */
export function waterVisibleVariance(footprint: number, up: Vec3, waves: readonly WaterWave[], sea: WaterSea): number {
  return waves.reduce((sum, w) => sum + weightAt(w, up, sea, footprint) ** 2 * waveVariance(w, up, waveGain(w, up, sea)), 0)
}

/** The roughness the tier's waves leave in the glint, on average, with
 * every wave drawn, for the median sea: WATER_MSS_BASE, plus the dropped
 * waves' on the low tier. */
export function waterBaseMss(waves: readonly WaterWave[]): number {
  return WATER_MSS - waves.reduce((sum, w) => sum + 0.5 * w.slope * w.slope * (2 / 3), 0)
}

/** The sea's whole slope variance here as the glint sees it, every wave
 * faded: its base roughness and every wave's, at the wind's scale. Where
 * the swell's scale squared is the wind's, it is also what the drawn waves
 * and the glint add up to at any footprint. */
export function waterSeaVariance(up: Vec3, waves: readonly WaterWave[], sea: WaterSea): number {
  return waterBaseMss(waves) * sea.windScale * sea.noise + waves.reduce((sum, w) => sum + waveVariance(w, up, waveGlintGain(w, up, sea)), 0)
}

/** The variance the faded waves hand to the glint at `footprint`: (1 - W^2)
 * of each wave's, at the wind's scale. */
export function waterLostVariance(footprint: number, up: Vec3, waves: readonly WaterWave[], sea: WaterSea): number {
  return waves.reduce((sum, w) => sum + (1 - weightAt(w, up, sea, footprint) ** 2) * waveVariance(w, up, waveGlintGain(w, up, sea)), 0)
}

/** The glint's slope variances along and across the sea's axis. */
export interface WaterSlope {
  along: number
  cross: number
  axis: Vec3
}

const WATER_MSS_FLOOR = 1e-3

/** The glint's slope variance at `footprint`: the base roughness, half on
 * each axis, and each faded wave's lost variance on the axes as its
 * direction lies (cos^2 and sin^2 of Δ). */
export function waterSlopeVariance(footprint: number, up: Vec3, waves: readonly WaterWave[], sea: WaterSea): WaterSlope {
  let along = 0.5 * waterBaseMss(waves) * sea.windScale * sea.noise
  let cross = along
  for (const w of waves) {
    const lost = (1 - weightAt(w, up, sea, footprint) ** 2) * waveVariance(w, up, waveGlintGain(w, up, sea))
    const c2 = axisCos2(w, up, sea)
    along += lost * (0.5 + 0.5 * c2)
    cross += lost * (0.5 - 0.5 * c2)
  }
  return { along: Math.max(along, 0.5 * WATER_MSS_FLOOR), cross: Math.max(cross, 0.5 * WATER_MSS_FLOOR), axis: sea.axis }
}

/** The glint's total slope variance (along plus across). */
export function waterMss(footprint: number, up: Vec3, waves: readonly WaterWave[], sea: WaterSea): number {
  const { along, cross } = waterSlopeVariance(footprint, up, waves, sea)
  return along + cross
}

/** An isotropic slope of variance `mss` (`axis` any level direction). */
export function isotropicSlope(mss: number, axis: Vec3): WaterSlope {
  return { along: mss / 2, cross: mss / 2, axis }
}

/** Each wave's phase at the eye (`eye` from the centre, the ground's frame)
 * at `time` s, into `out` by its index, mod 2 pi: the GPU adds k.ray. */
export function waterPhases(eye: Vec3, time: number, out: Float32Array | number[]): void {
  for (const w of WATER_WAVE_TABLE) {
    const phase = ((w.k * dot(w.dir, eye)) % TAU) - ((w.omega * time) % TAU)
    out[w.index] = phase - TAU * Math.floor(phase / TAU)
  }
}

/** The eye's place (`eye` from the centre, the ground's frame) in each swell
 * noise octave's cells, mod 289 (the noise's period), into `out`. */
export function waterSwellEye(eye: Vec3, out: readonly THREE.Vector3[]): void {
  WATER_SWELL_KM.forEach((km, i) => {
    const s = EARTH_KM_PER_UNIT / km
    const m = (x: number) => x * s - 289 * Math.floor((x * s) / 289)
    out[i].set(m(eye[0]), m(eye[1]), m(eye[2]))
  })
}

/** The body's colour for a map colour `c` (linear), at `strength` water
 * over `depth` m of it, as the GLSL mixes it. */
export function waterBody(c: Vec3, strength: number, depth = WATER_DEPTH_NEUTRAL): [number, number, number] {
  const tinted = waterTinted(c, depth)
  const lift = Math.min(Math.max(1 - luma(tinted) / WATER_DEEP_LUMA, 0), 1)
  return [0, 1, 2].map((i) => c[i] + strength * (tinted[i] + WATER_DEEP[i] * lift - c[i])) as [number, number, number]
}

const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: Vec3): Vec3 => {
  const l = Math.sqrt(dot(a, a))
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** The glint's reflected radiance over the light's colour, for unit vectors
 * toward the light `l` and the eye `v`, the normal `n` and the level up
 * `up`, at `slope`'s variances along and across its axis, as the GLSL's
 * waterGlint(): anisotropic Beckmann in a frame round `n`, Smith's
 * shadowing on each direction's projected variance. */
export function waterGlint(l: Vec3, v: Vec3, n: Vec3, up: Vec3, slope: WaterSlope): number {
  const hv: Vec3 = [l[0] + v[0], l[1] + v[1], l[2] + v[2]]
  const hl = 1 / Math.sqrt(Math.max(dot(hv, hv), 1e-12))
  const h: Vec3 = [hv[0] * hl, hv[1] * hl, hv[2] * hl]
  const an = dot(slope.axis, n)
  const ar: Vec3 = [slope.axis[0] - n[0] * an, slope.axis[1] - n[1] * an, slope.axis[2] - n[2] * an]
  const a = dot(ar, ar) > 1e-8 ? unit(ar) : unit(cross3(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]))
  const c = cross3(n, a)
  const sat = (x: number) => Math.min(Math.max(x, 0), 1)
  const nl = sat(dot(n, l))
  const nv = sat(dot(n, v))
  const nh2 = Math.max(sat(dot(n, h)) ** 2, 1e-4)
  const vh = sat(dot(v, h))
  const d = beckmannAniso(nh2, dot(h, a), dot(h, c), slope.along, slope.cross)
  const fresnel = WATER_F0 + (1 - WATER_F0) * (1 - vh) ** 5
  const projected = (x: Vec3) => {
    const xa = dot(x, a)
    const xc = dot(x, c)
    const s = xa * xa + xc * xc
    return s > 1e-12 ? (2 * (slope.along * xa * xa + slope.cross * xc * xc)) / s : slope.along + slope.cross
  }
  const g1 = (x: number, a2: number) => (2 * x) / (x + Math.sqrt(a2 + (1 - a2) * x * x))
  return (smoothstep(-0.02, 0.02, dot(up, l)) * fresnel * d * g1(nl, projected(l)) * g1(nv, projected(v))) / (4 * Math.max(nv, 1e-3))
}

/** A pixel's expected count of facets catching the Sun: `facets` of them,
 * the glint's distribution `d` at the half vector, n.h and v.h. */
export function waterSparkleMean(facets: number, d: number, nh: number, vh: number): number {
  return (facets * d * nh * WATER_SUN_SR) / (4 * Math.max(vh, 1e-3))
}

/** The sparkle's scale on the glint for an expected count `lambda` and
 * uniforms `u`, `u2` in [0, 1): a Poisson count over its mean (the normal
 * approximation past 12), as the GLSL draws it. Its mean is 1. */
export function waterSparkle(lambda: number, u: number, u2: number): number {
  let k = 0
  if (lambda > 12) {
    k = Math.max(Math.floor(lambda + Math.sqrt(lambda) * Math.sqrt(-2 * Math.log(Math.max(u, 1e-7))) * Math.cos(TAU * u2) + 0.5), 0)
  } else {
    let p = Math.exp(-lambda)
    let s = p
    for (let i = 0; i < 24 && u > s; i++) {
      k++
      p *= lambda / k
      s += p
    }
  }
  return k / Math.max(lambda, 1e-6)
}

/** The eye's place in metres (`eye` from the centre, the ground's frame),
 * mod WATER_SPARKLE_PERIOD_M, into `out`. */
export function waterSparkleEye(eye: Vec3, out: THREE.Vector3): void {
  const m = (x: number) => {
    const metres = x * METRES_PER_UNIT
    return metres - WATER_SPARKLE_PERIOD_M * Math.floor(metres / WATER_SPARKLE_PERIOD_M)
  }
  out.set(m(eye[0]), m(eye[1]), m(eye[2]))
}

/** Beckmann's distribution of facet normals at cos^2 `nh2` off the mean,
 * for slope variance `mss`. */
export function beckmann(nh2: number, mss: number): number {
  return Math.exp((nh2 - 1) / (nh2 * mss)) / (Math.PI * mss * nh2 * nh2)
}

/** Beckmann's, anisotropic: the half vector's components `ha` and `hc` along
 * and across the axis (round the normal) and slope variances `va` and `vc`
 * on them. Beckmann's own when va = vc = mss / 2. */
export function beckmannAniso(nh2: number, ha: number, hc: number, va: number, vc: number): number {
  const t2 = ha * ha + hc * hc
  const q = t2 > 1e-12 ? (ha * ha / va + hc * hc / vc) / t2 : 0.5 * (1 / va + 1 / vc)
  return Math.exp((0.5 * q * (nh2 - 1)) / nh2) / (2 * Math.PI * Math.sqrt(va * vc) * nh2 * nh2)
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
// reads of the waves is global), the sky, the glint, the body and the sea's
// climate and noise.
const head = () => /* glsl */ `
uniform float uWavePhase[${WATER_WAVES}];
// The eye's place in each swell noise octave's cells, mod 289 (the noise's
// period), from the CPU in double: the GPU adds the ray, so the noise stays
// on the Earth under a moving eye.
uniform vec3 uWaterSwellEye[2];
// The eye's place in metres mod WATER_SPARKLE_PERIOD_M (from the CPU in
// double), and the water's clock in sparkle draws.
uniform vec3 uWaterSparkleEye;
uniform float uWaterTwinkle;
${WATER_CLIMATE_GLSL}
vec3 waterRay;
vec3 waterUpGround;
vec3 waterUpView;
mat3 waterViewToGround;
// The glint's slope variance: along and across the sea's axis (view space,
// level), and their sum.
float waterMss;
float waterVarAlong;
float waterVarCross;
vec3 waterAxisView;
// The pixel's sparkle cell (its Earth-fixed cell, the cell's level) and how
// many facets it spans (0: no sparkle).
uvec4 waterSparkleKey;
float waterFacets;
// The skylit body as the sky piece adds it to indirectDiffuse, for the
// eclipse (eclipseShadow.ts) to dim with the Sun.
#define WATER_SKY_BODY
vec3 waterSkyBody = vec3(0.0);
// Smith's shadowing for a facet slope variance a2.
float waterG1(float x, float a2) {
  return 2.0 * x / (x + sqrt(a2 + (1.0 - a2) * x * x));
}
// The slope variance a direction x sees, on its azimuth round the axis a and
// its cross c (twice the per-axis variance, as waterG1 takes it).
float waterProjected(vec3 x, vec3 a, vec3 c) {
  float xa = dot(x, a);
  float xc = dot(x, c);
  float s = xa * xa + xc * xc;
  return s > 1e-12 ? 2.0 * (waterVarAlong * xa * xa + waterVarCross * xc * xc) / s : waterVarAlong + waterVarCross;
}
// A hash (PCG, 4 lanes: Jarzynski and Olano).
uvec4 waterPcg4(uvec4 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  v ^= v >> 16u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  return v;
}
// The sparkle's scale on the glint (waterSparkle() mirrors the draw): the
// count of the pixel's facets catching the Sun, from the hash of its cell,
// the half vector's slope cell and its own twinkle, over its mean lambda.
float waterSparkle(float lambda, vec2 slope) {
  uvec2 s = uvec2(ivec2(floor(slope * ${f(1 / WATER_SPARKLE_SLOPE)})) + 32768);
  uvec4 h = waterPcg4(waterSparkleKey ^ uvec4(0u, 0u, 0u, (s.x << 16u) ^ s.y ^ (waterSparkleKey.w << 28u)));
  uint tick = uint(floor(uWaterTwinkle + float(h.w) * ${e(1 / 2 ** 32)}));
  h = waterPcg4(h ^ uvec4(tick, tick * 747796405u, 0u, 0u));
  float u = float(h.x) * ${e(1 / 2 ** 32)};
  float k = 0.0;
  if (lambda > 12.0) {
    float u2 = float(h.y) * ${e(1 / 2 ** 32)};
    k = max(floor(lambda + sqrt(lambda) * sqrt(-2.0 * log(max(u, 1e-7))) * cos(${f(TAU)} * u2) + 0.5), 0.0);
  } else {
    float p = exp(-lambda);
    float c = p;
    for (int i = 0; i < 24; i++) {
      if (u <= c) break;
      k += 1.0;
      p *= lambda / k;
      c += p;
    }
  }
  return k / max(lambda, 1e-6);
}
// The glint over the light's colour (waterGlint() mirrors it, the sparkle aside): anisotropic
// Beckmann in a frame round the bent normal (Beckmann's own when the two
// variances are equal), Schlick, Smith, out under the level horizon. No NaN
// with l = -v (h 0).
float waterGlint(vec3 l, vec3 v, vec3 n) {
  vec3 hv = l + v;
  vec3 h = hv * inversesqrt(max(dot(hv, hv), 1e-12));
  vec3 a = waterAxisView - n * dot(waterAxisView, n);
  float aa = dot(a, a);
  a = aa > 1e-8 ? a * inversesqrt(aa) : normalize(cross(n, abs(n.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
  vec3 c = cross(n, a);
  float nl = saturate(dot(n, l));
  float nv = saturate(dot(n, v));
  float nh = saturate(dot(n, h));
  float nh2 = max(nh * nh, 1e-4);
  float ha = dot(h, a);
  float hc = dot(h, c);
  float t2 = ha * ha + hc * hc;
  float q = t2 > 1e-12 ? (ha * ha / waterVarAlong + hc * hc / waterVarCross) / t2 : 0.5 * (1.0 / waterVarAlong + 1.0 / waterVarCross);
  float d = exp(0.5 * q * (nh2 - 1.0) / nh2) / (2.0 * PI * sqrt(waterVarAlong * waterVarCross) * nh2 * nh2);
  float vdh = saturate(dot(v, h));
  float vh = 1.0 - vdh;
  float vh2 = vh * vh;
  float fresnel = ${f(WATER_F0)} + ${f(1 - WATER_F0)} * vh2 * vh2 * vh;
  float sunSin = dot(waterUpView, l);
  float sparkle = 1.0;
  if (waterFacets > 0.0) {
    float glow = ${f(WATER_SPARKLE_GLOW)} * (1.0 - smoothstep(${f(Math.sin((WATER_SPARKLE_GLOW_DEG[0] * Math.PI) / 180))}, ${f(Math.sin((WATER_SPARKLE_GLOW_DEG[1] * Math.PI) / 180))}, sunSin));
    sparkle = mix(waterSparkle(waterFacets * d * nh * ${e(WATER_SUN_SR / 4)} / max(vdh, 1e-3), vec2(ha, hc) / max(nh, 1e-3)), 1.0, glow);
  }
  return smoothstep(-0.02, 0.02, sunSin) * fresnel * d * sparkle
    * waterG1(nl, waterProjected(l, a, c)) * waterG1(nv, waterProjected(v, a, c)) / (4.0 * max(nv, 1e-3));
}
${WATER_DEPTH_GLSL}
// The map's ocean tinted for its depth, then lifted to deep water if still
// darker (waterBody() mirrors it).
vec3 waterBody(vec3 c) {
  c = waterTinted(c);
  return c + ${v3(WATER_DEEP)} * saturate(1.0 - dot(c, vec3(${LUMA.map(f).join(', ')})) / ${f(WATER_DEEP_LUMA)});
}
// Value noise, two channels, on a sine-free hash (mod 289: exact in float).
vec4 waterPermute(vec4 x) {
  return mod((x * 34.0 + 1.0) * x, 289.0);
}
vec2 waterValueNoise(vec3 p) {
  vec3 i = mod(floor(p), 289.0);
  vec3 t = fract(p);
  t = t * t * (3.0 - 2.0 * t);
  vec4 xy = waterPermute(waterPermute(i.xxxx + vec4(0.0, 1.0, 0.0, 1.0)) + i.yyyy + vec4(0.0, 0.0, 1.0, 1.0));
  vec4 h0 = waterPermute(xy + i.z);
  vec4 h1 = waterPermute(xy + i.z + 1.0);
  vec4 a = mix(fract(h0 * ${f(1 / 41)}), fract(h1 * ${f(1 / 41)}), t.z);
  vec4 b = mix(fract(waterPermute(h0) * ${f(1 / 41)}), fract(waterPermute(h1) * ${f(1 / 41)}), t.z);
  vec4 ab = mix(vec4(a.xz, b.xz), vec4(a.yw, b.yw), t.x);
  return mix(ab.xz, ab.yw, t.y) * 2.0 - 1.0;
}
// The sea's large-scale noise at a level up, Earth-fixed, each octave faded
// where a pixel (km) spans an eighth of it; 0 where all have.
vec2 waterSeaNoise(vec3 up, float pixelKm) {
  vec2 n = vec2(0.0);
  float w;${WATER_NOISE_KM.map(
    (km, i) => `
  w = ${f(WATER_NOISE_WEIGHT[i] / NOISE_WEIGHT_SUM)} * (1.0 - smoothstep(${f(km / 16)}, ${f(km / 8)}, pixelKm));
  if (w > 0.0) n += w * waterValueNoise(up * ${f(EARTH_RADIUS_KM / km)});`
  ).join('')}
  return n;
}
`

// One wave, unrolled (no arrays indexed in the loop: those spill on some
// GPUs): its level part at this ground, its gain in this sea, its fade and
// the variance it hands the glint (every water pixel: cheap), then, only
// where it's drawn, its slope. Its fade is on its phase step across the
// pixel (the two steps' length, so a long footprint fades only the waves
// running along it), plus the longer waves' warp, which crowds its crests by
// up to waterWarpK (the warp's steepest pull, level): bent crests sharper
// than the pixel would bring the speckle back. (The TS mirrors fade on the
// wavelength alone: the warp only ever fades a wave sooner.)
const v2 = (c: readonly number[]) => `vec2(${c.map(f).join(', ')})`
/** Each wave's own mix of the swell noise's two channels. */
const swellTurn = (i: number) => [Math.cos(i * 2.39996 + 1), Math.sin(i * 2.39996 + 1)]
const wave = (w: WaterWave) => /* glsl */ `
  waterD = ${v3(w.dir)};
  waterDt = waterD - waterUpGround * dot(waterD, waterUpGround);
  waterDt2 = max(dot(waterDt, waterDt), 1e-8);
  waterDa = dot(waterDt, waterAxis);
  waterC2 = 2.0 * waterDa * waterDa / waterDt2 - 1.0;
  waterA = max(1.0 + waterGroups * dot(waterGroupNoise, ${v2(swellTurn(w.index + 0.5))}), 0.2);
  waterA = waterA * waterA * (1.0 + ${f(WATER_ALIGN)} * waterSettled * waterC2);
  waterF = mix(waterWindF, waterSwellF, ${f(waveSwell(w))}) * waterA;
  waterW = 1.0 - smoothstep(${f(WATER_FADE_START * TAU)}, ${f(WATER_FADE_END * TAU)},
    (${e(w.k)} * length(vec2(dot(waterDt, waterRx), dot(waterDt, waterRy))) + (waterWarpK + waterBendK) * waterPx) * ${f(WATER_GLINT_HARMONIC)} * sqrt(sqrt(waterF)));
  waterLost = (1.0 - waterW * waterW) * waterWindF * waterA * ${e(0.5 * w.slope * w.slope)} * waterDt2;
  waterAlong += waterLost * (0.5 + 0.5 * waterC2);
  waterCross += waterLost * (0.5 - 0.5 * waterC2);
  if (waterW > 0.0) {
    waterS = sin(uWavePhase[${w.index}] + ${e(w.k)} * dot(waterD, waterRay) + waterWarp
      + ${f(WATER_SWELL_BEND)} * dot(waterBendNoise, ${v2(swellTurn(w.index))}));
    waterGrad -= (waterW * sqrt(waterF) * ${f(w.slope)} * waterS) * waterDt;
    waterWarp += waterW * ${f(WATER_WARP)} * waterS;
    waterWarpK += waterW * ${e(WATER_WARP * w.k)} * sqrt(waterDt2);
  }`

// One wave where every wave has faded: only the variance it hands the glint.
const waveFaded = (w: WaterWave) => /* glsl */ `
  waterD = ${v3(w.dir)};
  waterDt = waterD - waterUpGround * dot(waterD, waterUpGround);
  waterDt2 = max(dot(waterDt, waterDt), 1e-8);
  waterDa = dot(waterDt, waterAxis);
  waterC2 = 2.0 * waterDa * waterDa / waterDt2 - 1.0;
  waterLost = waterWindF * (1.0 + ${f(WATER_ALIGN)} * waterSettled * waterC2) * ${e(0.5 * w.slope * w.slope)} * waterDt2;
  waterAlong += waterLost * (0.5 + 0.5 * waterC2);
  waterCross += waterLost * (0.5 - 0.5 * waterC2);`

/** A pixel's narrower step on the sea past which every wave has faded: the
 * longest's fade end, for any wave with a level share over WATER_FADED_LEVEL
 * and a gain over WATER_FADED_GAIN (those under have next to no slope to
 * draw). */
const WATER_FADED_LEVEL = 0.3
const WATER_FADED_GAIN = 0.02
const fadedStep = (waves: readonly WaterWave[]) =>
  (WATER_FADE_END * TAU) /
  (Math.min(...waves.map((w) => w.k)) * WATER_FADED_LEVEL * WATER_GLINT_HARMONIC * WATER_FADED_GAIN ** 0.25)

// After the prelude (waterRay, waterUpGround, waterUpView and
// waterViewToGround set). A pixel's two steps on the sea (waterRx, waterRy:
// the ray's derivatives, exact and anisotropic, the orthographic system
// view's as wide as its pixels) are taken before any branch. Then, on water,
// the sea here: the climate's scales and axis, the noise's scale and turn,
// the waves, and what the faded ones and the base leave to the glint.
const normal = (waves: readonly WaterWave[]) => /* glsl */ `
waterMss = ${f(WATER_MSS)};
waterVarAlong = ${f(WATER_MSS / 2)};
waterVarCross = ${f(WATER_MSS / 2)};
waterAxisView = vec3(0.0);
waterFacets = 0.0;
#if NUM_DIR_LIGHTS > 0
diffuseColor.rgb = mix(diffuseColor.rgb, waterBody(diffuseColor.rgb),
  specularStrength * smoothstep(${f(SKY_DAY[0])}, ${f(SKY_DAY[1])}, dot(waterUpView, directionalLights[0].direction)));
#endif
{
  vec3 waterRx = dFdx(waterRay);
  vec3 waterRy = dFdy(waterRay);
  if (specularStrength > 0.0) {
    float waterPx = max(length(waterRx), length(waterRy));
    vec4 waterClimate = waterClimateDecode(waterClimateAt(waterUpGround));
    vec2 waterNoise = waterSeaNoise(waterUpGround, waterPx * ${f(EARTH_KM_PER_UNIT)});
    float waterNs = clamp(exp2(${f(WATER_NOISE_SCALE)} * waterNoise.x), 0.3, 3.0);
    float waterWindF = waterNs * waterMssScale(waterClimate.x);
    float waterSwellF = waterNs * waterSwellScale(waterClimate.y) * waterSwellScale(waterClimate.y);
    float waterSettled = min(length(waterClimate.zw), 1.0);
    // The axis: compass theta (clockwise from north) of half the doubled
    // angle, turned by the noise.
    float waterTheta = 0.5 * (waterSettled > 1e-4 ? atan(waterClimate.w, waterClimate.z) : 0.0)
      + ${f(WATER_NOISE_TURN)} * waterNoise.y;
    vec3 waterEast = vec3(waterUpGround.z, 0.0, -waterUpGround.x);
    waterEast *= inversesqrt(max(dot(waterEast, waterEast), 1e-12));
    vec3 waterAxis = cross(waterUpGround, waterEast) * cos(waterTheta) + waterEast * sin(waterTheta);
    waterAxisView = waterAxis * waterViewToGround;
    float waterAlong = ${f(0.5 * waterBaseMss(waves))} * waterWindF;
    float waterCross = waterAlong;
    // The swell's bends and groups, near enough for a wave to be drawn.
    vec2 waterBendNoise = vec2(0.0);
    vec2 waterGroupNoise = vec2(0.0);
    float waterBendK = 0.0;
    float waterGroups = 0.0;
    if (waterPx < ${e(3 * Math.max(...waves.map((w) => w.lambda)))}) {
      vec2 waterSwellA = waterValueNoise(uWaterSwellEye[0] + waterRay * ${f(EARTH_KM_PER_UNIT / WATER_SWELL_KM[0])});
      vec2 waterSwellB = waterValueNoise(uWaterSwellEye[1] + waterRay * ${f(EARTH_KM_PER_UNIT / WATER_SWELL_KM[1])});
      waterBendNoise = waterSwellA + 0.5 * waterSwellB;
      waterGroupNoise = vec2(waterSwellB.y, waterSwellA.x);
      waterBendK = ${e(WATER_SWELL_BEND_K * EARTH_KM_PER_UNIT)};
      waterGroups = ${f(WATER_SWELL_GROUPS)} * (1.0 - smoothstep(${f(WATER_SWELL_KM[1] / 16)}, ${f(WATER_SWELL_KM[1] / 8)}, waterPx * ${f(EARTH_KM_PER_UNIT)}));
    }
    // The narrower of the pixel's two steps (the smaller singular value of
    // the pair): past fadedStep every wave has faded, so the cheap path.
    float waterGa = dot(waterRx, waterRx);
    float waterGb = dot(waterRx, waterRy);
    float waterGc = dot(waterRy, waterRy);
    float waterNarrow = sqrt(max(0.5 * (waterGa + waterGc) - sqrt(0.25 * (waterGa - waterGc) * (waterGa - waterGc) + waterGb * waterGb), 0.0));
    // The sparkle's cell: Earth-fixed, a power of two in metres under the
    // narrower step, so each pixel draws its own; and the facets it spans.
    float waterCellLevel = clamp(floor(log2(max(waterNarrow * ${f(METRES_PER_UNIT)}, 1e-3))), -2.0, 10.0);
    float waterCellM = exp2(waterCellLevel);
    vec3 waterCell = mod(floor((uWaterSparkleEye + waterRay * ${f(METRES_PER_UNIT)}) / waterCellM), ${f(WATER_SPARKLE_PERIOD_M)} / waterCellM);
    waterSparkleKey = uvec4(uvec3(waterCell), uint(waterCellLevel + 2.0));
    waterFacets = length(cross(waterRx, waterRy)) * ${e(METRES_PER_UNIT ** 2 / WATER_FACET_M ** 2)};
    vec3 waterGrad = vec3(0.0);
    vec3 waterD;
    vec3 waterDt;
    float waterDt2;
    float waterDa;
    float waterC2;
    float waterA;
    float waterF;
    float waterW;
    float waterLost;
    float waterS;
    float waterWarp = 0.0;
    float waterWarpK = 0.0;
    if (waterNarrow > ${e(fadedStep(waves))}) {${waves.map(waveFaded).join('')}
    } else {${[...waves].sort((a, b) => b.lambda - a.lambda).map(wave).join('')}
    }
    waterVarAlong = max(waterAlong, ${f(WATER_MSS_FLOOR / 2)});
    waterVarCross = max(waterCross, ${f(WATER_MSS_FLOOR / 2)});
    waterMss = waterVarAlong + waterVarCross;
    normal = normalize(normal - specularStrength * (waterGrad * waterViewToGround));
  }
}
`

// After lights_fragment_end, before the shadows dim directSpecular: by day,
// the sky (the ground haze's groundHazeSky(), the atmosphere's own) along
// the reflected ray, Fresnel weighted, and its light in the water's body.
// The sky is scene radiance, not over the Sun's colour: no light colour on
// it. The reflection in directSpecular, so the terrain, the clouds and the
// eclipse dim it with the Sun; the body in indirectDiffuse, as skylight:
// the terrain's view of the sky (groundHorizonSky) and the eclipse
// (waterSkyBody) dim it, not the Sun's shadow. The ground's own sky fill
// (groundDetail.ts) leaves the water to this.
const SKY_LIGHT_EL = (WATER_SKY_LIGHT_ELEVATION * Math.PI) / 180
const SKY = /* glsl */ `
#if NUM_DIR_LIGHTS > 0
if (material.specularStrength > 0.0) {
  float waterDay = smoothstep(${f(SKY_DAY[0])}, ${f(SKY_DAY[1])}, dot(waterUpView, directionalLights[0].direction));
  if (waterDay > 0.0) {
    // The roughness the pixel doesn't draw (the glint's slope variance, along
    // the view's azimuth), over the median sea's, tilts the facets it sees
    // toward the eye, more as the view grazes: a rougher sea mirrors higher,
    // deeper sky at less Fresnel, a calmer one more of the bright horizon, so
    // the sea's state reads off the Sun's road too.
    vec3 waterFacet = geometryNormal;
    vec3 waterToEye = geometryViewDir - waterUpView * dot(geometryViewDir, waterUpView);
    float waterToEye2 = dot(waterToEye, waterToEye);
    if (waterToEye2 > 1e-8) {
      waterToEye *= inversesqrt(waterToEye2);
      float waterEa = dot(waterToEye, waterAxisView);
      float waterVar = waterVarAlong * waterEa * waterEa + waterVarCross * (1.0 - waterEa * waterEa);
      float waterNv0 = saturate(dot(geometryNormal, geometryViewDir));
      // A calm sea's facets turn toward the mirror, never as far as edge-on
      // (the horizon would take a dark rim).
      float waterTilt = max(${f(WATER_SKY_ROUGH)} * (sqrt(waterVar) - ${f(WATER_SKY_ROUGH_MEDIAN)}) * (1.0 - waterNv0), -0.5 * waterNv0);
      waterFacet = normalize(geometryNormal + waterTilt * waterToEye);
    }
    float waterNv = dot(waterFacet, geometryViewDir);
    float waterCos = 1.0 - saturate(waterNv);
    float waterCos2 = waterCos * waterCos;
    float waterFresnel = ${f(WATER_F0)} + ${f(1 - WATER_F0)} * waterCos2 * waterCos2 * waterCos;
    // The reflected ray in the ground's frame, lifted to the level where a
    // wave's facet sends it under the horizon (the sea there would mirror
    // the sea, about as bright as this sky's foot).
    vec3 waterReflected = waterViewToGround * reflect(-geometryViewDir, waterFacet);
    waterReflected = normalize(waterReflected - waterUpGround * min(dot(waterReflected, waterUpGround), 0.0) + waterUpGround * 1e-4);
    // A facet tilted away from the eye (a wave's back at a grazing view) isn't
    // seen: without this it took Fresnel 1 and the horizon's sky.
    vec3 waterReflection = waterFresnel * smoothstep(0.0, 0.05, waterNv) * groundHazeSky(waterUpGround, waterReflected);
    // The skylight's irradiance, pi times the sky's mean, from the one
    // direction whose radiance is that mean (WATER_SKY_LIGHT_ELEVATION),
    // into the body through Lambert, less what the surface reflects on the
    // way out, on deep water's own colour (the maps under the globe and the
    // tiles differ, and the sky's light on them showed the seam) under the
    // depth's tint over deep water's (./waterDepth.ts: lighter and greener
    // over the banks and shelves, darker over the trenches).
    vec3 waterSide = cross(waterUpGround, uGroundHazeSun);
    float waterSide2 = dot(waterSide, waterSide);
    waterSide = waterSide2 > 1e-10 ? waterSide * inversesqrt(waterSide2)
      : normalize(cross(waterUpGround, abs(waterUpGround.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
    vec3 waterSkyLight = PI * groundHazeSky(waterUpGround,
      waterSide * ${f(Math.cos(SKY_LIGHT_EL))} + waterUpGround * ${f(Math.sin(SKY_LIGHT_EL))});
    vec3 waterBodyLight = (1.0 - waterFresnel) * waterSkyLight * BRDF_Lambert(${v3(WATER_DEEP)} * waterTint(waterDepth) / ${v3(WATER_TINT_DEEP)});
    reflectedLight.directSpecular += material.specularStrength * waterDay * waterReflection;
    waterSkyBody = ${f(WATER_BODY_SKY)} * material.specularStrength * waterDay * waterBodyLight;
    reflectedLight.indirectDiffuse += waterSkyBody;
  }
}
#endif
`

/** The water's GLSL for `waves` (the test checks it; the tiles reuse it):
 * head (globals, after common), normal (the body and the waves, after a
 * prelude), direct (after lights_phong_pars_fragment), sky (after
 * lights_fragment_end; the reflection and the skylit body, from the ground
 * haze's groundHazeSky()). */
export function WATER_GLSL(waves: readonly WaterWave[]) {
  return { head: head(), normal: normal(waves), direct: DIRECT, sky: SKY }
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
${WATER_DEPTH_SAMPLE.globe}`,
  },
  tiles: {
    head: '',
    body: /* glsl */ `
waterViewToGround = uSurfaceViewToGround;
waterRay = surfaceRay;
waterUpGround = surfaceUp;
waterUpView = surfaceUp * uSurfaceViewToGround;
${WATER_DEPTH_SAMPLE.tiles}`,
  },
} as const

export interface Water {
  /** The phases, by wave index, and the wave climate (shared by every
   * program that takes the water). */
  uniforms: {
    uWavePhase: THREE.IUniform<Float32Array>
    uWaterClimate: THREE.IUniform<THREE.Texture>
    uWaterSwellEye: THREE.IUniform<THREE.Vector3[]>
    uWaterSparkleEye: THREE.IUniform<THREE.Vector3>
    uWaterTwinkle: THREE.IUniform<number>
  }
  /** Moves the waves on by `dt` seconds, unless `reduced` (prefers-reduced-motion). */
  advance(dt: number, reduced: boolean): void
  /** For each camera before anything draws, after the frame's update
   * (GroundHaze.update): the phases at its eye. */
  update(): void
}

/** The water's clock and phases on the haze's `frame` (its eye). */
export function createWater(frame: GroundHaze['frame']): Water {
  const uniforms = {
    uWavePhase: { value: new Float32Array(WATER_WAVES) },
    uWaterClimate: { value: climateTexture() },
    uWaterSwellEye: { value: [new THREE.Vector3(), new THREE.Vector3()] },
    uWaterSparkleEye: { value: new THREE.Vector3() },
    uWaterTwinkle: { value: 0 },
  }
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
      waterSwellEye(eye, uniforms.uWaterSwellEye.value)
      waterSparkleEye(eye, uniforms.uWaterSparkleEye.value)
      uniforms.uWaterTwinkle.value = (time * WATER_TWINKLE_HZ) % 65536
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
 * `frame`; `low`, the low tier's waves; `depth`, the sea's depth map
 * (./waterDepth.ts). */
export function waterPatch(
  water: Water,
  frame: GroundHaze['frame'],
  low: boolean,
  depth: THREE.IUniform<THREE.Texture>
): MaterialPatch {
  const waves = waterWaves(low)
  const glsl = WATER_GLSL(waves)
  const uniforms = {
    ...water.uniforms,
    uWaterViewToGround: frame.uGroundHazeViewToLocal,
    uWaterEyeGround: frame.uGroundHazeEyeLocal,
    uWaterDepth: depth,
  }
  return {
    onBeforeCompile(shader) {
      Object.assign(shader.uniforms, uniforms)
      let fragment = injectWater(shader.fragmentShader, 'common', WATER_PRELUDE.globe.head + glsl.head)
      fragment = injectWater(fragment, 'lights_phong_pars_fragment', glsl.direct)
      fragment = injectWater(fragment, 'emissivemap_fragment', WATER_PRELUDE.globe.body + glsl.normal, true)
      shader.fragmentShader = injectWater(fragment, 'lights_fragment_end', glsl.sky)
    },
    customProgramCacheKey: () => `water-${waves.length}`,
  }
}
