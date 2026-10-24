import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { TERRAIN_DISPLACEMENT } from '../cloud-layer'
import { latLonToLocal } from '../aurora'
import { DEM_METRES_PER_UNIT, boxMips, decodeEarthDem, demLevel, toHalfBits } from '../earth-dem'
import { LIMB_FACET_PX, LIMB_SEGMENTS, limbFacetPx, type SphereSegments } from '../ship/limb-detail'
import { EARTH_GROUND_CLEARANCE, EARTH_RADIUS } from '../ship/ship-bodies'
import { SHIP_FOV } from '../ship/ship-session'
import { EARTH_BASE_SEGMENTS, TERRAIN_GREY_MARGIN, buildTerrainFloor, meanGrey } from '../ship/terrain-floor'
import {
  baseGroundGrey,
  displace,
  groundLevels,
  meshGrid,
  meshRadius,
  readGround,
  vertexGrey,
  worstNeedle,
} from '../ship/ground-mesh-model'
import { MORPH_END_PX, MORPH_FLOOR, MORPH_START_PX, createGroundDisplacement, groundLod, groundMorph } from './groundDisplacement'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { createCloudLayer } from './cloudShaders'
import { groundDetailPatch } from './groundDetail'

const shipped = (name: string) => decodeEarthDem(readFileSync(new URL(`../assets/${name}`, import.meta.url)))
const [dem4k, dem2k, demMean] = await Promise.all(['earth-dem-4k.bin', 'earth-dem-2k.bin', 'earth-dem-mean.bin'].map(shipped))
const metres = (grey: number) => (grey / 255) * DEM_METRES_PER_UNIT
const ground4k = groundLevels(dem4k)
const base = meshGrid(EARTH_BASE_SEGMENTS)
const limb = meshGrid(LIMB_SEGMENTS)

