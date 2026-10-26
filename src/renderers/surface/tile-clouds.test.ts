// The clouds' shadows on the streamed tiles (tides-zmw.9.12): the globe's
// GLSL by rename, laid where the globe lays it, on the cloud layer's
// uniforms, and composing with the haze as the globe's does.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { CLOUD_GROUND_GLSL, createCloudLayer } from '../cloudShaders'
import { createEclipseShadow } from '../eclipseShadow'
import { TILE_FEATURES } from './tile-features'
import { CLOUD_GROUND_LOD_FLOOR, tileClouds, tileCloudsGlsl, tileCloudsOn } from './tile-clouds'
import { tileEclipse } from './tile-eclipse'
import { tileHaze } from './tile-haze'
import { createTileComposer, SURFACE_ANCHORS, type TerrainPhongMaterial, type TileFeatureSlot } from './tile-material'
import { compiled, fakeLink, phongShader, tileMesh } from './tile-test-fixtures'

function cloudLink(flat = false, live = true) {
  const link = fakeLink()
  const clouds = createCloudLayer(createEclipseShadow('earth'), flat, live)
  link.clouds = { uniforms: clouds.uniforms, flat }
  link.sunDir = clouds.uniforms.uSunDir
  return { link, clouds }
}

function tileShader(slots: readonly TileFeatureSlot[], flat = false, live = true) {
  const { link, clouds } = cloudLink(flat, live)
  const mesh = tileMesh()
  const composer = createTileComposer(link, slots)
  composer.prepare(mesh, {})
  return { link, clouds, composer, shader: compiled(mesh.material as TerrainPhongMaterial) }
}

const count = (source: string, text: string) => source.split(text).length - 1

