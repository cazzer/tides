import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { createCloudLayer } from './cloudShaders'
import { blankHorizonTexture, earthHorizon } from './earthHorizonTexture'
import { groundDetailPatch } from './groundDetail'
import { groundShadowPatch } from './groundShadow'
import { HORIZON_SOFTNESS } from '../earth-horizon'
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
    expect(shadow).toBeLessThan(at('reflectedLight.directDiffuse = (1.0 - groundSkyFill)'))
    expect(shadow).toBeLessThan(at('reflectedLight.directDiffuse *= cloudLit;'))
    expect(at('reflectedLight.directSpecular *= sunLit;')).toBeGreaterThan(0)
    expect(at('reflectedLight.indirectDiffuse *= groundHorizonSky;')).toBeGreaterThan(0)
  })

  it("dims the ground detail's sky fill by the sky it sees", () => {
    const declared = at('#define GROUND_HORIZON\nfloat groundHorizonSky = 1.0;')
    const used = at('#ifdef GROUND_HORIZON\n  groundSkyView = min(groundSkyView, groundHorizonSky);')
    expect(declared).toBeLessThan(used)
    expect(used).toBeLessThan(at('reflectedLight.directDiffuse = (1.0 - groundSkyFill)'))
    // Under the same guard as the sky fill, so wherever that compiles this does.
    expect(frag).toContain(
      '#if defined(USE_MAP) && defined(USE_SPECULARMAP) && NUM_DIR_LIGHTS > 0\n#define GROUND_HORIZON'
    )
  })

  it("works out the Sun's azimuth as sunAzimuth() does, and gates the shadow at a step", () => {
    // Line for line with ../earth-horizon.ts sunAzimuth(), which is tested
    // against the ground mesh's uv: change one, change the other.
    const lines = [
      'vec3 up = vGroundDetailPos / radius;',
      'vec3 sun = normalize(uGroundShadowSun);',
      'vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), up));',
      'vec2 sunFlat = vec2(dot(sun, east), dot(sun, cross(up, east)));',
      `float bin = dot(sunFlat, sunFlat) > 1e-12 ? atan(sunFlat.x, sunFlat.y) * ${(8 / (2 * Math.PI)).toFixed(6)} : 0.0;`,
      'bin += bin < 0.0 ? 8.0 : 0.0;',
    ]
    const positions = lines.map(at)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    // As sunVisibility(): no shadow from a horizon of one step (the texture's
    // unit over 255 levels) or less.
    expect(frag).toContain('float quantum = k * uGroundHorizonCode.x / 255.0;')
    expect(frag).toContain(`smoothstep(quantum, quantum + ${HORIZON_SOFTNESS.toFixed(6)}, toward));`)
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