describe('ground displacement (tides-zmw.2)', () => {
  it("reads each mesh at the level whose rows match its own, on both tiers' maps", () => {
    for (const dem of [dem4k, dem2k]) {
      const [top] = groundLevels(dem)
      expect([top.width, top.height]).toEqual([...LIMB_SEGMENTS])
      expect(groundLod(top.height, LIMB_SEGMENTS[1])).toBe(0)
      expect(groundLod(top.height, EARTH_BASE_SEGMENTS[1])).toBe(1)
    }
    // The flat fallback's 1 × 1 map reads its only level.
    expect(groundLod(1, 128)).toBe(0)
  })

  it('stands no vertex far over all 8 of its neighbours, on either sphere: no needles', () => {
    // three's own displacement read the full map at each vertex: one vertex
    // of a peak stood up to ~1.9 km over its neighbours.
    const full = boxMips(demLevel(dem4k)).map(({ width, height, data }) => ({
      width,
      height,
      data: Float32Array.from(data, (h) => THREE.DataUtils.fromHalfFloat(toHalfBits(h)) * 255),
    }))
    for (const grid of [base, limb]) {
      const fullRead = Float32Array.from({ length: grid.uv.length / 2 }, (_, k) => readGround(full, grid.uv[2 * k], grid.uv[2 * k + 1], 0))
      expect(metres(worstNeedle(fullRead, grid.segments))).toBeGreaterThan(1500)
      for (const dem of [dem4k, dem2k]) {
        // ~430 m on the base sphere, ~320 m on the limb sphere.
        expect(metres(worstNeedle(vertexGrey(groundLevels(dem), grid), grid.segments))).toBeLessThan(500)
      }
    }
  })

  describe('the limb sphere morphed fully toward the base sphere', () => {
    const baseMesh = displace(base, vertexGrey(ground4k, base), EARTH_RADIUS)
    const sag = ([width, height]: SphereSegments) =>
      (EARTH_RADIUS * (1 - Math.cos(0.5 * Math.hypot((2 * Math.PI) / width, Math.PI / height))) * 255) / TERRAIN_DISPLACEMENT

    it("stands on the base sphere's vertices where they share one, and on its triangles between", () => {
      const [width, height] = LIMB_SEGMENTS
      const [baseWidth, baseHeight] = EARTH_BASE_SEGMENTS
      const baseGrey = vertexGrey(ground4k, base)
      const at = new THREE.Vector3()
      let worstOff = 0
      for (let j = 1; j < height; j++) {
        for (let i = 0; i <= width; i++) {
          const k = j * (width + 1) + i
          const morphed = baseGroundGrey(ground4k, EARTH_BASE_SEGMENTS, limb.uv[2 * k], limb.uv[2 * k + 1])
          const shared = (i * baseWidth) % width === 0 && (j * baseHeight) % height === 0
          if (shared) {
            const b = ((j * baseHeight) / height) * (baseWidth + 1) + (i * baseWidth) / width
            expect(morphed).toBeCloseTo(baseGrey[b], 3)
          }
          // Against where a ray meets the base mesh's flat triangles (the
          // vertex's own sphere sits on the curve, the flat face under it).
          at.fromArray(limb.unit, 3 * k).normalize()
          const drawn = ((meshRadius(baseMesh, EARTH_BASE_SEGMENTS, at) - EARTH_RADIUS) * 255) / TERRAIN_DISPLACEMENT
          worstOff = Math.max(worstOff, Math.abs(morphed - drawn))
        }
      }
      // The 128 × 128 sphere's faces sag ~3.8 levels (~100 m).
      expect(worstOff).toBeLessThan(sag(EARTH_BASE_SEGMENTS) + TERRAIN_GREY_MARGIN)
    })

    it.each([
      ['Everest', 27.988, 86.925],
      ['K2', 35.881, 76.513],
      ['Aconcagua', -32.653, -70.011],
    ])("keeps %s's top across the swap", (_, lat, lon) => {
      const limbMorphed = new Float32Array(limb.uv.length / 2)
      for (let k = 0; k < limbMorphed.length; k++) {
        limbMorphed[k] = baseGroundGrey(ground4k, EARTH_BASE_SEGMENTS, limb.uv[2 * k], limb.uv[2 * k + 1])
      }
      const limbMesh = displace(limb, limbMorphed, EARTH_RADIUS)
      let before = 0
      let after = 0
      for (let a = -0.7; a <= 0.7; a += 0.05) {
        for (let b = -0.7; b <= 0.7; b += 0.05) {
          const at = latLonToLocal(lat + a, lon + b)
          before = Math.max(before, meshRadius(baseMesh, EARTH_BASE_SEGMENTS, at))
          after = Math.max(after, meshRadius(limbMesh, LIMB_SEGMENTS, at))
        }
      }
      // Up by at most the base faces' sag (the limb sphere's vertices sit on
      // the curve), where without the morph the swap moved them by up to
      // ~1 km (Aconcagua 2110 -> 3119 m, filtered; 3633 -> 4575 m before).
      expect(after).toBeGreaterThanOrEqual(before - 1e-9)
      expect(((after - before) * 255) / TERRAIN_DISPLACEMENT).toBeLessThan(sag(EARTH_BASE_SEGMENTS))
    })
  })

  describe('groundMorph', () => {
    const swapAt = (screenPx: number) => {
      // The eye distance where the base sphere's facets pass LIMB_FACET_PX.
      let lo = 1.0001
      let hi = 100
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2
        if (limbFacetPx(EARTH_BASE_SEGMENTS, mid, screenPx, SHIP_FOV) > LIMB_FACET_PX) lo = mid
        else hi = mid
      }
      return lo * EARTH_RADIUS
    }
    const morph = (distance: number, screenPx: number) =>
      groundMorph(EARTH_BASE_SEGMENTS, distance, EARTH_RADIUS, screenPx, SHIP_FOV)

    it('is 1 at the swap, past its hysteresis, and falls to 0 on the way down', () => {
      for (const screenPx of [720, 1170, 1600, 2160]) {
        const swap = swapAt(screenPx)
        expect(morph(swap, screenPx)).toBe(1)
        expect(morph(EARTH_RADIUS + (swap - EARTH_RADIUS) / 1.05, screenPx)).toBe(1)
        let previous = 1
        for (let distance = swap; distance > EARTH_RADIUS; distance -= 0.001) {
          const m = morph(distance, screenPx)
          expect(m).toBeLessThanOrEqual(previous)
          previous = m
        }
        expect(previous).toBe(0)
      }
      expect(MORPH_START_PX).toBeGreaterThan(LIMB_FACET_PX)
    })

    it('is over by MORPH_END_PX', () => {
      for (const distance of [1.01, 1.02, 1.05].map((r) => r * EARTH_RADIUS)) {
        const screenPx = MORPH_END_PX / limbFacetPx(EARTH_BASE_SEGMENTS, distance / EARTH_RADIUS, 1, SHIP_FOV)
        if (distance - EARTH_RADIUS > 2 * MORPH_FLOOR) expect(morph(distance, screenPx)).toBe(0)
        expect(morph(distance, screenPx * 1.01)).toBe(0)
      }
    })

    it("is over above every stop on the limb sphere's floor, on any screen", () => {
      const floor = buildTerrainFloor(meanGrey(demMean), LIMB_SEGMENTS)
      const highest = floor.grey.reduce((a, b) => Math.max(a, b), 0) + TERRAIN_GREY_MARGIN
      const stop = (TERRAIN_DISPLACEMENT * highest) / 255 + EARTH_GROUND_CLEARANCE
      expect(stop).toBeLessThan(MORPH_FLOOR)
      for (const screenPx of [200, 400, 720, 1600, 4320]) {
        expect(morph(EARTH_RADIUS + MORPH_FLOOR, screenPx)).toBe(0)
        expect(morph(EARTH_RADIUS + stop, screenPx)).toBe(0)
      }
    })
  })

  describe('patch', () => {
    function phongShader() {
      return {
        uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
        vertexShader: THREE.ShaderLib.phong.vertexShader,
        fragmentShader: THREE.ShaderLib.phong.fragmentShader,
      } as THREE.WebGLProgramParametersWithUniforms
    }

    it("replaces three's displacement read and holds its uniforms, after the rest of the ground's chain", () => {
      const eclipse = createEclipseShadow('earth')
      const clouds = createCloudLayer(eclipse, false)
      const displacement = createGroundDisplacement(EARTH_BASE_SEGMENTS)
      const patch = composePatches(composePatches(eclipse.material, clouds.groundPatch, groundDetailPatch(false)), displacement.patch)
      const shader = phongShader()
      patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
      const vert = shader.vertexShader
      expect(vert).not.toContain('#include <displacementmap_vertex>')
      expect(vert).not.toContain('texture2D( displacementMap')
      expect(vert).toContain('transformed += normalize(objectNormal) * (groundHeight(vDisplacementMapUv) * displacementScale + displacementBias);')
      expect(vert.indexOf('float groundHeight(vec2 uv)')).toBeLessThan(vert.indexOf('void main()'))
      expect(vert).toContain('#define GROUND_BASE vec2(128.0, 128.0)')
      expect(vert).toMatch(/#include <begin_vertex>\s+vGroundDetailPos = position;/)
      for (const name of ['uGroundHeights', 'uGroundLod', 'uGroundMorph'] as const) {
        expect(shader.uniforms[name]).toBe(displacement.uniforms[name])
      }
      expect(patch.customProgramCacheKey()).toContain('ground-displacement-128x128')
      clouds.dispose()
    })

    it('fails loudly on a shader without the displacement chunk', () => {
      const shader = { ...phongShader(), vertexShader: 'void main() {}' }
      expect(() => createGroundDisplacement(EARTH_BASE_SEGMENTS).patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)).toThrow()
    })
  })
})
