// Open water that reads as water (tides-07z): the TypeScript mirrors' physics
// (Beckmann's normalisation, the glint at grazing, the waves' variance and
// phases, the body's floor) and where the GLSL lands on the globe's Phong.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createCloudLayer } from './cloudShaders'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { earthHorizon } from './earthHorizonTexture'
import { createGroundHaze } from './groundHaze'
import { groundDetailPatch } from './groundDetail'
import { groundShadowPatch } from './groundShadow'
import { phongShader } from './surface/tile-test-fixtures'
import {
  beckmann,
  BLINN_PHONG_DIRECT,
  createWater,
  WATER_DEEP,
  WATER_DEEP_LUMA,
  WATER_GLSL,
  WATER_MSS,
  WATER_MSS_BASE,
  WATER_FADE_END,
  WATER_FADE_START,
  WATER_PRELUDE,
  WATER_WAVE_TABLE,
  WATER_WAVES,
  WATER_WAVES_LOW,
  waterBaseMss,
  waterBody,
  waterGlint,
  waterLostVariance,
  waterMss,
  waterPatch,
  waterPhases,
  waterWaves,
  waveWeight,
} from './water'

type V = [number, number, number]
const UP: V = [0, 1, 0]
const norm = (v: V): V => {
  const l = Math.hypot(...v)
  return [v[0] / l, v[1] / l, v[2] / l]
}
const TAU = 2 * Math.PI
/** Distance between two angles, mod 2 pi. */
const angleGap = (a: number, b: number) => {
  const d = (((a - b) % TAU) + TAU) % TAU
  return Math.min(d, TAU - d)
}

describe('the glint (tides-07z)', () => {
  it('takes Beckmann\'s distribution, normalised over the projected facets', () => {
    for (const mss of [WATER_MSS_BASE, WATER_MSS]) {
      // The integral of D cos over the hemisphere of facet normals.
      const n = 20000
      let sum = 0
      for (let i = 0; i < n; i++) {
        const theta = ((i + 0.5) / n) * (Math.PI / 2)
        const c = Math.cos(theta)
        sum += beckmann(c * c, mss) * c * Math.sin(theta) * (Math.PI / 2 / n)
      }
      expect(Math.abs(sum * TAU - 1)).toBeLessThan(0.02)
    }
  })

  it('stays finite at grazing, with the light behind the eye and from below', () => {
    const level = [0, 0.001, 0.01]
    for (const lv of level) {
      for (const vv of level) {
        const l = norm([1, lv, 0])
        const v = norm([-1, vv, 0])
        const g = waterGlint(l, v, UP, UP, WATER_MSS)
        expect(Number.isFinite(g)).toBe(true)
        expect(g).toBeGreaterThanOrEqual(0)
      }
    }
    // l = -v: no half vector.
    const l = norm([1, 0.5, 0])
    expect(waterGlint(l, [-l[0], -l[1], -l[2]], UP, UP, WATER_MSS)).toBe(0)
    // The Sun under the level horizon: out, whatever the facet.
    expect(waterGlint(norm([1, -0.05, 0]), norm([-1, 0.05, 0]), norm([0.1, 1, 0]), UP, WATER_MSS)).toBe(0)
  })

  it('is brightest at the mirror direction, and the road widens as the sea roughens', () => {
    const l = norm([1, 0.3, 0])
    const mirror = norm([-1, 0.3, 0])
    const off = norm([-1, 0.3, 0.3])
    const smooth = waterGlint(l, mirror, UP, UP, WATER_MSS_BASE)
    expect(smooth).toBeGreaterThan(waterGlint(l, off, UP, UP, WATER_MSS_BASE))
    expect(waterGlint(l, off, UP, UP, WATER_MSS) / waterGlint(l, mirror, UP, UP, WATER_MSS)).toBeGreaterThan(
      waterGlint(l, off, UP, UP, WATER_MSS_BASE) / smooth
    )
  })
})

