// The lit-globe material and its uniforms, shared by the planets
// (PlanetRenderer.tsx) and the major moons (moons/MoonBodies.tsx), the
// planets' haze shell's material (PlanetAtmosphere) and the gas giants'
// cloud-deck fog's (PlanetDeck). The
// scene's directional sunlight is aimed at the Earth, so these take the Sun's
// direction in the body's own frame instead (sunDirection).
import * as THREE from 'three'
import { MAX_RING_BANDS, sunDirectionInFrame } from './planetFrame'
import { AMBIENT_COLOR, AMBIENT_INTENSITY, SUNLIGHT_INTENSITY } from '../lighting'
import { isLowQuality } from '../quality'
import planetVertex from '../shaders/planet/vertex.glsl'
import planetFragment from '../shaders/planet/fragment.frag'
import shellVertex from '../shaders/shell/vertex.glsl'
import atmosphereFragment from '../shaders/atmosphere/fragment.frag'
import deckFragment from '../shaders/planet/deck.frag'

/** The scene's ambient fill, as the planets' shaders take it. */
export const AMBIENT = new THREE.Color(AMBIENT_COLOR).multiplyScalar(AMBIENT_INTENSITY)

/**
 * A `uSunDir` uniform and the mesh's onBeforeRender that keeps it current,
 * from the mesh's final transform for this frame (three calls it with the
 * mesh as `this`).
 */
export function sunDirection(): {
  uniform: { value: THREE.Vector3 }
  onBeforeRender: (this: THREE.Object3D) => void
} {
  const uniform = { value: new THREE.Vector3(1, 0, 0) }
  function onBeforeRender(this: THREE.Object3D) {
    sunDirectionInFrame(this, uniform.value)
  }
  return { uniform, onBeforeRender }
}

export type BandUniforms = {
  uBands: { value: THREE.Vector3[] }
  uBandCount: { value: number }
}

export function bandUniforms(): BandUniforms {
  return {
    uBands: {
      value: Array.from({ length: MAX_RING_BANDS }, () => new THREE.Vector3()),
    },
    uBandCount: { value: 0 },
  }
}

/**
 * Procedural detail finer than a globe's map (tides-01v.3), faded in as the
 * map is magnified: flowing bands for the gas giants, ridged rock, or Venus's
 * cloud-deck streaks. `strength` scales the albedo contrast; `bump` (rock)
 * tilts the lit normal by the detail's relief.
 */
export interface PlanetDetail {
  style: 'bands' | 'rock' | 'streaks'
  strength: number
  bump?: number
}

// fragment.frag's DETAIL_* values; 0 is no detail.
export const DETAIL_STYLES = { bands: 1, rock: 2, streaks: 3 } as const

/** Noise octaves in the detail: fewer on the low quality tier. */
export const DETAIL_OCTAVES = 5
export const LOW_QUALITY_DETAIL_OCTAVES = 2
/** The bands' octaves on the high tier, for the ship's dive to the cloud
 * tops (tides-ufyr.8.2); the finer ones show only that close. The low tier
 * keeps LOW_QUALITY_DETAIL_OCTAVES. No more: the noise is keyed to the unit
 * sphere, and the 6th octave on an 8k map already puts |p| near 1.25e5
 * (float steps ~0.008 of a wavelength); finer ones would terrace, and need
 * a noise origin local to the eye (tides-ufyr.8.3's dive can revisit). */
export const BAND_DETAIL_OCTAVES = 6

// The bands' detail flows with the zonal winds (tides-ufyr.8.2, high tier
// only), mirroring detail.glsl's PLANET_DETAIL_FLOW block. By the page's
// clock, not the simulation's: a slow ambient drift, kept under reduced
// motion.

/** [TUNE] The fastest jet's angular rate, rad/s. */
export const DETAIL_FLOW_RATE = 1e-4
/** [TUNE] Seconds each phase is carried before it restarts. */
export const DETAIL_FLOW_PERIOD = 30
/** uDetailTime wraps after this many periods, keeping it precise as a
 * float; each phase's offset repeats only as often. */
export const DETAIL_FLOW_CYCLES = 64
/** Each cycle's noise offset spans this much (unit-sphere units) a side:
 * many of the coarsest octave's wavelengths, so cycles don't correlate. */
export const DETAIL_FLOW_OFFSET = 0.1

/** The zonal wind at `lat` (radians), rad/s: as on Jupiter and Saturn, a
 * prograde equatorial jet, reversing at ±15° and alternating poleward every
 * 30°, mirrored across the equator and still at the poles. */
