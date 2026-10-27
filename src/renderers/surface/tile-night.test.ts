// The night on the streamed tiles (tides-zmw.9.13): the globe's city
// lights, VIIRS redistribution, night-side mask and flight fill by rename,
// in the globe's order, on the globe's uniforms.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { CITY_LIGHTS_COLOR, CITY_LIGHTS_INTENSITY } from '../../lighting'
import { GIBS_COLS, GIBS_ROWS } from '../../gibs-patch'
import { composePatches } from '../eclipseShadow'
import { createGibsNightPatch, GIBS_NIGHT_GLSL } from '../gibsNightPatch'
import { NIGHT_LIGHTS_GLSL, nightLightsPatch, type NightFlightUniforms } from '../nightLights'
import type { GlobeLink } from './surface-link'
import { tileEclipse } from './tile-eclipse'
import { cityLightsColor, NIGHT_MASK_SUN, tileNight, TILE_NIGHT_GLSL } from './tile-night'
import { createTileComposer, surfaceGlobeUv, surfaceGlobeUvDelta, type TerrainPhongMaterial } from './tile-material'
import { compiled, fakeLink, phongShader, tileMesh } from './tile-test-fixtures'

const flight = (): NightFlightUniforms => ({
  uNightMoon: { value: new THREE.Vector3(0, 1, 0) },
  uNightMoonView: { value: new THREE.Vector3(0, 0, 1) },
  uNightFill: { value: new THREE.Color(0.01, 0.01, 0.02) },
  uNightMoonLight: { value: new THREE.Color(0.02, 0.02, 0.03) },
})

/** A link in flight with a GIBS night stream `side` tiles square. */
function nightLink(side = 8, withFlight = true): GlobeLink {
  const link = fakeLink()
  link.nightFlight = withFlight ? flight() : null
  const globe = createGibsNightPatch(side)
  link.gibsNight = { patch: globe.material, uniforms: globe.uniforms, side }
  return link
}

function tileShader(link: GlobeLink, slots = [{ name: 'night', adapter: tileNight }]) {
  const mesh = tileMesh()
  const composer = createTileComposer(link, slots)
  composer.prepare(mesh, {})
  return { composer, shader: compiled(mesh.material as TerrainPhongMaterial) }
}

const after = (source: string, include: string) => source.slice(source.indexOf(`#include <${include}>`) + `#include <${include}>`.length)

