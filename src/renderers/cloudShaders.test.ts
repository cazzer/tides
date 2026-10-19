import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { createCloudLayer } from './cloudShaders'

function phongShader() {
  return {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
    vertexShader: THREE.ShaderLib.phong.vertexShader,
    fragmentShader: THREE.ShaderLib.phong.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms
}

describe('cloud layer materials', () => {
  for (const flat of [false, true]) {
    it(`patches the ground alongside the eclipse shadow (${flat ? 'flat' : 'relief'})`, () => {
      const eclipse = createEclipseShadow('earth')
      const clouds = createCloudLayer(eclipse, flat)
      const patch = composePatches(eclipse.material, clouds.groundPatch)
      const shader = phongShader()
      patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)

      expect(shader.fragmentShader).toContain('if (uEclipseActive')
      expect(shader.fragmentShader).toContain('cloudGroundShadow(normalize(vCloudGround))')
      expect(/#define CLOUD_FLAT\n/.test(shader.fragmentShader)).toBe(flat)
      expect(shader.vertexShader).toMatch(/#include <begin_vertex>\s+vCloudGround = position;/)
      // Both patches' uniforms, shared by reference with the cloud shell.
      expect(shader.uniforms.uEclipseActive).toBe(eclipse.uniforms.uEclipseActive)
      expect(shader.uniforms.uSunDir).toBe(clouds.uniforms.uSunDir)
      expect(clouds.material.uniforms.uSunDir).toBe(clouds.uniforms.uSunDir)
      expect(clouds.material.uniforms.uEclipseActive).toBe(eclipse.uniforms.uEclipseActive)
      expect(patch.customProgramCacheKey()).toBe(
        `eclipse-shadow+${flat ? 'cloud-shadow-flat' : 'cloud-shadow'}`
      )
      clouds.dispose()
    })
  }

  it('sits the relief shell above the flat one', () => {
    const eclipse = createEclipseShadow('earth')
    const relief = createCloudLayer(eclipse, false)
    const flat = createCloudLayer(eclipse, true)
    expect(relief.shellAltitude).toBeGreaterThan(flat.shellAltitude)
    expect(flat.material.defines).toHaveProperty('CLOUD_FLAT')
    expect(relief.material.defines).not.toHaveProperty('CLOUD_FLAT')
  })
})