describe('the waves (tides-07z)', () => {
  it('runs twelve waves from 120 m, and the low tier keeps the six longest', () => {
    expect(WATER_WAVE_TABLE).toHaveLength(WATER_WAVES)
    const metres = WATER_WAVE_TABLE.map((w) => w.metres).sort((a, b) => b - a)
    expect(metres[0]).toBeCloseTo(120, 9)
    for (let i = 1; i < metres.length; i++) expect(metres[i] / metres[i - 1]).toBeCloseTo(0.715, 9)
    const low = waterWaves(true)
    expect(low).toHaveLength(WATER_WAVES_LOW)
    expect(low.map((w) => w.metres).sort((a, b) => b - a)).toEqual(metres.slice(0, WATER_WAVES_LOW))
    expect(waterWaves(false)).toBe(WATER_WAVE_TABLE)
    // Deep water's dispersion, and unit directions.
    for (const w of WATER_WAVE_TABLE) {
      expect(w.omega).toBeCloseTo(Math.sqrt((9.81 * TAU) / w.metres), 9)
      expect(Math.hypot(...w.dir)).toBeCloseTo(1, 9)
    }
  })

  it('fades a wave out from WATER_FADE_START to WATER_FADE_END of its wavelength', () => {
    expect(waveWeight(0, 1)).toBe(1)
    expect(waveWeight(WATER_FADE_START, 1)).toBe(1)
    expect(waveWeight(WATER_FADE_END, 1)).toBe(0)
    let last = 1
    for (let x = 0; x <= 0.5; x += 0.01) {
      const w = waveWeight(x, 1)
      expect(w).toBeLessThanOrEqual(last)
      last = w
    }
  })

  it('hands every faded wave\'s slope variance to the glint: the whole sea\'s at full fade, on either tier', () => {
    const ups: V[] = [UP, [1, 0, 0], norm([0.3, 0.5, -0.8]), norm([-0.6, -0.2, 0.4])]
    for (const low of [false, true]) {
      const waves = waterWaves(low)
      for (const up of ups) {
        expect(waterLostVariance(1e9, up, waves) + waterBaseMss(waves)).toBeCloseTo(WATER_MSS, 12)
        expect(waterMss(1e9, up, waves)).toBeCloseTo(WATER_MSS, 12)
        // With every wave drawn, the tier's base, give or take how the
        // waves' directions lie against this up (the long waves, carrying
        // more of the slope, swing it most).
        expect(Math.abs(waterLostVariance(0, up, waves))).toBeLessThan(low ? 0.008 : 0.003)
      }
    }
    expect(waterBaseMss(waterWaves(false))).toBeCloseTo(WATER_MSS_BASE, 12)
    expect(waterBaseMss(waterWaves(true))).toBeGreaterThan(WATER_MSS_BASE)
  })

  it('keeps its phases fixed to the Earth: the eye\'s phase plus k.ray is the phase at eye + ray', () => {
    const eye: V = [1.2, 2.1, -1.6] // ~2.9 units out, the ground's radius
    const ray: V = [3e-4, -1e-4, 2e-4]
    const at = new Float32Array(WATER_WAVES)
    const there = new Float64Array(WATER_WAVES) as unknown as number[]
    const here = new Float64Array(WATER_WAVES) as unknown as number[]
    for (const t of [0, 13.7]) {
      waterPhases(eye, t, here)
      waterPhases([eye[0] + ray[0], eye[1] + ray[1], eye[2] + ray[2]], t, there)
      for (const w of WATER_WAVE_TABLE) {
        const k = w.k * (w.dir[0] * ray[0] + w.dir[1] * ray[1] + w.dir[2] * ray[2])
        expect(angleGap(here[w.index] + k, there[w.index])).toBeLessThan(1e-6)
        expect(here[w.index]).toBeGreaterThanOrEqual(0)
        expect(here[w.index]).toBeLessThan(TAU)
      }
    }
    // And they travel: w t later, the same phase w t back.
    waterPhases(eye, 0, here)
    waterPhases(eye, 2, at)
    for (const w of WATER_WAVE_TABLE) expect(angleGap(at[w.index] + w.omega * 2, here[w.index])).toBeLessThan(1e-5)
  })

  it('stands still under prefers-reduced-motion, and follows the frame\'s eye', () => {
    const haze = createGroundHaze({ value: new THREE.Vector3(1, 0, 0) }, 2.95, false)
    haze.frame.uGroundHazeEyeLocal.value.set(0.4, 2.9, 0.1)
    const water = createWater(haze.frame)
    water.update()
    const still = Array.from(water.uniforms.uWavePhase.value)
    water.advance(5, true)
    water.update()
    expect(Array.from(water.uniforms.uWavePhase.value)).toEqual(still)
    water.advance(5, false)
    water.update()
    expect(Array.from(water.uniforms.uWavePhase.value)).not.toEqual(still)
    const expected = new Float32Array(WATER_WAVES)
    waterPhases([0.4, 2.9, 0.1], 5, expected)
    for (let i = 0; i < WATER_WAVES; i++) expect(angleGap(water.uniforms.uWavePhase.value[i], expected[i])).toBeLessThan(1e-5)
  })
})

