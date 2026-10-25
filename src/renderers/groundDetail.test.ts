import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { createCloudLayer } from './cloudShaders'
import { GROUND_DETAIL_OCTAVES, GROUND_DETAIL_OCTAVES_LOW, groundDetailPatch } from './groundDetail'
import { nightLightsPatch } from './nightLights'
import { poleSmoothingPatch } from './poleSmoothing'
import { RELIEF_DETAIL, RELIEF_MAX_SLOPE } from './groundRelief'
import { LIMB_SEGMENTS } from '../ship/limb-detail'
import { EARTH_RADIUS } from '../ship/ship-bodies'
import { meshGrid, riseOverRun, shadedSlope, vertexSurface } from '../ship/ground-mesh-model'

function phongShader() {
  return {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
    vertexShader: THREE.ShaderLib.phong.vertexShader,
    fragmentShader: THREE.ShaderLib.phong.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms
}

describe('ground detail patch', () => {
  it("joins the ground's chain after the albedo, mask and normal, before the emissive and lights", () => {
    const eclipse = createEclipseShadow('earth')
    const clouds = createCloudLayer(eclipse, false)
    const patch = composePatches(
      eclipse.material,
      clouds.groundPatch,
      nightLightsPatch(clouds.uniforms.uSunDir),
      poleSmoothingPatch(),
      groundDetailPatch(false)
    )
    const shader = phongShader()
    patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)

    const frag = shader.fragmentShader
    const at = (s: string) => {
      expect(frag).toContain(s)
      return frag.indexOf(s)
    }
    const detail = at('vec4 detail = groundDetail(')
    expect(at('sampledDiffuseColor = poleSmoothed(')).toBeLessThan(detail)
    expect(at('#include <specularmap_fragment>')).toBeLessThan(detail)
    expect(at('#include <normal_fragment_maps>')).toBeLessThan(detail)
    expect(detail).toBeLessThan(at('#include <emissivemap_fragment>'))
    expect(detail).toBeLessThan(at('#include <lights_fragment_begin>'))
    expect(shader.vertexShader).toMatch(/#include <begin_vertex>\s+vGroundDetailPos = position;/)
    expect(at('float groundDetailTexel =')).toBeLessThan(detail)
    // The noise is defined once across the composed chain.
    expect(frag.split('vec4 detailNoise(vec3 p)')).toHaveLength(2)
    // The skylight's up is the normal before any tilt; it is lit with the
    // sunlight, which the cloud shadow and eclipse then dim.
    const sky = at('reflectedLight.directDiffuse = (1.0 - GROUND_SKY_FILL)')
    expect(at('vec3 groundUp = normal;')).toBeLessThan(at('groundLand > 0.0'))
    expect(at('#include <lights_fragment_end>')).toBeLessThan(sky)
    expect(sky).toBeLessThan(at('reflectedLight.directDiffuse *= cloudLit;'))
    expect(sky).toBeLessThan(at('reflectedLight.directDiffuse *= vec3(eclipse.x) + glow;'))
    // Wherever the skylight compiles, groundUp is declared.
    expect(frag).toContain('#if defined(USE_MAP) && defined(USE_SPECULARMAP)\nvec3 groundUp = normal;')
    expect(frag).toContain('#if defined(USE_MAP) && defined(USE_SPECULARMAP) && NUM_DIR_LIGHTS > 0\n{\n  float groundSunUp')
    clouds.dispose()
  })

  it("tilts the land by the ground's slope before the detail's own tilt", () => {
    const displaced = { ...phongShader(), displacementMap: true }
    const flat = phongShader()
    groundDetailPatch(false).onBeforeCompile(displaced, {} as THREE.WebGLRenderer)
    groundDetailPatch(false).onBeforeCompile(flat, {} as THREE.WebGLRenderer)
    const frag = displaced.fragmentShader
    const relief = frag.indexOf('groundSlope(vMapUv, vGroundDetailPos, groundFootprint, groundMeshSlope)')
    expect(frag).toContain('#define GROUND_RELIEF\n')
    expect(frag.indexOf('#include <normal_fragment_maps>')).toBeLessThan(relief)
    expect(frag.indexOf('float groundFootprint =')).toBeLessThan(relief)
    expect(relief).toBeLessThan(frag.indexOf('vec4 detail = groundDetail('))
    // Without the displacement patch's slope (tides-zmw.3), just the map's detail.
    expect(frag).toMatch(/#ifdef GROUND_MESH_SLOPE\s+vec3 groundMeshSlope = vGroundSlope;\s+#else\s+vec3 groundMeshSlope = vec3\(0\.0\);/)
    expect(flat.fragmentShader).not.toContain('#define GROUND_RELIEF')
    expect(flat.fragmentShader).not.toContain('uniform sampler2D displacementMap;')
    // The blend ground-mesh-model.ts shadedSlope() mirrors: a change to one side fails here.
    for (const line of [
      `#define GROUND_RELIEF_DETAIL ${RELIEF_DETAIL.toFixed(6)}`,
      'if (fade <= 0.0) return mesh;',
      'vec3 detail = GROUND_RELIEF_DETAIL * (groundRelief(uv, lat, p, max(footprint, texel), texel, width) - mesh);',
      'float s = length(detail);',
      `return mesh + fade * detail / sqrt(1.0 + s * s / ${(RELIEF_MAX_SLOPE * RELIEF_MAX_SLOPE).toFixed(6)});`,
      'return displacementScale * (east * e + north * cross(n, e)) / (2.0 * run);',
    ]) {
      expect(frag).toContain(line)
    }
  })

  describe("the ground's shaded slope (tides-zmw.3)", () => {
    const mesh = [0.2, -0.1, 0.3]

    it("is the drawn mesh's where the detail fades out, or where the map agrees with it", () => {
      expect(shadedSlope(mesh, [5, 5, 5], 0)).toEqual(mesh)
      expect(shadedSlope(mesh, mesh, 1)).toEqual(mesh)
    })

    it('adds a share of the finer relief about it, softly capped', () => {
      const fine = [0.3, -0.1, 0.3]
      expect(shadedSlope(mesh, fine, 1)[0]).toBeCloseTo(0.2 + (RELIEF_DETAIL * 0.1) / Math.sqrt(1 + (RELIEF_DETAIL * 0.1) ** 2), 9)
      expect(shadedSlope(mesh, fine, 0.5)[0]).toBeCloseTo(0.2 + (0.5 * RELIEF_DETAIL * 0.1) / Math.sqrt(1 + (RELIEF_DETAIL * 0.1) ** 2), 9)
      // A cliff in the map: the detail tends to RELIEF_MAX_SLOPE.
      const off = shadedSlope(mesh, [1000, -0.1, 0.3], 1)[0] - mesh[0]
      expect(off).toBeLessThan(RELIEF_MAX_SLOPE)
      expect(off).toBeGreaterThan(0.99 * RELIEF_MAX_SLOPE)
    })

    it('lights a ridge at the terminator on its sunward face only', () => {
      // A north-south ridge on the limb sphere's ground at 0° E, 50 grey
      // levels (~1.3 km) a vertex up to 200, under a Sun 5° over the west.
      const [width, height] = LIMB_SEGMENTS
      const data = new Float32Array(width * height)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) data[y * width + x] = Math.max(0, 200 - 50 * Math.abs(x + 0.5 - width / 2))
      }
      const levels = [{ width, height, data }]
      const grid = meshGrid(LIMB_SEGMENTS)
      const surface = vertexSurface(levels, grid)
      const up = new THREE.Vector3(1, 0, 0)
      const west = new THREE.Vector3(0, 0, 1)
      const sun = west.clone().multiplyScalar(Math.cos(THREE.MathUtils.degToRad(5))).addScaledVector(up, Math.sin(THREE.MathUtils.degToRad(5)))
      const equator = (height / 2) * (width + 1)
      const lit = (i: number, fine: (slope: number[]) => number[]) => {
        const k = equator + i
        expect(new THREE.Vector3().fromArray(grid.unit, 3 * k).distanceTo(up)).toBeLessThan(0.05)
        const slope = riseOverRun(surface.subarray(4 * k + 1, 4 * k + 4), EARTH_RADIUS)
        const shaded = shadedSlope(slope, fine(slope), 1)
        return up.clone().sub(new THREE.Vector3(...shaded)).normalize().dot(sun)
      }
      // With the map as the mesh, and twice as steep.
      for (const fine of [(s: number[]) => s, (s: number[]) => s.map((x) => 2 * x)]) {
        for (const i of [width / 2 - 3, width / 2 - 2, width / 2 - 1]) expect(lit(i, fine)).toBeGreaterThan(0.3)
        for (const i of [width / 2 + 1, width / 2 + 2, width / 2 + 3]) expect(lit(i, fine)).toBeLessThan(0)
      }
    })
  })

  it('takes fewer octaves on the low tier, with its own program', () => {
    const high = phongShader()
    const low = phongShader()
    groundDetailPatch(false).onBeforeCompile(high, {} as THREE.WebGLRenderer)
    groundDetailPatch(true).onBeforeCompile(low, {} as THREE.WebGLRenderer)
    expect(high.fragmentShader).toContain(`#define GROUND_DETAIL_OCTAVES ${GROUND_DETAIL_OCTAVES}\n`)
    expect(low.fragmentShader).toContain(`#define GROUND_DETAIL_OCTAVES ${GROUND_DETAIL_OCTAVES_LOW}\n`)
    expect(GROUND_DETAIL_OCTAVES_LOW).toBeLessThan(GROUND_DETAIL_OCTAVES)
    expect(groundDetailPatch(true).customProgramCacheKey()).not.toBe(
      groundDetailPatch(false).customProgramCacheKey()
    )
  })
})
