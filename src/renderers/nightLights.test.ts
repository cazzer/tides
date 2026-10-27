import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { createNightFlight, NIGHT_LIGHTS_GLSL, NIGHT_MASK_SUN, nightLightsPatch } from './nightLights'
import { NIGHT_POINTS_GLSL, nightPointsEye } from './nightPoints'
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

  // tides-zmw.23: in flight the lights break into points, after the map and
  // VIIRS, before the mask, on the night side only.
  it('breaks the lights into points after VIIRS and before the mask, its derivatives before any branch', () => {
    const sun = { value: new THREE.Vector3(1, 0, 0) }
    const flight = createNightFlight(sun, { value: CLOUD_AMBIENT })
    const night = createGibsNightPatch(8)
    const { fragment: frag, vertex, uniforms, key } = compiled(composePatches(nightLightsPatch(sun, flight.uniforms), night.material))
    const at = (s: string) => {
      expect(frag).toContain(s)
      return frag.indexOf(s)
    }
    expect(at(NIGHT_POINTS_GLSL.head)).toBeLessThan(at(NIGHT_POINTS_GLSL.offsetHead))
    expect(at(NIGHT_POINTS_GLSL.offsetHead)).toBeLessThan(at('void main'))
    expect(at('varying vec3 vNightPointsRay;')).toBeLessThan(at('void main'))
    // The drawn point from the eye: the vertex after its displacement, less
    // the eye as float32 holds it.
    const v = vertex.indexOf(NIGHT_LIGHTS_GLSL.pointsVertexBody)
    expect(v).toBeGreaterThan(vertex.indexOf('#include <project_vertex>'))
    expect(vertex.indexOf('#include <displacementmap_vertex>')).toBeLessThan(v)
    expect(NIGHT_LIGHTS_GLSL.pointsVertexBody.trim()).toBe('vNightPointsRay = transformed - uNightPointsEyeGround;')
    expect(uniforms).toEqual(expect.arrayContaining(['uNightPointsEye', 'uNightPointsEyeGround', 'uNightPointsEyeLow']))
    const points = at(NIGHT_LIGHTS_GLSL.pointsBody)
    expect(at('gibsNightCover = cover;')).toBeLessThan(points)
    expect(at('totalEmissiveRadiance = emissive * emissiveColor.rgb;')).toBeLessThan(points)
    expect(points).toBeLessThan(at('totalEmissiveRadiance *= smoothstep(0.035, -0.1'))
    const body = NIGHT_LIGHTS_GLSL.pointsBody
    expect(body.trim().startsWith('#ifdef USE_EMISSIVEMAP')).toBe(true)
    expect(body.trim().endsWith('#endif')).toBe(true)
    // Derivatives of the small, smooth ray only, before any branch; the
    // eye's rounding off past the varying; the cell from the eye's.
    expect(body.match(/dFd[xy]\([^)]*\)/g)).toEqual(['dFdx(vNightPointsRay)', 'dFdy(vNightPointsRay)'])
    expect(body.indexOf('dFdy(')).toBeLessThan(body.indexOf('if ('))
    expect(body).not.toMatch(/vEmissiveMapUv \*|dFd[xy]\(vEmissiveMapUv/)
    expect(body).toContain('vec3 nightPointsRay = vNightPointsRay - uNightPointsEyeLow;')
    expect(body).toContain('uNightPointsEye.zw + nightPointsOffset(uNightPointsEyeGround, nightPointsRay)')
    expect(body).toContain('nightPointsDelta(nightPointsAt, nightPointsRayDx), nightPointsDelta(nightPointsAt, nightPointsRayDy)')
    expect(body).toContain(`if (dot(normalize(vNightLightsDir), uNightLightsSun) < ${NIGHT_MASK_SUN.toFixed(6)})`)
    expect(body).toContain('float nightPointsFine = gibsNightCover;')
    expect(body).toContain('totalEmissiveRadiance *= nightPoints(emissiveColor.rgb, nightPointsFine, uNightPointsEye.xy,')
    expect(key).toBe('night-lights-flight+gibs-night-8')
    expect(nightLightsPatch(sun, flight.uniforms).customProgramCacheKey()).toBe('night-lights-flight')
  })

  it('adds no points outside flight', () => {
    const { fragment, vertex } = compiled(nightLightsPatch({ value: new THREE.Vector3(1, 0, 0) }))
    expect(fragment).not.toMatch(/nightPoints|NIGHT_POINTS/)
    expect(vertex).not.toMatch(/NightPoints/)
  })

  // EarthRenderer's ground outside ship mode: no flight for the night lights
  // and no side for either GIBS patch, hashed for the high and low tiers.
  //
  // At ?relief=12, the hashes of f7208eb's chain (main before tides-tvr.2,
  // at tides-zmw.6's 12x default relief: nightLightsPatch(sun), no night
  // patch), so drift from it fails here, and the old default's look stays one
  // URL away. To regenerate: `git archive f7208eb src package.json
  // vite.config.ts tsconfig*.json` into a scratch directory with this repo's
  // node_modules linked, and log systemGroundHash's digest there for the old
  // chain from a throwaway test.
  //
  // At the default (true scale since tides-zmw.21), the chain as that change
  // left it (commit "tides-zmw.21 step A", whose horizon softness and detail
  // tilt f7208eb predates, so no archive reproduces it): a change to the
  // relief or to the constants the chain writes into its GLSL fails here on
  // purpose. To regenerate, deliberately: log systemGroundHash's digests at
  // the default from a throwaway test on the commit that should own them.
  //
  // three's ShaderLib is part of both: a three upgrade regenerates them.
  const SYSTEM_GROUND_SHA256_12X = {
    high: '25cb7d341aacbe72a7df02d2874693d8c1b2f85f7c63510ab1376f16db209fe6',
    low: 'ace44b8f3662a5fcff23a711b5110e37012a3bcbf2ff4c3ed02eeaefa7d3a275',
  }
  const SYSTEM_GROUND_SHA256 = {
    high: '06380e1c5ca65c6b73b1f2facbb0263ae1ad6b1c035a65c1e662576ba487d2ba',
    low: 'b5ffe74514f3358501e638243ac6f42c20528e24347e83c85ebe08b4f57f42b3',
  }

  // The chain's makers, as imported here (the page's default relief) or
  // afresh under another location (systemGroundHashesAt()).
  const STATIC_CHAIN = {
    createEclipseShadow,
    createCloudLayer,
    composePatches,
    nightLightsPatch,
    poleSmoothingPatch,
    groundDetailPatch,
    groundShadowPatch,
    earthHorizon,
    createGibsPatch,
    createGibsNightPatch,
    createGroundHaze,
    createGroundDisplacement,
    EARTH_BASE_SEGMENTS,
  }
  type Chain = typeof STATIC_CHAIN

  function systemGroundHash(low: boolean, m: Chain = STATIC_CHAIN) {
    const eclipse = m.createEclipseShadow('earth')
    const clouds = m.createCloudLayer(eclipse, low)
    const sun = clouds.uniforms.uSunDir
    const ground = m.composePatches(
      eclipse.material,
      clouds.groundPatch,
      m.nightLightsPatch(sun, undefined),
      m.poleSmoothingPatch(),
      m.groundDetailPatch(low),
      m.groundShadowPatch(sun, m.earthHorizon('earth-horizon-test.bin')),
      m.createGibsPatch(0).material,
      m.createGibsNightPatch(0).material,
      m.createGroundHaze(sun, 1, low).patch
    )
    const out = compiled(m.composePatches(ground, m.createGroundDisplacement(m.EARTH_BASE_SEGMENTS).patch))
    clouds.dispose()
    expect(out.fragment).not.toMatch(/uNightMoon|uNightFill|uGibsNight/)
    expect(out.uniforms).not.toEqual(expect.arrayContaining(['uNightMoon']))
    return createHash('sha256').update(out.vertex + '\n' + out.fragment).digest('hex')
  }

  /** Both tiers' hashes with the page at `search`: every module afresh. */
  async function systemGroundHashesAt(search: string) {
    vi.resetModules()
    vi.stubGlobal('location', { search })
    try {
      const m: Chain = {
        ...(await import('./eclipseShadow')),
        ...(await import('./cloudShaders')),
        ...(await import('./nightLights')),
        ...(await import('./poleSmoothing')),
        ...(await import('./groundDetail')),
        ...(await import('./groundShadow')),
        ...(await import('./earthHorizonTexture')),
        ...(await import('./gibsPatch')),
        ...(await import('./gibsNightPatch')),
        ...(await import('./groundHaze')),
        ...(await import('./groundDisplacement')),
        ...(await import('../ship/terrain-floor')),
      }
      return { high: systemGroundHash(false, m), low: systemGroundHash(true, m) }
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  }

  it("leaves the system view's ground at the default exactly as tides-zmw.21 left it", () => {
    expect(systemGroundHash(false)).toBe(SYSTEM_GROUND_SHA256.high)
    expect(systemGroundHash(true)).toBe(SYSTEM_GROUND_SHA256.low)
  })

  it("leaves the system view's ground at ?relief=12 exactly as it was before tides-tvr.2", async () => {
    expect(await systemGroundHashesAt('?relief=12')).toEqual(SYSTEM_GROUND_SHA256_12X)
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

  it("puts the eye's cell in the ground's frame, as the haze's uGroundHazeEyeLocal has the eye", () => {
    const t = Date.parse('2026-10-26T04:12:00Z')
    useStore.setState({ timestamp: t })
    for (const turn of [0, 1.3]) {
      const ground = new THREE.Object3D()
      ground.position.fromArray(earthPosition(t))
      ground.rotation.set(0.2, turn, -0.4)
      ground.updateMatrixWorld()
      const eyeLocal = new THREE.Vector3(0.3, 0.8, -0.5).normalize().multiplyScalar(1.002)
      const camera = new THREE.PerspectiveCamera()
      camera.position.copy(ground.localToWorld(eyeLocal.clone()))
      camera.lookAt(ground.position)
      camera.updateMatrixWorld()
      const haze = createGroundHaze({ value: new THREE.Vector3(1, 0, 0) }, 1, false)
      haze.update(ground, camera)
      const flight = createNightFlight({ value: new THREE.Vector3(1, 0, 0) }, { value: CLOUD_AMBIENT })
      flight.update(ground, camera, 1)
      const expected = nightPointsEye(haze.frame.uGroundHazeEyeLocal.value, new THREE.Vector4())
      const got = flight.uniforms.uNightPointsEye.value
      expect(got.x).toBe(expected.x)
      expect(got.y).toBe(expected.y)
      expect(got.z).toBeCloseTo(expected.z, 4)
      expect(got.w).toBeCloseTo(expected.w, 4)
      // The eye itself, and what float32 rounds off it: together the eye
      // in double.
      const eye = flight.uniforms.uNightPointsEyeGround.value
      const low = flight.uniforms.uNightPointsEyeLow.value
      expect(eye.distanceTo(haze.frame.uGroundHazeEyeLocal.value)).toBeLessThan(1e-12)
      for (const c of ['x', 'y', 'z'] as const) {
        expect(Math.fround(eye[c]) + low[c]).toBe(eye[c])
        expect(Math.abs(low[c])).toBeLessThanOrEqual(2 ** -23)
      }
    }
  })
})
