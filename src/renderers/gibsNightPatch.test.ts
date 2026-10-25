import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { createCloudLayer } from './cloudShaders'
import { groundDetailPatch } from './groundDetail'
import { createGibsPatch } from './gibsPatch'
import { createGibsNightPatch, gibsNightTileRequests, stripNightLight } from './gibsNightPatch'
import { settleGibsStream as settle, setupGibsStream as setup } from './gibsStreamRig'
import { nightLightsPatch } from './nightLights'
import { poleSmoothingPatch } from './poleSmoothing'
import { gibsPatchReachDeg, NIGHT_PATCH_HOLD_DEG, NIGHT_PATCH_SUN_DEG } from '../gibs-patch'

function phongShader() {
  return {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
    vertexShader: THREE.ShaderLib.phong.vertexShader,
    fragmentShader: THREE.ShaderLib.phong.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms
}

describe('GIBS night patch on the ground', () => {
  it("adds its detail to the night map's texel, before the night side's mask, and nothing else", () => {
    const eclipse = createEclipseShadow('earth')
    const clouds = createCloudLayer(eclipse, false)
    const day = createGibsPatch(8)
    const night = createGibsNightPatch(8)
    const patch = composePatches(
      eclipse.material,
      clouds.groundPatch,
      nightLightsPatch(clouds.uniforms.uSunDir),
      poleSmoothingPatch(),
      groundDetailPatch(false),
      day.material,
      night.material
    )
    const shader = phongShader()
    patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
    const frag = shader.fragmentShader
    const at = (s: string) => {
      expect(frag).toContain(s)
      return frag.indexOf(s)
    }
    const composite = at('totalEmissiveRadiance = emissive * emissiveColor.rgb;')
    expect(at('#include <emissivemap_fragment>')).toBeLessThan(at('if (uGibsNightActive > 0.5)'))
    expect(composite).toBeLessThan(at('totalEmissiveRadiance *= smoothstep(0.035, -0.1'))
    // Its own names beside the day patch's, and no warp: the two maps
    // register to the texel.
    expect(at('#define GIBS_NIGHT_SIDE 8.000000')).toBeGreaterThan(0)
    expect(at('#define GIBS_SIDE 8.000000')).toBeGreaterThan(0)
    const code = frag.slice(at('if (uGibsNightActive > 0.5)'), composite)
    expect(code).not.toMatch(/uGibsWarp|diffuseColor|reflectedLight|gibsCover|gibsMask\(/)
    // The coarse read is at the map's texel, at its four texel centres.
    expect(code.match(/textureLod\(uGibsNight, s00/g)).toHaveLength(4)
    expect(code).toContain('log2(81920.000000 / nightMapSize.x)')
    expect(Object.keys(shader.uniforms)).toEqual(
      expect.arrayContaining(['uGibsNight', 'uGibsNightMask', 'uGibsNightOrigin', 'uGibsNightActive'])
    )
    expect(patch.customProgramCacheKey()).toContain('gibs-patch-8+gibs-night-8')
    clouds.dispose()
    day.release()
    night.release()
  })

  it('leaves the material alone where the device takes no patch', () => {
    const shader = phongShader()
    const none = createGibsNightPatch(0)
    none.material.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
    expect(shader.fragmentShader).toBe(THREE.ShaderLib.phong.fragmentShader)
    expect(none.material.customProgramCacheKey()).toBe('')
  })

  it("strips VIIRS's blue ground to nothing and keeps its warm lights", () => {
    // Linear means sampled from lightless tiles (Greenland, the Sahara, the
    // Southern Ocean) and rural Burgundy, and the bluest ground seen.
    for (const [r, g, b] of [
      [0.0048, 0.0137, 0.0844],
      [0.0043, 0.0114, 0.0707],
      [0, 0.0003, 0.0123],
      [0.0093, 0.02, 0.0346],
      [0.28 * 0.1, 0.05, 0.1],
    ]) {
      expect(stripNightLight(r, g, b)).toBe(0)
    }
    expect(stripNightLight(1, 0.9, 0.5)).toBeGreaterThan(0.5)
    expect(stripNightLight(0.3, 0.2, 0.1)).toBeGreaterThan(0.15)
  })
})

describe('GIBS night patch streaming', () => {
  afterEach(() => vi.unstubAllGlobals())

  // The ground well away from the Sun (the scene's origin), on +x, so the
  // Sun is on its local -x; the ship 0.2 R up over the equator where the
  // Sun stands `sunElevation` degrees up. The night tile store outlives
  // each test, so each flies somewhere else.
  const groundAt = new THREE.Vector3(100, 0, 0)
  const over = (sunElevation: number) => {
    const e = (sunElevation * Math.PI) / 180
    return new THREE.Vector3(-Math.sin(e), 0, Math.cos(e)).multiplyScalar(1.2)
  }

  it('fetches only night tiles into a linear R8 target with mips, at night', async () => {
    const urls: string[] = []
    const { gl, camera, ground, targets, uploads } = setup(async (url) => {
      urls.push(url)
      return new Response(url)
    }, over(-60), groundAt)
    const before = gibsNightTileRequests()
    const patch = createGibsNightPatch(4)
    patch.update(gl, camera, ground, 1, 0)
    expect(urls).toHaveLength(6)
    for (const url of urls) expect(url).toContain('/VIIRS_CityLights_2012/default/2016-01-01/500m/7/')
    expect(gibsNightTileRequests() - before).toBe(6)
    await settle()
    patch.update(gl, camera, ground, 1, 16)
    expect(uploads).toHaveLength(2)
    expect(targets).toHaveLength(1)
    const texture = targets[0].texture
    expect([texture.format, texture.type, texture.colorSpace]).toEqual([
      THREE.RedFormat,
      THREE.UnsignedByteType,
      THREE.NoColorSpace,
    ])
    expect([texture.generateMipmaps, texture.minFilter, texture.wrapS]).toEqual([
      true,
      THREE.LinearMipmapLinearFilter,
      THREE.RepeatWrapping,
    ])
    expect([targets[0].width, targets[0].height]).toEqual([2048, 2048])
    patch.release()
  })

  it('fetches nothing over the day side', async () => {
    const { gl, camera, ground, targets } = setup(async (url) => new Response(url), over(40), groundAt)
    const before = gibsNightTileRequests()
    const patch = createGibsNightPatch(4)
    patch.update(gl, camera, ground, 1, 0)
    await settle()
    patch.update(gl, camera, ground, 1, 16)
    expect(gibsNightTileRequests()).toBe(before)
    expect(targets).toHaveLength(0)
    patch.release()
  })

  it('holds through the terminator and lets go once the Sun climbs past the hold', async () => {
    const start = NIGHT_PATCH_SUN_DEG + gibsPatchReachDeg(4)
    const { gl, camera, ground } = setup(async (url) => new Response(url), over(start - 1), groundAt)
    const patch = createGibsNightPatch(4)
    const shader = phongShader()
    patch.material.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
    const active = () => shader.uniforms.uGibsNightActive.value as number
    patch.update(gl, camera, ground, 1, 0)
    await settle()
    patch.update(gl, camera, ground, 1, 16)
    expect(active()).toBe(1)
    expect(shader.uniforms.uGibsNight.value).not.toBeNull()
    camera.position.copy(groundAt).add(over(start + NIGHT_PATCH_HOLD_DEG - 1))
    patch.update(gl, camera, ground, 1, 32)
    expect(active()).toBe(1)
    camera.position.copy(groundAt).add(over(start + NIGHT_PATCH_HOLD_DEG + 1))
    patch.update(gl, camera, ground, 1, 48)
    expect(active()).toBe(0)
    expect(shader.uniforms.uGibsNight.value).toBeNull()
    // And from there it needs the Sun back under the start to come on again.
    camera.position.copy(groundAt).add(over(start + 1))
    patch.update(gl, camera, ground, 1, 64)
    await settle()
    patch.update(gl, camera, ground, 1, 80)
    expect(active()).toBe(0)
    patch.release()
  })
})
