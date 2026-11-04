// The date's sea ice in the globe's ground shader (tides-6ru.2): no texture
// unit of its own on any tier or detail, its tap placed between the
// specular mask and what reads it, its colour with it, the
// ground detail's land kept off the repainted sea, and the layers' uniforms
// shared.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { CLOUD_AMBIENT } from '../lighting'
import { createCloudLayer } from './cloudShaders'
import { composePatches, createEclipseShadow, type MaterialPatch } from './eclipseShadow'
import { earthHorizon } from './earthHorizonTexture'
import { createGibsNightPatch } from './gibsNightPatch'
import { createGibsPatch } from './gibsPatch'
import { createGroundDisplacement } from './groundDisplacement'
import { groundDetailPatch } from './groundDetail'
import { createGroundHaze } from './groundHaze'
import { groundShadowPatch } from './groundShadow'
import { createNightFlight, nightLightsPatch } from './nightLights'
import { poleSmoothingPatch } from './poleSmoothing'
import { seaIceGroundPatch, SEA_ICE_GROUND_GLSL } from './seaIceGround'
import { seaIceSurface } from './seaIceLayers'
import { phongShader } from './surface/tile-test-fixtures'
import { createWater, waterPatch } from './water'
import { waterSeaTexture, WATER_SEA_UNIFORM } from './waterClimate'

const samplers = (f: string) => (f.match(/uniform\s+sampler\w+\s+\w+/g) ?? []).sort()

/** The ground's patches as EarthRenderer's groundPatchOf composes them, on
 * `low`'s tier, drawn or with flight detail, with or without the ice. */
function ground(low: boolean, flight: boolean, ice: boolean) {
  const eclipse = createEclipseShadow('earth')
  const clouds = createCloudLayer(eclipse, low)
  const sun = clouds.uniforms.uSunDir
  const haze = createGroundHaze(sun, 2.95, low)
  const water = createWater(haze.frame)
  const night = createNightFlight(sun, { value: CLOUD_AMBIENT })
  const patches: MaterialPatch[] = [
    eclipse.material,
    clouds.groundPatch,
    nightLightsPatch(sun, flight ? night.uniforms : undefined),
    poleSmoothingPatch(),
    groundDetailPatch(low),
    groundShadowPatch(sun, earthHorizon('horizon.bin')),
    waterPatch(water, haze.frame, low, { value: new THREE.Texture() }),
    ...(ice ? [seaIceGroundPatch(water.uniforms.uWaterSea)] : []),
    createGibsPatch(flight ? 8 : 0).material,
    createGibsNightPatch(flight ? 8 : 0).material,
    haze.patch,
  ]
  const patch = composePatches(composePatches(...patches), createGroundDisplacement([256, 128]).patch)
  const shader = phongShader()
  // The ground's material has a displacement map, which the relief reads.
  ;(shader as unknown as { displacementMap: boolean }).displacementMap = true
  patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
  clouds.dispose()
  return { shader, water, key: patch.customProgramCacheKey() }
}

