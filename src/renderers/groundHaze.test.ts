import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { createCloudLayer } from './cloudShaders'
import { groundDetailPatch } from './groundDetail'
import { createGroundHaze, GROUND_HAZE_E, groundHazeWeights } from './groundHaze'
import { ATMOSPHERE_OUTER, groundHazeTop, pickShellFaces } from './earth-shells'
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
    const haze = createGroundHaze(clouds.uniforms.uSunDir, R, false)
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

  it('hands over at the cloud shell\'s top, where the clouds ease to adding all the haze', () => {
    for (const flat of [false, true]) {
      const clouds = createCloudLayer(createEclipseShadow('earth'), flat)
      expect(groundHazeTop(flat)).toBe(clouds.shellAltitude)
      clouds.dispose()
    }
  })

  it('clears near ground, keeps the far sea horizon, and adds all the haze at the shell top', () => {
    const horizon = Math.sqrt(2 * R * EARTH_GROUND_CLEARANCE)
    const top = R + groundHazeTop(false)
    const stop = R + EARTH_GROUND_CLEARANCE
    // A level ray's column from the base is half the grazing line's.
    const near = groundHazeWeights(stop, 0.002, 0.5, R, false)
    expect(near.cover).toBeLessThan(0.05)
    expect(near.haze).toBeLessThan(0.05)
    const sea = groundHazeWeights(stop, horizon, 0.5, R, false)
    expect(sea.haze).toBeCloseTo(1 - Math.exp(-GROUND_HAZE_E), 6)
    expect(sea.cover).toBeCloseTo(sea.haze, 6)
    // A steep ray's faint haze hides little of the ground.
    expect(groundHazeWeights(stop, horizon, 0.05, R, false).cover).toBeCloseTo(0.1 * sea.haze, 6)
    // At the shell's top: none of the ground hidden, all of the haze added.
    for (const eye of [top, top - 1e-9]) {
      const w = groundHazeWeights(eye, 0.002, 0.5, R, false)
      expect(w.cover).toBeCloseTo(0, 6)
      expect(w.haze).toBeCloseTo(1, 6)
    }
  })

  it("takes over from the atmosphere only for the ship's camera under the cloud shell's top", () => {
    const haze = createGroundHaze({ value: new THREE.Vector3(1, 0, 0) }, R, false)
    const shader = phongShader()
    haze.patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
    const ground = new THREE.Mesh(new THREE.SphereGeometry(R))
    const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(R * ATMOSPHERE_OUTER))
    const material = new THREE.ShaderMaterial({ uniforms: { uOuter: { value: R * ATMOSPHERE_OUTER } } })
    const top = R + groundHazeTop(false)
    expect(top).toBeLessThan(R * ATMOSPHERE_OUTER)

    for (const [r, under] of [
      [R * 1.002, true],
      [top - 1e-6, true],
      [top + 1e-6, false],
      [R * (ATMOSPHERE_OUTER - 0.001), false],
      [R * (ATMOSPHERE_OUTER + 0.001), false],
      [R * 2, false],
    ] as const) {
      const camera = cameraAt(r)
      haze.update(ground, camera)
      expect(shader.uniforms.uGroundHaze.value).toBe(under ? 1 : 0)
      // The atmosphere stops at the ground exactly where the ground hazes
      // itself; elsewhere its back faces, if drawn, skip the depth test.
      pickShellFaces(atmosphere, material, camera, top)
      const reach = material.side === THREE.DoubleSide
      expect(reach).toBe(r < R * ATMOSPHERE_OUTER)
      expect(material.depthTest).toBe(!reach || under)
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