export function bandFlowRate(lat: number): number {
  return DETAIL_FLOW_RATE * Math.cos(lat) * Math.cos(6 * lat)
}

/** The flow's two phases at `time` seconds: how long each has carried its
 * noise (0..DETAIL_FLOW_PERIOD), its triangle weight (they sum to 1, and a
 * phase restarts only at weight 0), its cycle, and the key its offset is
 * hashed from: even for the first phase, odd for the second, as the two
 * share a cycle for half of every period. */
export function bandFlowPhases(
  time: number
): { t: number; weight: number; cycle: number; key: number }[] {
  return [0, 0.5].map((shift) => {
    const cycles = time / DETAIL_FLOW_PERIOD + shift
    const f = cycles - Math.floor(cycles)
    const cycle = Math.floor(cycles) % DETAIL_FLOW_CYCLES
    return {
      t: f * DETAIL_FLOW_PERIOD,
      weight: 1 - Math.abs(2 * f - 1),
      cycle,
      key: 2 * cycle + 2 * shift,
    }
  })
}

/** The page clock's `seconds` as uDetailTime: wrapped to whole cycles, so
 * the flow doesn't jump at the wrap. */
export function detailFlowTime(seconds: number): number {
  const span = DETAIL_FLOW_CYCLES * DETAIL_FLOW_PERIOD
  return ((seconds % span) + span) % span
}

