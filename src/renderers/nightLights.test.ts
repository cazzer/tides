import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createHash } from 'node:crypto'
import { useStore } from '../store'
import { earthPosition } from '../ephemeris'
import { CLOUD_AMBIENT } from '../lighting'
import { MOONLIGHT_RGB, NIGHT_FILL_RGB } from '../night-flight'
import { composePatches, createEclipseShadow, type MaterialPatch } from './eclipseShadow'
import { createCloudLayer } from './cloudShaders'
import { earthHorizon } from './earthHorizonTexture'
import { createGibsNightPatch } from './gibsNightPatch'
import { createGibsPatch } from './gibsPatch'
import { createGroundDisplacement } from './groundDisplacement'
import { groundDetailPatch } from './groundDetail'
import { createGroundHaze } from './groundHaze'
import { groundShadowPatch } from './groundShadow'
import { createNightFlight, nightLightsPatch } from './nightLights'
import { poleSmoothingPatch } from './poleSmoothing'
import { EARTH_BASE_SEGMENTS } from '../ship/terrain-floor'

function phongShader() {
  return {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
    vertexShader: THREE.ShaderLib.phong.vertexShader,
    fragmentShader: THREE.ShaderLib.phong.fragmentShader,
    displacementMap: true,
  } as THREE.WebGLProgramParametersWithUniforms
}

function compiled(patch: MaterialPatch) {
  const shader = phongShader()
  patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
  return {
    fragment: shader.fragmentShader,
    vertex: shader.vertexShader,
    uniforms: Object.keys(shader.uniforms),
    key: patch.customProgramCacheKey(),
  }
}

describe('night lights in flight', () => {
  it("lights the night side after the ground's occlusion and sky fill, before the cloud shadow, indirectly only", () => {
    const eclipse = createEclipseShadow('earth')
    const clouds = createCloudLayer(eclipse, false)
    const sun = clouds.uniforms.uSunDir
    const flight = createNightFlight(sun, { value: CLOUD_AMBIENT })
    const { fragment: frag, uniforms, key } = compiled(
      composePatches(
        eclipse.material,
        clouds.groundPatch,
        nightLightsPatch(sun, flight.uniforms),
        poleSmoothingPatch(),
        groundDetailPatch(false),
        groundShadowPatch(sun, earthHorizon('earth-horizon-test.bin'))
      )
    )
    clouds.dispose()
    const at = (s: string) => {
      expect(frag).toContain(s)
      return frag.indexOf(s)
    }
    const night = at('vec3 nightUp = normalize(vNightLightsDir);')
    expect(at('#include <lights_fragment_end>')).toBeLessThan(night)
    expect(at('reflectedLight.indirectDiffuse *= groundHorizonSky;')).toBeLessThan(night)
    expect(at('reflectedLight.directDiffuse = (1.0 - GROUND_SKY_FILL)')).toBeLessThan(night)
    expect(night).toBeLessThan(at('float cloudLit = cloudGroundShadow('))
    const code = frag.slice(night, at('float cloudLit = cloudGroundShadow('))
    expect(code).toContain('reflectedLight.indirectDiffuse +=')
    expect(code).not.toMatch(/\bdirectDiffuse|directSpecular|totalEmissiveRadiance/)
    // The Moon's horizon edges are night-flight.ts's.
    expect(code).toContain('smoothstep(-0.020000, 0.060000, dot(nightUp, uNightMoon))')
    expect(uniforms).toEqual(expect.arrayContaining(['uNightMoon', 'uNightMoonView', 'uNightFill', 'uNightMoonLight']))
    expect(key).toContain('night-lights-flight')
  })

  // EarthRenderer's ground outside ship mode: no flight for the night lights
  // and no side for either GIBS patch. The hashes are of f7208eb's chain
  // (main before tides-tvr.2, at the 12x default relief of tides-zmw.6:
  // nightLightsPatch(sun), no night patch), so drift from it fails here. A
  // change to the relief or other constants the chain writes into its GLSL
  // regenerates them. To regenerate: `git archive f7208eb src package.json
  // vite.config.ts tsconfig*.json` into a scratch directory with this repo's
  // node_modules linked, and log systemGroundHash's digest there for the old
  // chain from a throwaway test (three's ShaderLib is part of the hash: a
  // three upgrade regenerates them).
  const SYSTEM_GROUND_SHA256 = {
    high: '25cb7d341aacbe72a7df02d2874693d8c1b2f85f7c63510ab1376f16db209fe6',
    low: 'ace44b8f3662a5fcff23a711b5110e37012a3bcbf2ff4c3ed02eeaefa7d3a275',
  }

  function systemGroundHash(low: boolean) {
    const eclipse = createEclipseShadow('earth')
    const clouds = createCloudLayer(eclipse, low)
    const sun = clouds.uniforms.uSunDir
    const ground = composePatches(
      eclipse.material,
      clouds.groundPatch,
      nightLightsPatch(sun, undefined),
      poleSmoothingPatch(),
      groundDetailPatch(low),
      groundShadowPatch(sun, earthHorizon('earth-horizon-test.bin')),
      createGibsPatch(0).material,
      createGibsNightPatch(0).material,
      createGroundHaze(sun, 1, low).patch
    )
    const out = compiled(composePatches(ground, createGroundDisplacement(EARTH_BASE_SEGMENTS).patch))
    clouds.dispose()
    expect(out.fragment).not.toMatch(/uNightMoon|uNightFill|uGibsNight/)
    expect(out.uniforms).not.toEqual(expect.arrayContaining(['uNightMoon']))
    return createHash('sha256').update(out.vertex + '\n' + out.fragment).digest('hex')
  }

  it("leaves the system view's ground exactly as it was before tides-tvr.2", () => {
    expect(systemGroundHash(false)).toBe(SYSTEM_GROUND_SHA256.high)
    expect(systemGroundHash(true)).toBe(SYSTEM_GROUND_SHA256.low)
  })
})

