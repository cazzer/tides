import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
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

  it("leaves the system view's ground exactly as it was", () => {
    // EarthRenderer's chain outside ship mode, before tides-tvr.2 and after:
    // no flight for the night lights and no side for either GIBS patch.
    const chain = (after: boolean) => {
      const eclipse = createEclipseShadow('earth')
      const clouds = createCloudLayer(eclipse, false)
      const sun = clouds.uniforms.uSunDir
      const haze = createGroundHaze(sun, 1, false)
      const ground = composePatches(
        eclipse.material,
        clouds.groundPatch,
        after ? nightLightsPatch(sun, undefined) : nightLightsPatch(sun),
        poleSmoothingPatch(),
        groundDetailPatch(false),
        groundShadowPatch(sun, earthHorizon('earth-horizon-test.bin')),
        createGibsPatch(0).material,
        ...(after ? [createGibsNightPatch(0).material] : []),
        haze.patch
      )
      const out = compiled(composePatches(ground, createGroundDisplacement(EARTH_BASE_SEGMENTS).patch))
      clouds.dispose()
      return out
    }
    const before = chain(false)
    const after = chain(true)
    expect(after.fragment).toBe(before.fragment)
    expect(after.vertex).toBe(before.vertex)
    expect(after.uniforms).toEqual(before.uniforms)
    // The empty night patch only adds an empty part to the cache key.
    expect(after.key.split('+').filter(Boolean)).toEqual(before.key.split('+').filter(Boolean))
    expect(after.fragment).not.toMatch(/uNightMoon|uNightFill|uGibsNight/)
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
})
