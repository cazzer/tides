import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { TERRAIN_DISPLACEMENT } from '../cloud-layer'
import { latLonToLocal } from '../aurora'
import { DEM_METRES_PER_UNIT, boxMips, decodeEarthDem, demLevel, toHalfBits } from '../earth-dem'
import {
  LIMB_FACET_PX,
  LIMB_HYSTERESIS,
  LIMB_SEGMENTS,
  clearLimbView,
  limbFacetPx,
  updateLimbView,
  wantsLimbSphere,
  type SphereSegments,
} from '../ship/limb-detail'
import { EARTH_FLOOR_REACH, EARTH_GROUND_CLEARANCE, EARTH_RADIUS } from '../ship/ship-bodies'
import { SHIP_FOV } from '../ship/ship-session'
import {
  EARTH_BASE_SEGMENTS,
  TERRAIN_GREY_MARGIN,
  buildTerrainFloor,
  meanGrey,
  terrainFloorGreyAround,
} from '../ship/terrain-floor'
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
import {
  EARTH_LIMB_SWAP_FLOOR,
  MORPH_END_PX,
  MORPH_FLOOR,
  MORPH_START_PX,
  MORPH_TOP,
  createGroundDisplacement,
  groundLod,
  groundMorph,
} from './groundDisplacement'
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

  describe('groundMorph and the swap', () => {
    const morph = (distance: number, screenPx: number) =>
      groundMorph(EARTH_BASE_SEGMENTS, distance, EARTH_RADIUS, screenPx, SHIP_FOV)
    // The highest stop on either sphere's floor: around the near plane's
    // reach, over the Karakoram and the Himalaya, where both floors peak.
    const floors = [EARTH_BASE_SEGMENTS, LIMB_SEGMENTS].map((segments) => buildTerrainFloor(meanGrey(demMean), segments))
    let highestStop = 0
    for (const floor of floors) {
      let top = 0
      for (let lat = 25; lat <= 45; lat += 0.1) {
        for (let lon = 65; lon <= 100; lon += 0.1) {
          top = Math.max(top, terrainFloorGreyAround(floor, latLonToLocal(lat, lon), EARTH_FLOOR_REACH / EARTH_RADIUS))
        }
      }
      // That is where its highest vertex is.
      expect(top).toBeGreaterThanOrEqual(floor.grey.reduce((a, b) => Math.max(a, b), 0) + TERRAIN_GREY_MARGIN)
      highestStop = Math.max(highestStop, (TERRAIN_DISPLACEMENT * top) / 255 + EARTH_GROUND_CLEARANCE)
    }
    // A descent straight down at 0.1% of the gap a frame: where Earth's ground
    // first wants the limb sphere (EarthRenderer's swap floor), through the
    // limb view's hysteresis.
    const swapGap = (screenPx: number) => {
      const earth = { key: 'earth', position: new THREE.Vector3(), radius: EARTH_RADIUS }
      try {
        for (let gap = 3 * EARTH_RADIUS; gap > 0.001; gap *= 0.999) {
          updateLimbView('earth', [earth], new THREE.Vector3(EARTH_RADIUS + gap, 0, 0), screenPx, SHIP_FOV)
          if (wantsLimbSphere('earth', EARTH_RADIUS, EARTH_BASE_SEGMENTS, EARTH_LIMB_SWAP_FLOOR)) return gap
        }
        return 0
      } finally {
        clearLimbView()
      }
    }

    it('swaps well above the highest stop on any screen, so the floor never changes under the ship', () => {
      // ~0.066 over the Karakoram, under the morph's floor.
      expect(highestStop).toBeLessThan(MORPH_FLOOR)
      for (const screenPx of [100, 200, 275, 300, 400, 450, 720, 1600]) {
        expect(swapGap(screenPx), String(screenPx)).toBeGreaterThan(MORPH_TOP)
      }
    })

    it('is 1 at the swap on any screen, and falls to 0 on the way down', () => {
      for (const screenPx of [100, 300, 400, 450, 500, 600, 720, 1170, 1600, 2160]) {
        const swap = EARTH_RADIUS + swapGap(screenPx)
        expect(morph(swap, screenPx), String(screenPx)).toBe(1)
        let previous = 1
        for (let distance = swap; distance > EARTH_RADIUS; distance -= 0.001) {
          const m = morph(distance, screenPx)
          expect(m).toBeLessThanOrEqual(previous)
          previous = m
        }
        expect(previous).toBe(0)
      }
      expect(MORPH_START_PX).toBeGreaterThan(LIMB_FACET_PX * LIMB_HYSTERESIS)
    })

    it('is over by MORPH_END_PX', () => {
      for (const distance of [1.01, 1.02, 1.05].map((r) => r * EARTH_RADIUS)) {
        const screenPx = MORPH_END_PX / limbFacetPx(EARTH_BASE_SEGMENTS, distance / EARTH_RADIUS, 1, SHIP_FOV)
        expect(morph(distance, screenPx * 1.01)).toBe(0)
      }
    })

    it('is over above every stop on either floor, on any screen', () => {
      for (const screenPx of [100, 200, 400, 720, 1600, 4320]) {
        expect(morph(EARTH_RADIUS + MORPH_FLOOR, screenPx)).toBe(0)
        expect(morph(EARTH_RADIUS + highestStop, screenPx)).toBe(0)
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
      expect(vert).not.toContain('textureSize(')
      for (const name of ['uGroundHeights', 'uGroundLod', 'uGroundBaseLod', 'uGroundMorph'] as const) {
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
