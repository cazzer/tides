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
import {
  createNightFlight,
  NIGHT_FADE_EQUATOR_M,
  NIGHT_FADE_FLOOR,
  NIGHT_FADE_PIXEL_M_OFF,
  NIGHT_FADE_TEXEL_PX_END,
  NIGHT_FADE_TEXEL_PX_START,
  NIGHT_LIGHTS_GLSL,
  nightLightsFade,
  nightLightsPatch,
} from './nightLights'
import { GIBS_GROUND_WIDTH } from '../gibs-patch'
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

  // tides-zmw.24: in flight the lights fade as their source is magnified,
  // after the map and VIIRS, with the mask.
  it('fades the lights after VIIRS and before the mask, its derivatives in main\'s top level', () => {
    const sun = { value: new THREE.Vector3(1, 0, 0) }
    const flight = createNightFlight(sun, { value: CLOUD_AMBIENT })
    const night = createGibsNightPatch(8)
    const { fragment: frag, key } = compiled(composePatches(nightLightsPatch(sun, flight.uniforms), night.material))
    night.release()
    const at = (s: string) => {
      expect(frag).toContain(s)
      return frag.indexOf(s)
    }
    expect(at(NIGHT_LIGHTS_GLSL.fadeHead)).toBeLessThan(at('void main'))
    expect(at('float gibsNightCover = 0.0;')).toBeLessThan(at('void main'))
    const fade = at(NIGHT_LIGHTS_GLSL.fadeBody + NIGHT_LIGHTS_GLSL.fragmentBody)
    expect(at('gibsNightCover = cover;')).toBeLessThan(fade)
    expect(at('totalEmissiveRadiance = emissive * emissiveColor.rgb;')).toBeLessThan(fade)
    // Nothing but main is open where the derivatives are taken: VIIRS's
    // branch has closed.
    const before = frag.slice(at('void main'), fade)
    expect(before.split('{').length - before.split('}').length).toBe(1)
    const body = NIGHT_LIGHTS_GLSL.fadeBody
    expect(body.trim().startsWith('#ifdef USE_EMISSIVEMAP')).toBe(true)
    expect(body.trim().endsWith('#endif')).toBe(true)
    expect(body.match(/dFd[xy]\([^)]*\)/g)).toEqual(['dFdx(vEmissiveMapUv)', 'dFdy(vEmissiveMapUv)'])
    expect(body).not.toContain('if (')
    expect(NIGHT_LIGHTS_GLSL.fadeHead).not.toMatch(/dFd[xy]|fwidth|if \(/)
    // Wrapped at the antimeridian.
    expect(body).toContain('nightFadeDx.x -= floor(nightFadeDx.x + 0.5);')
    expect(body).toContain('nightFadeDy.x -= floor(nightFadeDy.x + 0.5);')
    expect(body).toContain(NIGHT_LIGHTS_GLSL.fadeCall)
    expect(NIGHT_LIGHTS_GLSL.fadeCall).toContain('float nightFadeFine = gibsNightCover;')
    expect(NIGHT_LIGHTS_GLSL.fadeCall).toContain('totalEmissiveRadiance *= nightLightsFade(nightFadeDx, nightFadeDy, vEmissiveMapUv.y,')
    // The mirror's constants, as the GLSL has them.
    const head = NIGHT_LIGHTS_GLSL.fadeHead
    expect(head).toContain(`smoothstep(${Math.log2(NIGHT_FADE_TEXEL_PX_START).toFixed(6)}, ${Math.log2(NIGHT_FADE_TEXEL_PX_END).toFixed(6)}, texelPx)`)
    expect(head).toContain(`mix(1.0, ${NIGHT_FADE_FLOOR.toFixed(6)},`)
    expect(head).toContain(`(logWidth - ${Math.log2(GIBS_GROUND_WIDTH).toFixed(6)})`)
    expect(head).toContain(`${Math.log2(NIGHT_FADE_PIXEL_M_OFF).toFixed(6)}, pixelM)`)
    expect(key).toBe('night-lights-flight+gibs-night-8')
  })

  it('adds no fade outside flight', () => {
    const { fragment, key } = compiled(nightLightsPatch({ value: new THREE.Vector3(1, 0, 0) }))
    expect(fragment).not.toMatch(/nightLightsFade|nightFade|dFd[xy]\(vEmissiveMapUv/)
    expect(key).toBe('night-lights')
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
})

describe('the night lights\' fade (tides-zmw.24)', () => {
  const C = NIGHT_FADE_EQUATOR_M
  const D = Math.PI / 180
  /** The factor for a footprint `along` by `across` metres on the ground at
   * `lat`, its long axis `heading` degrees from north. */
  function fadeAt(along: number, across: number, opts: { lat?: number; heading?: number; width?: number; fine?: number } = {}) {
    const { lat = 30.05, heading = 0, width = 10800, fine = 0 } = opts
    const k = Math.cos(lat * D)
    // Ground metres east and north to uv: a turn of u is C k, of v C / 2.
    const uv = (east: number, north: number) => [east / (C * k), (2 * north) / C] as const
    const h = heading * D
    const dx = uv(along * Math.sin(h), along * Math.cos(h))
    const dy = uv(across * Math.cos(h), -across * Math.sin(h))
    return nightLightsFade(dx, dy, 0.5 + lat / 180, width, fine)
  }
  /** The nadir pixel, metres, `km` over the ground on `rows` rows through 60°. */
  const nadirPixel = (km: number, rows: number) => (km * 1000 * 2 * Math.tan(30 * D)) / rows

  it('is exactly 1 from 1500 km up on every screen, with or without VIIRS', () => {
    // Straight down from 1500 km a 2880-row screen's pixel is ~601 m: ~6 px
    // a 3.7 km map texel, past START, so the pixel guard holds it.
    const tall = nadirPixel(1500, 2880)
    expect(tall).toBeGreaterThan(600)
    expect(C / 10800 / tall).toBeGreaterThan(NIGHT_FADE_TEXEL_PX_START)
    // A phone's (~1700 rows) at the 2048 px map: a 19.5 km texel, ~19 px.
    const phone = nadirPixel(1500, 1700)
    expect(C / 2048 / phone).toBeGreaterThan(19)
    for (const km of [1500, 3000, 36000]) {
      for (const rows of [720, 1700, 2880]) {
        for (const width of [10800, 2048]) {
          for (const fine of [0, 0.5, 1]) {
            const p = nadirPixel(km, rows)
            expect(fadeAt(p, p, { width, fine }), `${km} km ${rows} rows ${width} ${fine}`).toBe(1)
          }
        }
      }
    }
  })

  it('is exactly 1 while the finest texel is START pixels or less', () => {
    for (const lat of [0, 30.05, 60]) {
      // VIIRS's texel at START px: its narrow axis is the texel over START.
      const viirs = C / GIBS_GROUND_WIDTH / NIGHT_FADE_TEXEL_PX_START
      expect(fadeAt(viirs * 1.0001, viirs * 1.0001, { lat, fine: 1 })).toBe(1)
      expect(fadeAt(viirs * 0.98, viirs * 0.98, { lat, fine: 1 })).toBeLessThan(1)
      // 300 km on a 2880-row screen with VIIRS: ~4 px a texel, barely touched.
      const p = nadirPixel(300, 2880)
      expect(fadeAt(p, p, { lat, fine: 1 })).toBeGreaterThan(0.999)
    }
  })

  it('falls monotonically as the footprint shrinks, to FLOOR past END, and is FLOOR at a zero footprint', () => {
    for (const fine of [0, 0.4, 1]) {
      for (const width of [10800, 2048]) {
        let last = 1
        for (let p = 2000; p > 0.001; p /= 1.05) {
          const fade = fadeAt(p, p, { width, fine })
          expect(fade).toBeLessThanOrEqual(last)
          last = fade
        }
        expect(last).toBe(NIGHT_FADE_FLOOR)
      }
    }
    const end = C / GIBS_GROUND_WIDTH / NIGHT_FADE_TEXEL_PX_END
    expect(fadeAt(end * 0.999, end * 0.999, { fine: 1 })).toBe(NIGHT_FADE_FLOOR)
    expect(fadeAt(end * 1.2, end * 1.2, { fine: 1 })).toBeGreaterThan(NIGHT_FADE_FLOOR)
    for (const [dx, dy] of [
      [[0, 0], [0, 0]],
      [[1e-6, 0], [2e-6, 0]],
    ] as const) {
      const fade = nightLightsFade(dx, dy, 0.667, 10800, 1)
      expect(Number.isFinite(fade)).toBe(true)
      expect(fade).toBe(NIGHT_FADE_FLOOR)
    }
  })

  it('reads the narrow axis, whatever the long one or the heading', () => {
    const viirs = C / GIBS_GROUND_WIDTH
    for (const across of [viirs / 2, viirs / 8, viirs / 20]) {
      const square = fadeAt(across, across, { fine: 1 })
      for (const stretch of [1, 4, 30, 300]) {
        for (const heading of [0, 37, 90]) {
          expect(fadeAt(across * stretch, across, { fine: 1, heading })).toBeCloseTo(square, 9)
        }
      }
    }
    // At the map's texel east-west narrows by cos(lat): a pixel half a
    // texel wide either way has the texel's north-south size to compare.
    expect(fadeAt(100, 100, { lat: 0 })).toBeCloseTo(fadeAt(100, 100, { lat: 60 }), 9)
  })

  // The globe differences the interpolated uv: what its float32 step (2^-24
  // from 0.5 up) does to the factor over Cairo, east-west and north-south.
  it("stays near FLOOR where the globe's uv steps are some of the pixel, and moves little with a step", () => {
    const step = 2 ** -24
    const lat = 30.05
    const k = Math.cos(lat * D)
    const v = 0.5 + lat / 180
    const stepEast = step * C * k
    const stepNorth = (step * C) / 2
    expect(stepEast).toBeCloseTo(2.07, 2)
    expect(stepNorth).toBeCloseTo(1.19, 2)
    let worst = 0
    for (let p = 1; p < 700; p *= 1.01) {
      const dx = [p / (C * k), 0] as const
      const dy = [0, (2 * p) / C] as const
      for (const fine of [0, 1]) {
        const fade = nightLightsFade(dx, dy, v, 10800, fine)
        // A step a tenth of the pixel or more: near FLOOR with VIIRS's
        // texel; past END with the map's alone once a step is a fiftieth.
        if (stepEast >= p / 10) expect(fade).toBeLessThan(fine ? 0.13 : 1e-12)
        if (stepEast >= p / 50 && !fine) expect(fade).toBe(NIGHT_FADE_FLOOR)
        for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1]]) {
          const off = nightLightsFade([dx[0] + ex * step, 0], [0, dy[1] + ey * step], v, 10800, fine)
          worst = Math.max(worst, Math.abs(off - fade))
        }
      }
    }
    expect(worst).toBeLessThan(0.05)
  })
})
