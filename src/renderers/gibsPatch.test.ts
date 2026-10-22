import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { createCloudLayer } from './cloudShaders'
import { groundDetailPatch } from './groundDetail'
import { createGibsPatch } from './gibsPatch'
import { nightLightsPatch } from './nightLights'
import { poleSmoothingPatch } from './poleSmoothing'

function phongShader() {
  return {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
    vertexShader: THREE.ShaderLib.phong.vertexShader,
    fragmentShader: THREE.ShaderLib.phong.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms
}

describe('GIBS patch on the ground', () => {
  it('adds its detail after the (pole-smoothed) albedo and hands its cover to the ground detail', () => {
    const eclipse = createEclipseShadow('earth')
    const clouds = createCloudLayer(eclipse, false)
    const gibs = createGibsPatch(8)
    const patch = composePatches(
      eclipse.material,
      clouds.groundPatch,
      nightLightsPatch(clouds.uniforms.uSunDir),
      poleSmoothingPatch(),
      groundDetailPatch(false),
      gibs.material
    )
    const shader = phongShader()
    patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)

    const frag = shader.fragmentShader
    const at = (s: string) => {
      expect(frag).toContain(s)
      return frag.indexOf(s)
    }
    const blend = at('diffuseColor.rgb = sRGBTransferEOTF(')
    expect(at('sampledDiffuseColor = poleSmoothed(')).toBeLessThan(blend)
    expect(blend).toBeLessThan(at('#include <color_fragment>'))
    // The ground detail reads the albedo and the patch's cover after both.
    const cover = at('groundDetailFine = gibsCover;')
    expect(at('float groundDetailFine = 0.0;')).toBeLessThan(cover)
    expect(cover).toBeLessThan(at('vec4 detail = groundDetail('))
    // Night lights and the specular mask are untouched: the albedo is all
    // the patch writes.
    expect(blend).toBeLessThan(at('#include <specularmap_fragment>'))
    const gibsCode = frag.slice(frag.indexOf('float gibsCover'), at('#include <color_fragment>'))
    expect(gibsCode).not.toMatch(/totalEmissiveRadiance|specularStrength|vCloud/)
    expect(Object.keys(shader.uniforms)).toEqual(expect.arrayContaining(['uGibsPatch', 'uGibsMask', 'uGibsOrigin', 'uGibsActive']))
    expect(patch.customProgramCacheKey()).toContain('gibs-patch-8')
    clouds.dispose()
    gibs.release()
  })

  it('leaves the material alone where the device takes no patch', () => {
    const shader = phongShader()
    const none = createGibsPatch(0)
    none.material.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
    expect(shader.fragmentShader).toBe(THREE.ShaderLib.phong.fragmentShader)
    expect(none.material.customProgramCacheKey()).toBe('')
  })
})
