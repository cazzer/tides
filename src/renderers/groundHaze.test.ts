import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { createCloudLayer } from './cloudShaders'
import { groundDetailPatch } from './groundDetail'
import { createGroundHaze, GROUND_HAZE_E, groundHazeLength } from './groundHaze'
import { ATMOSPHERE_OUTER, pickShellFaces } from './earth-shells'
import { EARTH_GROUND_CLEARANCE } from '../ship/ship-bodies'

// The ship's camera is near Earth (limb-detail's view).
vi.mock('../ship/limb-detail', async (original) => ({
  ...(await original<typeof import('../ship/limb-detail')>()),
  limbBody: () => 'earth',
}))

const R = 3

function phongShader() {
  return {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
    vertexShader: THREE.ShaderLib.phong.vertexShader,
    fragmentShader: THREE.ShaderLib.phong.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms
}

function cameraAt(r: number): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.001, 100)
  camera.position.set(r, 0, 0)
  camera.updateMatrixWorld()
  return camera
}

describe('ground haze', () => {
  it("lays the haze over the ground's output, its macros gone before the cloud patch's uSeaLevel", () => {
    const eclipse = createEclipseShadow('earth')
    const clouds = createCloudLayer(eclipse, false)
    const haze = createGroundHaze(clouds.uniforms.uSunDir, R)
    const shader = phongShader()
    composePatches(eclipse.material, clouds.groundPatch, groundDetailPatch(false), haze.patch).onBeforeCompile(
      shader,
      {} as THREE.WebGLRenderer
    )
    const frag = shader.fragmentShader
    const at = (s: string) => {
      expect(frag).toContain(s)
      return frag.indexOf(s)
    }
    expect(at('#undef uSeaLevel')).toBeLessThan(at('uniform float uSeaLevel;'))
    expect(at('float columnAheadOverSea(')).toBeLessThan(at('#undef uSeaLevel'))
    expect(frag).toMatch(/#include <colorspace_fragment>\s+if \(uGroundHaze > 0\.0\)/)
    expect(at('#include <opaque_fragment>')).toBeLessThan(at('if (uGroundHaze > 0.0)'))
    expect(shader.vertexShader).toMatch(/#include <project_vertex>\s+vGroundHazeRay =/)
    expect(shader.uniforms.uGroundHazeSun).toBe(clouds.uniforms.uSunDir)
    clouds.dispose()
  })

  it('reaches 95% of the haze at the nearest sea horizon, from the stop over the sea', () => {
    const horizon = Math.sqrt(2 * R * EARTH_GROUND_CLEARANCE)
    expect(horizon / (groundHazeLength(R) * R)).toBeCloseTo(GROUND_HAZE_E)
    expect(1 - Math.exp(-GROUND_HAZE_E)).toBeCloseTo(0.95, 2)
  })

  it("takes over from the atmosphere only for the ship's camera inside its shell", () => {
    const haze = createGroundHaze({ value: new THREE.Vector3(1, 0, 0) }, R)
    const shader = phongShader()
    haze.patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
    const ground = new THREE.Mesh(new THREE.SphereGeometry(R))
    const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(R * ATMOSPHERE_OUTER))
    const material = new THREE.ShaderMaterial({ uniforms: { uOuter: { value: R * ATMOSPHERE_OUTER } } })

    for (const [r, inside] of [
      [R * 1.002, true],
      [R * (ATMOSPHERE_OUTER - 0.001), true],
      [R * (ATMOSPHERE_OUTER + 0.001), false],
      [R * 2, false],
    ] as const) {
      const camera = cameraAt(r)
      haze.update(ground, camera)
      expect(shader.uniforms.uGroundHaze.value).toBe(inside ? 1 : 0)
      // The atmosphere stops at the ground exactly where the ground hazes
      // itself; elsewhere its back faces, if drawn, skip the depth test.
      pickShellFaces(atmosphere, material, camera, true)
      const reach = material.side === THREE.DoubleSide
      expect(material.depthTest).toBe(!reach || inside)
      pickShellFaces(atmosphere, material, camera)
      expect(material.depthTest).toBe(!reach)
    }

    const ortho = new THREE.OrthographicCamera()
    ortho.position.set(R * 1.002, 0, 0)
    ortho.updateMatrixWorld()
    haze.update(ground, ortho)
    expect(shader.uniforms.uGroundHaze.value).toBe(0)
  })
})