const glslFloat = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`)

// detail.glsl's PLANET_DETAIL_FLOW block and its constants.
function flowDefines(): Record<string, string> {
  return {
    PLANET_DETAIL_FLOW: '',
    DETAIL_FLOW_RATE: glslFloat(DETAIL_FLOW_RATE),
    DETAIL_FLOW_PERIOD: glslFloat(DETAIL_FLOW_PERIOD),
    DETAIL_FLOW_CYCLES: glslFloat(DETAIL_FLOW_CYCLES),
    DETAIL_FLOW_OFFSET: glslFloat(DETAIL_FLOW_OFFSET),
  }
}

/** Sets a globe material's detail; uniforms only, so no recompile. */
export function setPlanetDetail(material: THREE.ShaderMaterial, detail?: PlanetDetail) {
  const u = material.uniforms
  u.uDetailStyle.value = detail ? DETAIL_STYLES[detail.style] : 0
  u.uDetailStrength.value = detail?.strength ?? 0
  u.uDetailBump.value = detail?.bump ?? 0
}

/**
 * The globes' material: Sun-lit diffuse (Minnaert, uMinnaert 1 is Lambert)
 * with the scene's ambient fill, lit from `sunDir` (sunDirection). Untextured
 * and unshadowed, it is a plain uColor; every such globe (the planets' and
 * the moons', tides-2hv.8) shares one compiled program. `flowingBands`, for
 * a textured globe whose detail is bands, makes them flow on the high tier
 * (a program of its own: uDetailTime, set per frame); without it, bands
 * hold still.
 */
export function planetSurfaceMaterial(
  sunDir: { value: THREE.Vector3 },
  {
    map = null,
    ringMap = null,
    shadowed = false,
    flowingBands = false,
    lowQuality = isLowQuality(),
  }: {
    map?: THREE.Texture | null
    ringMap?: THREE.Texture | null
    shadowed?: boolean
    flowingBands?: boolean
    lowQuality?: boolean
  } = {}
): THREE.ShaderMaterial {
  // Set even untextured, so a moon whose map arrives later (MoonBodies)
  // and the planets still share one program per variant. The tier is the
  // page's (quality.ts) unless a test picks one.
  const defines: Record<string, unknown> = {
    PLANET_DETAIL_OCTAVES: lowQuality ? LOW_QUALITY_DETAIL_OCTAVES : DETAIL_OCTAVES,
    PLANET_BAND_OCTAVES: lowQuality ? LOW_QUALITY_DETAIL_OCTAVES : BAND_DETAIL_OCTAVES,
  }
  if (map) defines.USE_PLANET_MAP = ''
  if (map && flowingBands && !lowQuality) Object.assign(defines, flowDefines())
  if (shadowed) {
    defines.USE_RING_SHADOW = ''
    defines.MAX_RING_BANDS = MAX_RING_BANDS
  }
  if (ringMap) defines.USE_RING_MAP = ''
  return new THREE.ShaderMaterial({
    vertexShader: planetVertex,
    fragmentShader: planetFragment,
    defines,
    uniforms: {
      uSunDir: sunDir,
      uColor: { value: new THREE.Color() },
      uAlbedo: { value: 1 },
      uSunIntensity: { value: SUNLIGHT_INTENSITY },
      uAmbient: { value: AMBIENT },
      uMinnaert: { value: 1 },
      uMap: { value: map },
      uRingMap: { value: ringMap },
      uRingInner: { value: 0 },
      uRingOuter: { value: 0 },
      uRingOpacity: { value: 1 },
      uDetailStyle: { value: 0 },
      uDetailStrength: { value: 0 },
      uDetailBump: { value: 0 },
      uDetailTime: { value: 0 },
      ...bandUniforms(),
    },
  })
}

/**
 * A planet's additive haze shell (PlanetAtmosphere), lit from `sunDir`
 * (sunDirection); its sizes and colours are set on the uniforms. Double-
 * sided within the ship's reach of it, as the Earth's (pickShellFaces,
 * tides-ufyr.4), where the shader keeps one face per ray and, at uSeaLevel
 * 0, adds the haze ahead from inside with no ground cover (no HAZE_COVER).
 * Single pass: three would otherwise draw a transparent double-sided
 * material as a back pass and a front pass, two programs, and the shader's
 * own choice of face would be drawn twice. That program is warmed ahead
 * (ship-warmup.ts warmSides).
 */
export function planetAtmosphereMaterial(sunDir: { value: THREE.Vector3 }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: shellVertex,
    fragmentShader: atmosphereFragment,
    uniforms: {
      uSurface: { value: 0 },
      uOuter: { value: 0 },
      uScaleHeight: { value: 0 },
      uSeaLevel: { value: 0 },
      uSun: sunDir,
      uGain: { value: 1 },
      uSky: { value: new THREE.Color() },
      uDusk: { value: new THREE.Color() },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    forceSinglePass: true,
    userData: { warmSides: [THREE.DoubleSide] },
  })
}

/**
 * A gas giant's cloud-deck fog (PlanetDeck, tides-ufyr.8.3), lit from
 * `sunDir` (sunDirection); its sizes, map and detail are set on the
 * uniforms, so every giant shares one program per side on a tier: the
 * bands' octaves, flowing on the high tier as the globes' do, and the rings'
 * shadow, by map or bands (uRingHasMap). Blended over
 * what is drawn (normal alpha, after the hazes and rings), double-sided
 * within the ship's reach (pickShellFaces) in one pass, as the hazes are,
 * that program warmed ahead (ship-warmup.ts warmSides). It writes no depth;
 * the depth test goes off within reach, where its back faces lie beyond the
 * globe.
 */
export function planetDeckMaterial(
  sunDir: { value: THREE.Vector3 },
  { lowQuality = isLowQuality() }: { lowQuality?: boolean } = {}
): THREE.ShaderMaterial {
  // The globes' octaves, so the bands' contrast matches the cloud top's.
  // The rings' shadow for any giant, map or bands (ring/profile.glsl).
  const defines: Record<string, unknown> = {
    PLANET_DETAIL_OCTAVES: lowQuality ? LOW_QUALITY_DETAIL_OCTAVES : DETAIL_OCTAVES,
    PLANET_BAND_OCTAVES: lowQuality ? LOW_QUALITY_DETAIL_OCTAVES : BAND_DETAIL_OCTAVES,
    ...(!lowQuality && flowDefines()),
    RING_PROFILE_EITHER: '',
    MAX_RING_BANDS,
  }
  return new THREE.ShaderMaterial({
    vertexShader: shellVertex,
    fragmentShader: deckFragment,
    defines,
    uniforms: {
      uOuter: { value: 0 },
      uRadius: { value: 0 },
      uScaleHeight: { value: 0 },
      uVisibility: { value: 1 },
      uSunDepth: { value: 1 },
      uDeckFade: { value: 0 },
      uPixelAngle: { value: 0 },
      uSunDir: sunDir,
      uAlbedo: { value: 1 },
      uSunIntensity: { value: SUNLIGHT_INTENSITY },
      uAmbient: { value: AMBIENT },
      uMinnaert: { value: 1 },
      uMap: { value: null },
      uDetailStyle: { value: 0 },
      uDetailStrength: { value: 0 },
      uDetailBump: { value: 0 },
      uDetailTime: { value: 0 },
      uRingInner: { value: 0 },
      uRingOuter: { value: 0 },
      uRingOpacity: { value: 0 },
      uRingMap: { value: null },
      uRingHasMap: { value: false },
      ...bandUniforms(),
    },
    transparent: true,
    depthWrite: false,
    forceSinglePass: true,
    userData: { warmSides: [THREE.DoubleSide] },
  })
}
