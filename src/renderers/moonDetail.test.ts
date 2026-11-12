import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { MOON_SURFACE_DETAIL, moonDetailPatch } from './moonDetail'
import { composePatches, createEclipseShadow, type MaterialPatch } from './eclipseShadow'
import detailGlsl from '../shaders/planet/detail.glsl'

function phong() {
  return {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
    vertexShader: THREE.ShaderLib.phong.vertexShader,
    fragmentShader: THREE.ShaderLib.phong.fragmentShader,
  }
}

function compile(patch: MaterialPatch, shader = phong()) {
  patch.onBeforeCompile(
    shader as THREE.WebGLProgramParametersWithUniforms,
    {} as THREE.WebGLRenderer
  )
  return shader
}

// The patch's own GLSL: the lines it adds to the Phong shader.
function added(low: boolean): string {
  const base = phong()
  const shader = compile(moonDetailPatch(low))
  const own = (patched: string, original: string) => {
    const lines = new Set(original.split('\n'))
    return patched.split('\n').filter((line) => !lines.has(line))
  }
  return [
    ...own(shader.vertexShader, base.vertexShader),
    ...own(shader.fragmentShader, base.fragmentShader),
  ].join('\n')
}

describe('moon detail patch', () => {
  it('declares after common and shades after normal_fragment_maps', () => {
    const { vertexShader, fragmentShader } = compile(moonDetailPatch(false))
    expect(vertexShader).toMatch(/#include <begin_vertex>\s+vMoonDetailPos = position;/)
    const common = fragmentShader.indexOf('#include <common>')
    const head = fragmentShader.indexOf('void planetDetail(')
    const maps = fragmentShader.indexOf('#include <normal_fragment_maps>')
    const body = fragmentShader.indexOf('planetDetail(moonDetailN')
    const lights = fragmentShader.indexOf('#include <lights_phong_fragment>')
    expect(common).toBeGreaterThanOrEqual(0)
    expect(head).toBeGreaterThan(common)
    expect(maps).toBeGreaterThan(head)
    expect(body).toBeGreaterThan(maps)
    expect(lights).toBeGreaterThan(body)
    expect(fragmentShader).toContain(detailGlsl)
    // vite-plugin-glsl resolved detail.glsl's own include.
    expect(fragmentShader).toContain('float snoise3(')
    expect(fragmentShader).not.toMatch(/#include \.\.?\//)
  })

  it('composes with the eclipse shadow', () => {
    const eclipse = createEclipseShadow('moon').material
    const patch = composePatches(eclipse, moonDetailPatch(false))
    const { vertexShader, fragmentShader } = compile(patch)
    expect(fragmentShader).toMatch(/float lit = sqrt\(eclipse\.x\);/)
    expect(fragmentShader).toContain('planetDetail(moonDetailN')
    expect(vertexShader).toContain('vEclipsePoint = eclipsePoint(position);')
    expect(vertexShader).toContain('vMoonDetailPos = position;')
    expect(patch.customProgramCacheKey()).toContain(eclipse.customProgramCacheKey())
  })

  it('caps the octaves on the low tier, under its own cache key', () => {
    expect(compile(moonDetailPatch(false)).fragmentShader).toMatch(/#define PLANET_DETAIL_OCTAVES 5\n/)
    expect(compile(moonDetailPatch(true)).fragmentShader).toMatch(/#define PLANET_DETAIL_OCTAVES 2\n/)
    const high = moonDetailPatch(false).customProgramCacheKey()
    const low = moonDetailPatch(true).customProgramCacheKey()
    expect(high).not.toBe(low)
    const eclipse = createEclipseShadow('moon').material
    const key = (lowTier: boolean) =>
      composePatches(eclipse, moonDetailPatch(lowTier)).customProgramCacheKey()
    expect(key(false)).not.toBe(key(true))
  })

  it('sets the rock style and its constants', () => {
    const { uniforms } = compile(moonDetailPatch(false))
    expect(uniforms.uDetailStyle.value).toBe(2)
    expect(uniforms.uDetailStrength.value).toBe(MOON_SURFACE_DETAIL.strength)
    expect(uniforms.uDetailBump.value).toBe(MOON_SURFACE_DETAIL.bump)
  })

  it('adds no texture', () => {
    expect(added(false)).not.toMatch(/sampler2D/)
  })

  it('throws on a shader without its chunks', () => {
    const shader = phong()
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', '')
    expect(() => compile(moonDetailPatch(false), shader)).toThrow(/normal_fragment_maps/)
    const vertexless = phong()
    vertexless.vertexShader = vertexless.vertexShader.replace('#include <begin_vertex>', '')
    expect(() => compile(moonDetailPatch(false), vertexless)).toThrow(/begin_vertex/)
  })

  // tides-5ky: the Moon is lit by the scene's DirectionalLight alone, from
  // the true Sun direction. The patch reads that light (for the terminator
  // fade) and no Sun of its own.
  it('takes the Sun from the scene light only', () => {
    const { fragmentShader } = compile(moonDetailPatch(false))
    expect(fragmentShader).toContain('directionalLights[0].direction')
    const own = added(false)
    expect(own).not.toMatch(/uniform\s+vec3/)
    expect(own).not.toMatch(/uEclipseSun|uSunDir/)
  })
})
