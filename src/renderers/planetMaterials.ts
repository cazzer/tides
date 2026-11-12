// The lit-globe material and its uniforms, shared by the planets
// (PlanetRenderer.tsx) and the major moons (moons/MoonBodies.tsx), and the
// planets' haze shell's material (PlanetAtmosphere). The
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
 * the moons', tides-2hv.8) shares one compiled program.
 */
export function planetSurfaceMaterial(
  sunDir: { value: THREE.Vector3 },
  {
    map = null,
    ringMap = null,
    shadowed = false,
    lowQuality = isLowQuality(),
  }: {
    map?: THREE.Texture | null
    ringMap?: THREE.Texture | null
    shadowed?: boolean
    lowQuality?: boolean
  } = {}
): THREE.ShaderMaterial {
  // Set even untextured, so a moon whose map arrives later (MoonBodies)
  // and the planets still share one program per variant. The tier is the
  // page's (quality.ts) unless a test picks one.
  const defines: Record<string, unknown> = {
    PLANET_DETAIL_OCTAVES: lowQuality ? LOW_QUALITY_DETAIL_OCTAVES : DETAIL_OCTAVES,
  }
  if (map) defines.USE_PLANET_MAP = ''
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