describe('the sea ice on the globe\'s ground (tides-6ru.2)', () => {
  it('adds no texture unit on either tier, drawn or in flight', () => {
    for (const low of [false, true]) {
      for (const flight of [false, true]) {
        const withIce = ground(low, flight, true).shader.fragmentShader
        const without = ground(low, flight, false).shader.fragmentShader
        expect(samplers(withIce), `low ${low}, flight ${flight}`).toEqual(samplers(without))
        expect(samplers(withIce).length).toBeGreaterThan(0)
        // The array once, the water's.
        expect(withIce.split(WATER_SEA_UNIFORM).length - 1).toBe(1)
        // The elevation it reads is the relief's own declaration.
        expect(withIce.split('uniform sampler2D displacementMap;').length - 1).toBe(1)
      }
    }
  })

  it('keys its program, one for every state', () => {
    expect(ground(false, false, true).key).toContain('+water-12+sea-ice-ground+')
    expect(ground(true, true, true).key).toContain('+water-6+sea-ice-ground+')
  })

  it('taps and colours after the specular mask, before the ground detail and the water read them', () => {
    const { shader, water } = ground(false, false, true)
    const f = shader.fragmentShader
    const at = (text: string) => {
      const i = f.indexOf(text)
      expect(i, text.slice(0, 60)).toBeGreaterThan(-1)
      return i
    }
    const main = at('void main')
    expect(at('#define SEA_ICE_GROUND')).toBeLessThan(main)
    expect(at(WATER_SEA_UNIFORM)).toBeLessThan(main)
    expect(at('vec2 seaIceCells(vec3 dir)')).toBeLessThan(main)
    const tap = at('vec4 seaIceTexel = vec4(0.0);')
    expect(tap).toBeGreaterThan(at('#include <specularmap_fragment>'))
    expect(at('specularStrength *= 1.0 - seaIceAlpha;')).toBeLessThan(at('float groundLand = 1.0 - specularStrength;'))
    expect(tap).toBeLessThan(at('waterBody(diffuseColor.rgb)'))
    // The ground detail: the repainted sea no land, the ice as ice.
    expect(at('groundLand *= 1.0 - seaIceOpen;')).toBeLessThan(at('if (groundLand > 0.0)'))
    expect(at('ice = max(ice, seaIceAlpha - seaIceOpen);')).toBeGreaterThan(at('float ice = '))
    // The colour with the tap, before the ground detail's grain and the
    // water's body: only the alpha and the repainted sea's share live past it.
    const colour = at('if (seaIceAlpha > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb,')
    expect(colour).toBeGreaterThan(tap)
    expect(colour).toBeLessThan(at('float groundLand = 1.0 - specularStrength;'))
    expect(colour).toBeLessThan(at('waterBody(diffuseColor.rgb)'))
    expect(f.split('diffuseColor.rgb = mix(diffuseColor.rgb, mix(').length - 1).toBe(1)
    expect(SEA_ICE_GROUND_GLSL.head).not.toContain('seaIceShare')
    // The sea: the elevation's 0 m, or the specular map's water (the day
    // map's coast), read before the water gives way to the ice.
    expect(SEA_ICE_GROUND_GLSL.body).toContain('textureLod(displacementMap, vMapUv, seaIceDemLod).r')
    expect(SEA_ICE_GROUND_GLSL.body).toMatch(/max\(\(1\.0 - smoothstep\([^;]*\), specularStrength\)/)
    const body0 = SEA_ICE_GROUND_GLSL.body
    expect(body0.indexOf(', specularStrength)')).toBeLessThan(body0.indexOf('specularStrength *= 1.0 - seaIceAlpha;'))
    expect(SEA_ICE_GROUND_GLSL.body).not.toContain('specularMap')
    // Its level by the north-south slope, taken before the branch on the place.
    const body = SEA_ICE_GROUND_GLSL.body
    expect(body.indexOf('dFdx(vMapUv.y)')).toBeGreaterThan(-1)
    expect(body.indexOf('dFdx(vMapUv.y)')).toBeLessThan(body.indexOf('if (abs(seaIceUp.y) > 0.5)'))
    expect(body).not.toContain('dFdx(vMapUv.x)')
    // Off the uniforms: one program, the ice skipped where off.
    expect(SEA_ICE_GROUND_GLSL.body).toContain('if (uSeaIceOn * uSeaIceGround > 0.0)')
    // No varying of its own: the ground detail's undisplaced position.
    expect(SEA_ICE_GROUND_GLSL.body).toContain('normalize(vGroundDetailPos)')
    expect(SEA_ICE_GROUND_GLSL.head).not.toContain('varying')
    expect(shader.vertexShader.split('varying ').length).toBe(ground(false, false, false).shader.vertexShader.split('varying ').length)
    // The layers' uniforms, the same objects.
    expect(shader.uniforms.uSeaIceOn).toBe(seaIceSurface.on)
    expect(shader.uniforms.uSeaIceGround).toBe(seaIceSurface.ground)
    expect(shader.uniforms.uSeaIceMix).toBe(seaIceSurface.mix)
    expect(shader.uniforms.uWaterSea).toBe(water.uniforms.uWaterSea)
  })

  it('alone, declares the sea\'s array itself, before main', () => {
    const shader = phongShader()
    seaIceGroundPatch({ value: waterSeaTexture() }).onBeforeCompile(shader, {} as THREE.WebGLRenderer)
    const f = shader.fragmentShader
    expect(f.split(WATER_SEA_UNIFORM).length - 1).toBe(1)
    expect(f.indexOf(WATER_SEA_UNIFORM)).toBeLessThan(f.indexOf('void main'))
  })
})