describe('the cloud shadows on the tiles (tides-zmw.9.12)', () => {
  it('takes the globe\'s GLSL, renaming only the point, its footprint and its varying', () => {
    for (const flat of [false, true]) {
      for (const live of [false, true]) {
        const glsl = tileCloudsGlsl(flat, live)
        const globe = CLOUD_GROUND_GLSL.head(flat, live).replace('length(fwidth(vCloudGround))', 'surfaceCloudFootprint')
        expect(glsl.vertexHead).toBe(
          globe.replace('varying vec3 vCloudGround;', 'varying float vSurfaceCloudLit;\nconst float surfaceCloudFootprint = 1e-20;')
        )
        expect(glsl.fragmentHead).toBe(globe.replace('varying vec3 vCloudGround;', 'varying float vSurfaceCloudLit;\nfloat surfaceCloudFootprint;'))
        expect(glsl.light).toBe(
          CLOUD_GROUND_GLSL.light.replace(
            'cloudGroundShadow(normalize(vCloudGround))',
            '(cloudLod(surfaceCloudFootprint) + 1.0 > 2.5 ? cloudGroundShadow(surfaceUp) : vSurfaceCloudLit)'
          )
        )
        const all = Object.values(glsl).join('\n')
        expect(all).not.toContain('vCloudGround')
        expect(all).not.toContain('surfaceGround')
        expect(glsl.fragmentBody).toBe('surfaceCloudFootprint = length(fwidth(surfaceRay));')
        expect(glsl.vertexHead.startsWith('#define CLOUD_FLAT\n')).toBe(flat)
        expect(glsl.fragmentHead.includes('uTerrainScale')).toBe(live)
      }
    }
  })

  it('switches to the fragment\'s own shadow just where the globe\'s blur leaves its floor', () => {
    // The floor the vertex stage runs at is the globe's.
    expect(CLOUD_GROUND_GLSL.head(false, false)).toContain(
      `float lod = max(cloudLod(length(fwidth(vCloudGround))) + 1.0, ${CLOUD_GROUND_LOD_FLOOR.toFixed(1)});`
    )
    // cloudLod() of the vertex's footprint is 0 (log2 of a tiny, not zero, ratio).
    expect(Math.max(0, Math.log2(Math.fround(1e-20) / ((2 * Math.PI * 2.95) / 2560)))).toBe(0)
  })

  it('exports the GLSL groundPatch lays on the globe, to the byte', () => {
    for (const flat of [false, true]) {
      for (const live of [false, true]) {
        const shader = phongShader()
        createCloudLayer(createEclipseShadow('earth'), flat, live).groundPatch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
        expect(shader.fragmentShader).toContain(`#include <common>\n${CLOUD_GROUND_GLSL.head(flat, live)}`)
        expect(shader.fragmentShader).toContain(`#include <lights_fragment_end>\n${CLOUD_GROUND_GLSL.light}`)
      }
    }
  })

  it('lays the shadow per vertex and after the lights, on the cloud layer\'s uniforms, with one float varying', () => {
    const { link, composer, shader } = tileShader([{ name: 'clouds', adapter: tileCloudsOn(true) }])
    expect(composer.key).toBe('surface-tile:surface-base+cloud-shadow-live-surface')
    const v = shader.vertexShader
    const f = shader.fragmentShader
    expect(v + f).not.toContain('vCloudGround')
    expect(v.split('varying ').length).toBe(THREE.ShaderLib.phong.vertexShader.split('varying ').length + 1)
    for (const stage of [v, f]) expect(count(stage, 'varying float vSurfaceCloudLit;')).toBe(1)
    // Vertex: the field after the base's head, the shadow after its surfaceUp.
    expect(v.indexOf(SURFACE_ANCHORS.vertexHead)).toBeLessThan(v.indexOf('float cloudGroundShadow(vec3 dir)'))
    expect(v.indexOf('float cloudGroundShadow(vec3 dir)')).toBeLessThan(v.indexOf('void main'))
    expect(v.indexOf('surfaceUp = SURFACE_GROUND_FROM_ECEF * objectNormal;')).toBeLessThan(
      v.indexOf('vSurfaceCloudLit = cloudGroundShadow(normalize(surfaceUp));')
    )
    // Fragment: the footprint from the ray, early; the light after the lights.
    expect(f.indexOf('vec3 surfaceRay;')).toBeLessThan(f.indexOf('float cloudGroundShadow(vec3 dir)'))
    expect(f.indexOf(SURFACE_ANCHORS.fragmentHead)).toBeLessThan(f.indexOf('float cloudGroundShadow(vec3 dir)'))
    expect(f.indexOf('float cloudGroundShadow(vec3 dir)')).toBeLessThan(f.indexOf('void main'))
    expect(f.indexOf('surfaceRay = uSurfaceViewToGround * -vViewPosition;')).toBeLessThan(
      f.indexOf('surfaceCloudFootprint = length(fwidth(surfaceRay));')
    )
    expect(f.indexOf('surfaceCloudFootprint = length(fwidth(surfaceRay));')).toBeLessThan(f.indexOf('#include <lights_fragment_begin>'))
    expect(f.indexOf('surfaceUp = normalize(surfaceGround);')).toBeLessThan(f.indexOf('cloudGroundShadow(surfaceUp)'))
    expect(f.indexOf('#include <lights_fragment_end>')).toBeLessThan(f.indexOf('reflectedLight.directDiffuse *= cloudLit;'))
    const uniforms = link.clouds.uniforms as unknown as Record<string, THREE.IUniform>
    for (const name of Object.keys(uniforms)) expect(shader.uniforms[name], name).toBe(uniforms[name])
    expect(shader.uniforms.uSunDir).toBe(link.sunDir)
  })

  it('keys the low tier\'s flat layer and the fixed scale apart', () => {
    expect(tileShader([{ name: 'clouds', adapter: tileCloudsOn(false) }], true, false).composer.key).toBe(
      'surface-tile:surface-base+cloud-shadow-flat-surface'
    )
    const flat = tileShader([{ name: 'clouds', adapter: tileCloudsOn(true) }], true, true)
    expect(flat.composer.key).toBe('surface-tile:surface-base+cloud-shadow-flat-live-surface')
    expect(flat.shader.fragmentShader).toContain('#define CLOUD_FLAT')
    expect(typeof tileClouds(cloudLink().link)?.patch.customProgramCacheKey()).toBe('string')
  })

  it('declares the field\'s uniforms once, after the haze\'s uSeaLevel macro is dropped, as on the globe', () => {
    for (const slots of [
      [
        { name: 'eclipse', adapter: tileEclipse },
        { name: 'clouds', adapter: tileCloudsOn(true) },
        { name: 'haze', adapter: tileHaze },
      ],
      TILE_FEATURES.map((slot) => (slot.name === 'clouds' ? { name: 'clouds', adapter: tileCloudsOn(true) } : slot)),
    ]) {
      const { vertexShader: v, fragmentShader: f } = tileShader(slots).shader
      for (const declaration of ['uniform float uSeaLevel;', 'uniform vec3 uSunDir;', 'uniform sampler2D uCloudMap;']) {
        expect(count(f, declaration), declaration).toBe(1)
        expect(count(v, declaration), declaration).toBe(1)
      }
      expect(v).not.toContain('#define uSeaLevel')
      // The terrain scale's guarded declaration, first by the scale's patch.
      expect(count(f, 'uniform float uTerrainScale;')).toBeGreaterThan(1)
      expect(f.indexOf('#ifndef TERRAIN_SCALE_DECLARED')).toBeLessThan(f.indexOf('uniform float uTerrainScale;'))
      // The haze's macro over its own code only, above the field.
      expect(f.indexOf('#define uSeaLevel uGroundHazeSeaLevel')).toBeLessThan(f.indexOf('#undef uSeaLevel'))
      expect(f.indexOf('#undef uSeaLevel')).toBeLessThan(f.indexOf('uniform float uSeaLevel;'))
      // The globe's light order: the clouds' text before the eclipse's.
      expect(f.indexOf('reflectedLight.directDiffuse *= cloudLit;')).toBeLessThan(f.indexOf('reflectedLight.directSpecular *= eclipse.x;'))
    }
  })

  it('reads the footprint from the ray, which differs from the ground point by the eye alone', () => {
    // surfaceGround = eye + surfaceRay with the eye a uniform: their screen
    // derivatives are the same, but the ground's float32 rounds ~0.5 m at
    // Earth's radius (tile-material.test.ts), so a pixel's footprint of a
    // metre or so would read as 0 or 1 ulp from it.
    const seaLevel = 2.95
    const eye = new THREE.Vector3(0.3, seaLevel + 0.0005, -0.2)
    const ray = new THREE.Vector3(1e-4, -4e-4, 2e-5)
    const step = new THREE.Vector3(0, 1.7e-7, 0) // ~0.4 m up (a unit is ~2160 km)
    const f32 = (v: THREE.Vector3) => new THREE.Vector3(Math.fround(v.x), Math.fround(v.y), Math.fround(v.z))
    const fromGround = f32(eye.clone().add(ray).add(step)).sub(f32(eye.clone().add(ray))).length()
    const fromRay = f32(ray.clone().add(step)).sub(f32(ray)).length()
    expect(Math.abs(fromRay - step.length()) / step.length()).toBeLessThan(1e-3)
    expect(Math.abs(fromGround - step.length()) / step.length()).toBeGreaterThan(0.1)
  })
})