describe('the night on the tiles (tides-zmw.9.13)', () => {
  it('takes the globe\'s GLSL, renaming only the direction, the map\'s uv, size and colour, and the derivatives', () => {
    expect(TILE_NIGHT_GLSL.maskHead).toBe(NIGHT_LIGHTS_GLSL.fragmentHead.replace('varying vec3 vNightLightsDir;', ''))
    expect(TILE_NIGHT_GLSL.maskBody).toBe(NIGHT_LIGHTS_GLSL.fragmentBody.replace('vNightLightsDir', 'surfaceUp'))
    expect(TILE_NIGHT_GLSL.flightLight).toBe(
      'if (dot(surfaceUp, uNightLightsSun) < 0.035000)' + NIGHT_LIGHTS_GLSL.flightLightBody.replace('vNightLightsDir', 'surfaceUp')
    )
    const g = TILE_NIGHT_GLSL.gibsBody
    for (const gone of ['vEmissiveMapUv', 'emissiveMap', 'USE_EMISSIVEMAP', '#endif', 'dFdx', 'dFdy', 'emissive *']) expect(g, gone).not.toContain(gone)
    expect(g.split('surfaceGlobeUv').length - 1).toBe(3)
    expect(g).toContain('textureSize(uTileNightMap, 0)')
    expect(g).toContain('totalEmissiveRadiance = uTileCityLights * emissiveColor.rgb;')
    const derivative = `vec2 nightDx = (surfaceGlobeDx * vec2(${GIBS_COLS.toFixed(6)}, ${(-GIBS_ROWS).toFixed(6)}));`
    expect(g).toContain(derivative)
    // Everything else is the globe's, line for line.
    const globe = GIBS_NIGHT_GLSL.emissiveBody.split('\n').filter((l) => !/vEmissiveMapUv|emissiveMap|USE_EMISSIVEMAP|#endif|dFd[xy]\(nightAt\)|emissive \*/.test(l))
    const tile = g.split('\n')
    for (const line of globe) expect(tile, line).toContain(line)
  })

  it('reads the map with the patch\'s derivative: d(patch) = d(uv) (COLS, -ROWS), smooth at the antimeridian', () => {
    const nightAt = (uv: THREE.Vector2, ox: number, oy: number) =>
      new THREE.Vector2((((uv.x - ox / GIBS_COLS) % 1) + 1) % 1 * GIBS_COLS, (1 - uv.y) * GIBS_ROWS - oy)
    for (const [lat, lon] of [[36.1, -112.1], [51.5, -0.1], [-33.9, 151.2], [64.1, 179.9]]) {
      const D = Math.PI / 180
      // A direction in the ground's frame (lon 0 at +X, east towards -Z, Y north).
      const up = new THREE.Vector3(Math.cos(lat * D) * Math.cos(lon * D), Math.sin(lat * D), -Math.cos(lat * D) * Math.sin(lon * D))
      const step = new THREE.Vector3(0.3, -0.2, 0.5).cross(up).normalize().multiplyScalar(1e-7)
      const a = nightAt(surfaceGlobeUv(up), 37, 12)
      const b = nightAt(surfaceGlobeUv(up.clone().add(step)), 37, 12)
      const analytic = surfaceGlobeUvDelta(up, step).multiply(new THREE.Vector2(GIBS_COLS, -GIBS_ROWS))
      const numeric = b.sub(a)
      numeric.x -= GIBS_COLS * Math.round(numeric.x / GIBS_COLS) // the patch's own wrap
      expect(analytic.x).toBeCloseTo(numeric.x, 7)
      expect(analytic.y).toBeCloseTo(numeric.y, 7)
    }
  })

  it('skips the map and the fill only where the globe\'s mask is 0 (the Sun above sin 0.035)', () => {
    expect(NIGHT_MASK_SUN).toBe(0.035)
    expect(NIGHT_LIGHTS_GLSL.flightLightBody).toContain('1.0 - smoothstep(-0.1, 0.035, dot(nightUp, uNightLightsSun))')
    expect(TILE_NIGHT_GLSL.gateOpen).toContain('if (dot(surfaceUp, uNightLightsSun) < 0.035000) {')
    expect(NIGHT_LIGHTS_GLSL.fragmentBody).toContain('smoothstep(0.035, -0.1, dot(normalize(vNightLightsDir), uNightLightsSun))')
    // smoothstep(0.035, -0.1, x) is 0 from x = 0.035 up.
    const mask = (x: number) => { const t = Math.min(Math.max((x - 0.035) / (-0.1 - 0.035), 0), 1); return t * t * (3 - 2 * t) }
    expect(mask(0.035)).toBe(0)
    expect(mask(0.0349)).toBeGreaterThan(0)
  })

  it('lights the city at the globe\'s emissive colour (emissive times intensity, the colour made linear)', () => {
    const globe = new THREE.MeshPhongMaterial({ emissive: CITY_LIGHTS_COLOR, emissiveIntensity: CITY_LIGHTS_INTENSITY })
    const expected = globe.emissive.clone().multiplyScalar(globe.emissiveIntensity)
    const got = cityLightsColor()
    for (const k of ['r', 'g', 'b'] as const) expect(got[k]).toBeCloseTo(expected[k], 9)
  })

  it('lays the map, VIIRS, the fade, then the mask after the emissive chunk, as the globe\'s patches leave them', () => {
    const link = nightLink(8)
    const { composer, shader } = tileShader(link)
    expect(composer.key).toBe('surface-tile:surface-base+night-surface-flight-gibs8')
    const f = shader.fragmentShader
    const emissive = after(f, 'emissivemap_fragment')
    const at = (s: string) => emissive.indexOf(s)
    // The map and VIIRS on the night side only (the mask is 0 elsewhere).
    expect(at(TILE_NIGHT_GLSL.gateOpen)).toBe(1)
    expect(at(TILE_NIGHT_GLSL.cityBody)).toBeGreaterThan(at(TILE_NIGHT_GLSL.gateOpen))
    expect(at(TILE_NIGHT_GLSL.gibsBody)).toBeGreaterThan(at(TILE_NIGHT_GLSL.cityBody))
    expect(at(TILE_NIGHT_GLSL.gibsBody + TILE_NIGHT_GLSL.fadeBody + TILE_NIGHT_GLSL.gateClose)).toBeGreaterThan(-1)
    expect(at(TILE_NIGHT_GLSL.maskBody)).toBeGreaterThan(at(TILE_NIGHT_GLSL.gibsBody))
    expect(at(TILE_NIGHT_GLSL.maskBody)).toBeLessThan(at('#include'))
    // The globe's own order: compose its patches on a Phong shader and
    // compare what each leaves after the chunk, renamed.
    const sun = link.sunDir
    const globe = composePatches(nightLightsPatch(sun, link.nightFlight!), link.gibsNight.patch)
    const globeShader = phongShader()
    globe.onBeforeCompile(globeShader, {} as THREE.WebGLRenderer)
    const g = after(globeShader.fragmentShader, 'emissivemap_fragment')
    expect(g.indexOf(GIBS_NIGHT_GLSL.emissiveBody)).toBeLessThan(g.indexOf(NIGHT_LIGHTS_GLSL.fadeBody))
    expect(g.indexOf(NIGHT_LIGHTS_GLSL.fadeBody + NIGHT_LIGHTS_GLSL.fragmentBody)).toBeGreaterThan(-1)
    // The fill after the lights, before the emissive's use.
    const light = after(f, 'lights_fragment_end')
    expect(light.indexOf(TILE_NIGHT_GLSL.flightLight)).toBe(1)
    expect(after(globeShader.fragmentShader, 'lights_fragment_end').indexOf(NIGHT_LIGHTS_GLSL.flightLightBody)).toBe(1)
  })

  it('puts the fill before the eclipse\'s code at the lights, as on the globe (later slots land first)', () => {
    const { shader } = tileShader(nightLink(8), [
      { name: 'eclipse', adapter: tileEclipse },
      { name: 'night', adapter: tileNight },
    ])
    const light = after(shader.fragmentShader, 'lights_fragment_end')
    expect(light.indexOf(TILE_NIGHT_GLSL.flightLight)).toBeLessThan(light.indexOf('reflectedLight.directSpecular *= eclipse.x;'))
  })

  it('binds the globe\'s own uniforms, adds no varying and leaves no globe name behind', () => {
    const link = nightLink(8)
    const { shader } = tileShader(link)
    expect(shader.uniforms.uTileNightMap).toBe(link.maps.night)
    expect(shader.uniforms.uNightLightsSun).toBe(link.sunDir)
    for (const [name, u] of Object.entries(link.nightFlight!)) expect(shader.uniforms[name], name).toBe(u)
    for (const [name, u] of Object.entries(link.gibsNight.uniforms)) expect(shader.uniforms[name], name).toBe(u)
    const f = shader.fragmentShader
    for (const gone of ['vNightLightsDir', 'vEmissiveMapUv', 'emissiveMap', 'USE_EMISSIVEMAP']) expect(f, gone).not.toContain(gone)
    expect(shader.vertexShader).not.toContain('Night')
    expect(f.split('varying ').length).toBe(THREE.ShaderLib.phong.fragmentShader.split('varying ').length)
    // Every name the night's code reads is declared above main.
    const main = f.indexOf('void main')
    for (const decl of ['uniform sampler2D uTileNightMap;', 'uniform vec3 uTileCityLights;', 'uniform vec3 uNightLightsSun;', 'uniform vec3 uNightFill;', 'uniform sampler2D uGibsNight;', 'float gibsNightCover = 0.0;', NIGHT_LIGHTS_GLSL.fadeHead]) {
      expect(f.indexOf(decl), decl).toBeGreaterThan(-1)
      expect(f.indexOf(decl), decl).toBeLessThan(main)
    }
  })

  it('outside flight and without a stream lays the lights and the mask alone', () => {
    const { composer, shader } = tileShader(nightLink(0, false))
    expect(composer.key).toBe('surface-tile:surface-base+night-surface')
    const f = shader.fragmentShader
    expect(f).toContain(TILE_NIGHT_GLSL.cityBody)
    expect(f).toContain(TILE_NIGHT_GLSL.maskBody)
    expect(f).not.toContain('uNightFill')
    expect(f).not.toContain('uGibsNight')
    expect(f).not.toMatch(/nightLightsFade|nightFade/)
  })

  // tides-zmw.24: the globe's fade, on the base's analytic derivatives.
  it("fades the lights by the globe's function, never differencing", () => {
    expect(TILE_NIGHT_GLSL.fadeHead).toBe(NIGHT_LIGHTS_GLSL.fadeHead)
    expect(TILE_NIGHT_GLSL.fadeBody).toBe(
      `{${NIGHT_LIGHTS_GLSL.fadeCall
        .replace('nightFadeDx', 'surfaceGlobeDx')
        .replace('nightFadeDy', 'surfaceGlobeDy')
        .replace('vEmissiveMapUv', 'surfaceGlobeUv')
        .replace('textureSize(emissiveMap, 0)', 'textureSize(uTileNightMap, 0)')}}\n`
    )
    expect(TILE_NIGHT_GLSL.fadeBody).toContain(
      'nightLightsFade(surfaceGlobeDx, surfaceGlobeDy, surfaceGlobeUv.y,\n    float(textureSize(uTileNightMap, 0).x), nightFadeFine)'
    )
    // No derivative in any of the tiles' night code.
    for (const code of Object.values(TILE_NIGHT_GLSL)) {
      const text = typeof code === 'function' ? code(8) : code
      expect(text).not.toMatch(/dFd[xy]|fwidth/)
    }
    // In flight without a stream: inside the gate after the map, VIIRS's
    // cover 0 (no GIBS_NIGHT_SIDE); the keys as before.
    const { composer, shader } = tileShader(nightLink(0))
    expect(composer.key).toBe('surface-tile:surface-base+night-surface-flight')
    const emissive = after(shader.fragmentShader, 'emissivemap_fragment')
    expect(emissive.indexOf(TILE_NIGHT_GLSL.cityBody + TILE_NIGHT_GLSL.fadeBody + TILE_NIGHT_GLSL.gateClose)).toBeGreaterThan(-1)
    expect(shader.fragmentShader).not.toContain('#define GIBS_NIGHT_SIDE')
    // Without flight, a stream but no fade.
    const still = tileShader(nightLink(8, false))
    expect(still.composer.key).toBe('surface-tile:surface-base+night-surface-gibs8')
    expect(still.shader.fragmentShader).not.toMatch(/nightLightsFade|nightFade/)
  })
})
