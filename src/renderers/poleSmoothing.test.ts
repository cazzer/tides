import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  POLE_SMOOTH_ARC,
  POLE_SMOOTH_FROM,
  poleSmoothing,
  poleSmoothingGlsl,
  poleSmoothingPairGlsl,
  poleSmoothingLod,
  poleSmoothingPatch,
  poleSmoothingSpanU,
} from './poleSmoothing'

describe('pole smoothing', () => {
  it('leaves the map alone away from the poles and takes over at them', () => {
    expect(poleSmoothing(0)).toBe(0)
    expect(poleSmoothing(POLE_SMOOTH_FROM)).toBe(0)
    expect(poleSmoothing(90)).toBe(1)
    expect(poleSmoothing(-90)).toBe(1)
    let prev = 0
    for (let lat = POLE_SMOOTH_FROM; lat <= 90; lat += 0.5) {
      expect(poleSmoothing(lat)).toBeGreaterThanOrEqual(prev)
      prev = poleSmoothing(lat)
    }
  })

  it('averages a fixed distance on the ground, up to the whole parallel', () => {
    for (const lat of [80, 84, 88]) {
      const lonDeg = poleSmoothingSpanU(lat) * 360
      expect(lonDeg * Math.cos((lat * Math.PI) / 180)).toBeCloseTo(POLE_SMOOTH_ARC, 6)
    }
    expect(poleSmoothingSpanU(90)).toBe(0.5)
  })

  it('taps a mip about a third of the average wide', () => {
    // 10800 texels around: 30 per degree, so a ~1.07° texel is 2^5.
    expect(poleSmoothingLod(10800)).toBeCloseTo(5, 1)
    expect(poleSmoothingLod(2048)).toBeLessThan(poleSmoothingLod(10800))
  })

  it('emits the taps it is asked for', () => {
    const glsl = poleSmoothingGlsl('smoothed', 6)
    expect(glsl).toContain('vec4 smoothed(sampler2D map')
    expect(glsl).toContain('i < 6;')
  })

  it('emits the pair, each map read at the same taps (tides-tvr.4.11)', () => {
    const one = poleSmoothingGlsl('smoothed', 6)
    const pair = poleSmoothingPairGlsl('smoothedPair', 6)
    expect(pair).toContain('void smoothedPair(sampler2D a, sampler2D b, vec2 uv, float lod, inout vec4 colourA, inout vec4 colourB)')
    expect(pair).toContain('i < 6;')
    // The weight, the span and each tap's offset as the single read has them.
    for (const line of one.split('\n').filter((l) => /float (lat|w|span|o) = /.test(l))) expect(pair).toContain(line)
    expect(pair).toContain('sumA += textureLod(a, q, lod);')
    expect(pair).toContain('sumB += textureLod(b, q, lod);')
  })

  it("patches the ground's day-map sample", () => {
    const shader = {
      uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
      vertexShader: THREE.ShaderLib.phong.vertexShader,
      fragmentShader: THREE.ShaderLib.phong.fragmentShader,
    } as THREE.WebGLProgramParametersWithUniforms
    const patch = poleSmoothingPatch()
    patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>')
    expect(shader.fragmentShader).toContain('poleSmoothed(map, vMapUv')
    expect(shader.fragmentShader.indexOf('vec4 poleSmoothed(')).toBeLessThan(
      shader.fragmentShader.indexOf('poleSmoothed(map, vMapUv')
    )
    expect(patch.customProgramCacheKey()).toBe('pole-smoothing')
  })
})