describe('night flight', () => {
  afterEach(() => useStore.setState({ timestamp: null }))

  // The ground where Earth is at `iso` (the Sun is the scene's origin),
  // unrotated, and the eye 0.01 R over its night or its day side.
  function flyAt(iso: string, side: 'night' | 'day') {
    const t = Date.parse(iso)
    useStore.setState({ timestamp: t })
    const ground = new THREE.Object3D()
    ground.position.fromArray(earthPosition(t))
    ground.updateMatrixWorld()
    const away = ground.position.clone().normalize()
    const sun = { value: away.clone().negate() }
    const camera = new THREE.PerspectiveCamera()
    camera.position.copy(ground.position).addScaledVector(away, side === 'night' ? 1.01 : -1.01)
    camera.lookAt(ground.position)
    camera.updateMatrixWorld()
    const cloudAmbient = { value: CLOUD_AMBIENT }
    const flight = createNightFlight(sun, cloudAmbient)
    flight.update(ground, camera, 1)
    return { ...flight.uniforms, cloudAmbient: cloudAmbient.value, away }
  }

  it('adds nothing by day, the clouds at their ambient exactly', () => {
    const day = flyAt('2026-10-26T04:12:00Z', 'day')
    expect(day.uNightFill.value.getHex()).toBe(0)
    expect(day.uNightMoonLight.value.getHex()).toBe(0)
    expect(day.cloudAmbient).toBe(CLOUD_AMBIENT)
  })

  it('lights a full-Moon night brighter than a new-Moon one', () => {
    const full = flyAt('2026-10-26T04:12:00Z', 'night')
    const moonless = flyAt('2026-11-09T07:03:00Z', 'night')
    for (const night of [full, moonless]) expect(night.uNightFill.value.equals(NIGHT_FILL_RGB)).toBe(true)
    expect(full.uNightMoonLight.value.r).toBeCloseTo(MOONLIGHT_RGB.r, 2)
    expect(moonless.uNightMoonLight.value.r).toBeLessThan(0.001)
    expect(full.cloudAmbient).toBeGreaterThan(moonless.cloudAmbient)
    expect(moonless.cloudAmbient).toBeGreaterThan(CLOUD_AMBIENT)
    // The full Moon stands high over the anti-solar point, in the mesh's
    // frame and toward the eye looking down at it.
    expect(full.uNightMoon.value.dot(full.away)).toBeGreaterThan(0.95)
    expect(full.uNightMoonView.value.z).toBeGreaterThan(0.95)
  })

  it("works in the ground's own frame: the Moon's direction there, the eye's sub-point from it", () => {
    const t = Date.parse('2026-10-26T04:12:00Z')
    useStore.setState({ timestamp: t })
    const ground = new THREE.Object3D()
    ground.position.fromArray(earthPosition(t))
    ground.rotation.y = 1.3
    ground.updateMatrixWorld()
    // The Sun (the scene's origin) in the ground's frame, as uSunDir holds it.
    const sunLocal = ground.worldToLocal(new THREE.Vector3()).normalize()
    const night = sunLocal.clone().negate()
    const camera = new THREE.PerspectiveCamera()
    camera.position.copy(ground.localToWorld(night.clone().multiplyScalar(1.01)))
    camera.lookAt(ground.position)
    camera.updateMatrixWorld()
    const cloudAmbient = { value: CLOUD_AMBIENT }
    const flight = createNightFlight({ value: sunLocal }, cloudAmbient)
    flight.update(ground, camera, 1)
    // The full Moon over the anti-solar point, in the ground's frame.
    expect(flight.uniforms.uNightMoon.value.dot(night)).toBeGreaterThan(0.95)
    // Fully adapted there.
    expect(flight.uniforms.uNightFill.value.equals(NIGHT_FILL_RGB)).toBe(true)
    expect(cloudAmbient.value).toBeGreaterThan(CLOUD_AMBIENT)
  })
})
