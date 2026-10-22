import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { createCloudLayer } from './cloudShaders'
import { GROUND_DETAIL_OCTAVES, GROUND_DETAIL_OCTAVES_LOW, groundDetailPatch } from './groundDetail'
import { nightLightsPatch } from './nightLights'
import { poleSmoothingPatch } from './poleSmoothing'

function phongShader() {
  return {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
    vertexShader: THREE.ShaderLib.phong.vertexShader,
    fragmentShader: THREE.ShaderLib.phong.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms
}

describe('ground detail patch', () => {
  it("joins the ground's chain after the albedo, mask and normal, before the emissive and lights", () => {
    const eclipse = createEclipseShadow('earth')
    const clouds = createCloudLayer(eclipse, false)
    const patch = composePatches(
      eclipse.material,
      clouds.groundPatch,
      nightLightsPatch(clouds.uniforms.uSunDir),
      poleSmoothingPatch(),
      groundDetailPatch(false)
    )
    const shader = phongShader()
    patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)

    const frag = shader.fragmentShader
    const at = (s: string) => {
      expect(frag).toContain(s)
      return frag.indexOf(s)
    }
    const detail = at('vec4 detail = groundDetail(')
    expect(at('sampledDiffuseColor = poleSmoothed(')).toBeLessThan(detail)
    expect(at('#include <specularmap_fragment>')).toBeLessThan(detail)
    expect(at('#include <normal_fragment_maps>')).toBeLessThan(detail)
    expect(detail).toBeLessThan(at('#include <emissivemap_fragment>'))
    expect(detail).toBeLessThan(at('#include <lights_fragment_begin>'))
    expect(shader.vertexShader).toMatch(/#include <begin_vertex>\s+vGroundDetailPos = position;/)
    expect(at('float groundDetailTexel =')).toBeLessThan(detail)
    // The noise is defined once across the composed chain.
    expect(frag.split('vec4 detailNoise(vec3 p)')).toHaveLength(2)
    // The skylight's up is the normal before any tilt; it is lit with the
    // sunlight, which the cloud shadow and eclipse then dim.
    const sky = at('reflectedLight.directDiffuse = (1.0 - GROUND_SKY_FILL)')
    expect(at('vec3 groundUp = normal;')).toBeLessThan(at('groundLand > 0.0'))
    expect(at('#include <lights_fragment_end>')).toBeLessThan(sky)
    expect(sky).toBeLessThan(at('reflectedLight.directDiffuse *= cloudLit;'))
    expect(sky).toBeLessThan(at('reflectedLight.directDiffuse *= vec3(eclipse.x) + glow;'))
    // Wherever the skylight compiles, groundUp is declared.
    expect(frag).toContain('#if defined(USE_MAP) && defined(USE_SPECULARMAP)\nvec3 groundUp = normal;')
    expect(frag).toContain('#if defined(USE_MAP) && defined(USE_SPECULARMAP) && NUM_DIR_LIGHTS > 0\n{\n  float groundSunUp')
    clouds.dispose()
  })

  it("tilts the land by the displacement map's relief before the detail's own tilt", () => {
    const displaced = { ...phongShader(), displacementMap: true }
    const flat = phongShader()
    groundDetailPatch(false).onBeforeCompile(displaced, {} as THREE.WebGLRenderer)
    groundDetailPatch(false).onBeforeCompile(flat, {} as THREE.WebGLRenderer)
    const frag = displaced.fragmentShader
    const relief = frag.indexOf('groundRelief(vMapUv, vGroundDetailPos, groundFootprint)')
    expect(frag).toContain('#define GROUND_RELIEF\n')
    expect(frag.indexOf('#include <normal_fragment_maps>')).toBeLessThan(relief)
    expect(frag.indexOf('float groundFootprint =')).toBeLessThan(relief)
    expect(relief).toBeLessThan(frag.indexOf('vec4 detail = groundDetail('))
    expect(flat.fragmentShader).not.toContain('#define GROUND_RELIEF')
    expect(flat.fragmentShader).not.toContain('uniform sampler2D displacementMap;')
  })

  it('takes fewer octaves on the low tier, with its own program', () => {
    const high = phongShader()
    const low = phongShader()
    groundDetailPatch(false).onBeforeCompile(high, {} as THREE.WebGLRenderer)
    groundDetailPatch(true).onBeforeCompile(low, {} as THREE.WebGLRenderer)
    expect(high.fragmentShader).toContain(`#define GROUND_DETAIL_OCTAVES ${GROUND_DETAIL_OCTAVES}\n`)
    expect(low.fragmentShader).toContain(`#define GROUND_DETAIL_OCTAVES ${GROUND_DETAIL_OCTAVES_LOW}\n`)
    expect(GROUND_DETAIL_OCTAVES_LOW).toBeLessThan(GROUND_DETAIL_OCTAVES)
    expect(groundDetailPatch(true).customProgramCacheKey()).not.toBe(
      groundDetailPatch(false).customProgramCacheKey()
    )
  })
})
