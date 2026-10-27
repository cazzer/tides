import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createCloudLayer } from './cloudShaders'
import { createEclipseShadow } from './eclipseShadow'
import { createGroundHaze } from './groundHaze'
import { SKY_VIEW_GLSL, SKY_VIEW_UNIFORMS } from './skyView'
import hazeGlsl from '../shaders/atmosphere/haze.glsl'
import atmosphereFragment from '../shaders/atmosphere/fragment.frag'

describe('the sky-view table (tides-34q.2)', () => {
  it("is one table for the clouds' haze and the ground's, the tiles' too", () => {
    const clouds = createCloudLayer(createEclipseShadow('earth'), false)
    for (const key of ['uSkyView', 'uSkyViewSize', 'uSkyViewOn'] as const) {
      expect(clouds.material.uniforms[key]).toBe(SKY_VIEW_UNIFORMS[key])
    }
    const haze = createGroundHaze({ value: new THREE.Vector3(1, 0, 0) }, 1, false)
    for (const patch of [haze.patch, haze.surfacePatch]) {
      const shader = {
        uniforms: {} as Record<string, THREE.IUniform>,
        vertexShader: THREE.ShaderLib.phong.vertexShader,
        fragmentShader: THREE.ShaderLib.phong.fragmentShader,
      } as unknown as THREE.WebGLProgramParametersWithUniforms
      patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
      expect(shader.uniforms.uSkyView).toBe(SKY_VIEW_UNIFORMS.uSkyView)
      expect(shader.uniforms.uSkyViewOn).toBe(SKY_VIEW_UNIFORMS.uSkyViewOn)
      expect(shader.fragmentShader).toContain(SKY_VIEW_GLSL)
    }
    clouds.dispose()
  })

  it('is read only from inside, and only when drawn', () => {
    expect(SKY_VIEW_UNIFORMS.uSkyViewOn.value).toBe(0)
    expect(hazeGlsl).toContain('if (uSkyViewOn > 0.5) return mix(limb, skyViewGlow(rd, eye, sun), inside);')
    expect(hazeGlsl.indexOf('if (inside <= 0.0) return limb;')).toBeLessThan(hazeGlsl.indexOf('if (uSkyViewOn > 0.5)'))
    expect(atmosphereFragment).toContain('uniform sampler2D uSkyView;')
  })
})