describe('the body (tides-07z)', () => {
  it('leaves colour at or above deep water\'s, and the land, as it is', () => {
    for (const c of [[0.03, 0.05, 0.08], [0.2, 0.3, 0.1], [0.008, 0.022, 0.045]] as V[]) {
      waterBody(c, 1).forEach((x, i) => expect(x).toBeCloseTo(c[i], 12))
    }
    const dark: V = [0.001, 0.002, 0.004]
    expect(waterBody(dark, 0)).toEqual(dark)
  })

  it('lifts darker water to deep water\'s floor, monotonically', () => {
    waterBody([0, 0, 0], 1).forEach((x, i) => expect(x).toBeCloseTo(WATER_DEEP[i], 12))
    const lum = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    let last = 0
    for (let g = 0; g <= 0.05; g += 0.001) {
      const out = lum(waterBody([g, g, g], 1))
      expect(out).toBeGreaterThanOrEqual(last - 1e-12)
      expect(out).toBeGreaterThanOrEqual(WATER_DEEP_LUMA - 1e-12)
      last = out
    }
  })
})

describe('the water\'s GLSL on the globe (tides-07z)', () => {
  const sun = { value: new THREE.Vector3(1, 0, 0) }
  const haze = createGroundHaze(sun, 2.95, false)

  it('replaces three\'s own direct light, the glint for its specular line only', () => {
    // A three upgrade that changes RE_Direct_BlinnPhong fails here, not on screen.
    expect(THREE.ShaderChunk.lights_phong_pars_fragment).toContain(BLINN_PHONG_DIRECT)
    const direct = WATER_GLSL(WATER_WAVE_TABLE).direct
    expect(direct).toContain(
      '\tif ( material.specularStrength > 0.0 ) reflectedLight.directSpecular += material.specularStrength * waterGlint( directLight.direction, geometryViewDir, geometryNormal ) * directLight.color;'
    )
    expect(direct).not.toContain('BRDF_BlinnPhong')
    const lines = direct.split('\n')
    const blinn = BLINN_PHONG_DIRECT.split('\n')
    expect(lines[0]).toBe(blinn[0].replace('RE_Direct_BlinnPhong(', 'RE_Direct_Water('))
    expect(lines.slice(1, 4)).toEqual(blinn.slice(1, 4))
    expect(direct).toContain('#undef RE_Direct\n#define RE_Direct RE_Direct_Water')
  })

  it('lands each piece where it belongs, and the sky before the shadows dim the specular', () => {
    const water = createWater(haze.frame)
    const eclipse = createEclipseShadow('earth')
    const clouds = createCloudLayer(eclipse, false)
    const patch = composePatches(
      eclipse.material,
      clouds.groundPatch,
      groundDetailPatch(false),
      groundShadowPatch(sun, earthHorizon('horizon.bin')),
      waterPatch(water, haze.frame, false)
    )
    const shader = phongShader()
    patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
    const f = shader.fragmentShader
    const glsl = WATER_GLSL(WATER_WAVE_TABLE)
    const at = (text: string) => {
      const i = f.indexOf(text)
      expect(i, text.slice(0, 60)).toBeGreaterThan(-1)
      return i
    }
    expect(at('#include <common>')).toBeLessThan(at('uniform float uWavePhase[12];'))
    expect(at('uniform float uWavePhase[12];')).toBeLessThan(at('void main'))
    expect(at('#include <lights_phong_pars_fragment>')).toBeLessThan(at('#define RE_Direct RE_Direct_Water'))
    // The waves after every patch's normal_fragment_maps code (the ground
    // detail's groundUp stays the unbent normal), before the emissive.
    expect(at('vec3 groundUp = normal;')).toBeLessThan(at(WATER_PRELUDE.globe.body + glsl.normal))
    expect(at(glsl.normal)).toBeLessThan(at('#include <emissivemap_fragment>'))
    // The sky after the lights, before the terrain shadow, the cloud
    // shadow and the eclipse multiply directSpecular.
    const sky = at(glsl.sky)
    expect(at('#include <lights_fragment_end>')).toBeLessThan(sky)
    expect(sky).toBeLessThan(at('reflectedLight.directSpecular *= sunLit;'))
    expect(sky).toBeLessThan(at('reflectedLight.directSpecular *= cloudLit;'))
    expect(sky).toBeLessThan(at('reflectedLight.directSpecular *= eclipse.x;'))
    // The body after the strength, before the lights take the colour, by
    // day only (the Sun over this sea's level).
    expect(at('#include <specularmap_fragment>')).toBeLessThan(at('waterBody(diffuseColor.rgb)'))
    expect(at('waterBody(diffuseColor.rgb)')).toBeLessThan(at('#include <lights_phong_fragment>'))
    expect(glsl.normal).toMatch(/waterBody\(diffuseColor\.rgb\),\s*specularStrength \* smoothstep\([^)]*dot\(waterUpView, directionalLights\[0\]\.direction\)\)/)
    // Its uniforms: the phases and the haze's frame, the same objects.
    expect(shader.uniforms.uWavePhase).toBe(water.uniforms.uWavePhase)
    expect(shader.uniforms.uWaterViewToGround).toBe(haze.frame.uGroundHazeViewToLocal)
    expect(shader.uniforms.uWaterEyeGround).toBe(haze.frame.uGroundHazeEyeLocal)
    // No varyings of its own, nothing in the vertex stage.
    const base = phongShader()
    composePatches(eclipse.material, clouds.groundPatch, groundDetailPatch(false), groundShadowPatch(sun, earthHorizon('horizon.bin')))
      .onBeforeCompile(base, {} as THREE.WebGLRenderer)
    expect(f.split('varying ').length).toBe(base.fragmentShader.split('varying ').length)
    expect(shader.vertexShader).toBe(base.vertexShader)
    expect(shader.vertexShader).not.toContain('water')
  })

  it('takes the tier\'s waves, keyed by their count', () => {
    const water = createWater(haze.frame)
    expect(waterPatch(water, haze.frame, false).customProgramCacheKey()).toBe('water-12')
    expect(waterPatch(water, haze.frame, true).customProgramCacheKey()).toBe('water-6')
    const full = WATER_GLSL(waterWaves(false)).normal
    const low = WATER_GLSL(waterWaves(true)).normal
    expect(full.split('waterGrad -=').length - 1).toBe(WATER_WAVES)
    expect(low.split('waterGrad -=').length - 1).toBe(WATER_WAVES_LOW)
    for (const w of waterWaves(true)) expect(low).toContain(`uWavePhase[${w.index}]`)
  })

  it('takes its derivatives before any branch, and skips the waves where the strength is 0', () => {
    const normal = WATER_GLSL(WATER_WAVE_TABLE).normal
    expect(normal.indexOf('dFdx(')).toBeLessThan(normal.indexOf('if ('))
    expect(normal).toContain('if (specularStrength > 0.0 && waterFootprint < ')
    expect(WATER_GLSL(WATER_WAVE_TABLE).sky).toContain('if (material.specularStrength > 0.0) {')
  })
})
