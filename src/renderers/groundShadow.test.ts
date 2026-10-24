import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { createCloudLayer } from './cloudShaders'
import { blankHorizonTexture, earthHorizon } from './earthHorizonTexture'
import { groundDetailPatch } from './groundDetail'
import { groundShadowPatch } from './groundShadow'
import { nightLightsPatch } from './nightLights'
import { poleSmoothingPatch } from './poleSmoothing'

function phongShader() {
  return {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
    vertexShader: THREE.ShaderLib.phong.vertexShader,
    fragmentShader: THREE.ShaderLib.phong.fragmentShader,
    displacementMap: true,
  } as THREE.WebGLProgramParametersWithUniforms
}

describe('ground shadow patch', () => {
  const eclipse = createEclipseShadow('earth')
  const clouds = createCloudLayer(eclipse, false)
  const horizon = earthHorizon('earth-horizon-test.bin')
  const shader = phongShader()
  composePatches(
    eclipse.material,
    clouds.groundPatch,
    nightLightsPatch(clouds.uniforms.uSunDir),
    poleSmoothingPatch(),
    groundDetailPatch(false),
    groundShadowPatch(clouds.uniforms.uSunDir, horizon)
  ).onBeforeCompile(shader, {} as THREE.WebGLRenderer)
  clouds.dispose()
  const frag = shader.fragmentShader
  const at = (s: string) => {
    expect(frag).toContain(s)
    return frag.indexOf(s)
  }

  it('shades the Sun after the lights, before the sky fill splits it off and the clouds dim it', () => {
    const shadow = at('reflectedLight.directDiffuse *= sunLit;')
    expect(at('#include <lights_fragment_end>')).toBeLessThan(shadow)
    expect(shadow).toBeLessThan(at('reflectedLight.directDiffuse = (1.0 - GROUND_SKY_FILL)'))
    expect(shadow).toBeLessThan(at('reflectedLight.directDiffuse *= cloudLit;'))
    expect(at('reflectedLight.directSpecular *= sunLit;')).toBeGreaterThan(0)
    expect(at('reflectedLight.indirectDiffuse *= groundHorizonSky;')).toBeGreaterThan(0)
  })

  it("dims the ground detail's sky fill by the sky it sees", () => {
    const declared = at('#define GROUND_HORIZON\nfloat groundHorizonSky = 1.0;')
    const used = at('#ifdef GROUND_HORIZON\n  groundSkyView *= groundHorizonSky;')
    expect(declared).toBeLessThan(used)
    expect(used).toBeLessThan(at('reflectedLight.directDiffuse = (1.0 - GROUND_SKY_FILL)'))
    // Under the same guard as the sky fill, so wherever that compiles this does.
    expect(frag).toContain(
      '#if defined(USE_MAP) && defined(USE_SPECULARMAP) && NUM_DIR_LIGHTS > 0\n#define GROUND_HORIZON'
    )
  })

  it('leaves the night lights alone', () => {
    const body = frag.slice(at('#define GROUND_HORIZON'), at('reflectedLight.indirectDiffuse *= groundHorizonSky;'))
    expect(body).not.toContain('totalEmissiveRadiance')
    expect(body).not.toContain('emissive')
  })

  it("follows the material's displacement scale and the shared Sun and map", () => {
    expect(shader.uniforms.uGroundShadowScale).toBe(shader.uniforms.displacementScale)
    expect(shader.uniforms.uGroundShadowSun).toBe(clouds.uniforms.uSunDir)
    expect(shader.uniforms.uGroundHorizon).toBe(horizon.map)
    expect(earthHorizon('earth-horizon-test.bin')).toBe(horizon)
    // Its own name: the relief declares displacementScale in the fragment.
    expect(frag.split('uniform float displacementScale;')).toHaveLength(2)
  })

  it('starts on a blank map: no horizon anywhere', () => {
    const blank = blankHorizonTexture()
    expect(Array.from(blank.image.data as Uint8Array)).toEqual(new Array(8).fill(0))
    expect(horizon.map.value.image.depth).toBe(2)
  })
})
