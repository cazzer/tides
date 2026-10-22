import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { createCloudLayer, MARCH_STEP, MARCH_STEPS } from './cloudShaders'
import {
  CLOUD_CLEARANCE,
  CLOUD_FLAT_ALTITUDE,
  CLOUD_LAYER_TOP,
  marchSpanFromEye,
} from '../cloud-layer'
import { sceneRadius } from '../planets'
import { setLimbBody } from '../ship/limb-detail'

function phongShader() {
  return {
    uniforms: THREE.UniformsUtils.clone(THREE.ShaderLib.phong.uniforms),
    vertexShader: THREE.ShaderLib.phong.vertexShader,
    fragmentShader: THREE.ShaderLib.phong.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms
}

describe('cloud layer materials', () => {
  for (const flat of [false, true]) {
    it(`patches the ground alongside the eclipse shadow (${flat ? 'flat' : 'relief'})`, () => {
      const eclipse = createEclipseShadow('earth')
      const clouds = createCloudLayer(eclipse, flat)
      const patch = composePatches(eclipse.material, clouds.groundPatch)
      const shader = phongShader()
      patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)

      expect(shader.fragmentShader).toContain('if (uEclipseActive')
      expect(shader.fragmentShader).toContain('cloudGroundShadow(normalize(vCloudGround))')
      expect(/#define CLOUD_FLAT\n/.test(shader.fragmentShader)).toBe(flat)
      expect(shader.vertexShader).toMatch(/#include <begin_vertex>\s+vCloudGround = position;/)
      // Both patches' uniforms, shared by reference with the cloud shell.
      expect(shader.uniforms.uEclipseActive).toBe(eclipse.uniforms.uEclipseActive)
      expect(shader.uniforms.uSunDir).toBe(clouds.uniforms.uSunDir)
      expect(clouds.material.uniforms.uSunDir).toBe(clouds.uniforms.uSunDir)
      expect(clouds.material.uniforms.uEclipseActive).toBe(eclipse.uniforms.uEclipseActive)
      expect(patch.customProgramCacheKey()).toBe(
        `eclipse-shadow+${flat ? 'cloud-shadow-flat' : 'cloud-shadow'}`
      )
      clouds.dispose()
    })
  }

  it('sits the relief shell above the flat one', () => {
    const eclipse = createEclipseShadow('earth')
    const relief = createCloudLayer(eclipse, false)
    const flat = createCloudLayer(eclipse, true)
    expect(relief.shellAltitude).toBeGreaterThan(flat.shellAltitude)
    expect(flat.material.defines).toHaveProperty('CLOUD_FLAT')
    expect(relief.material.defines).not.toHaveProperty('CLOUD_FLAT')
  })
})

// A minimal preprocessor for the shader's own conditionals: the program three
// builds for `defines`.
function preprocess(source: string, defines: Set<string>): string {
  const stack: { active: boolean; taken: boolean }[] = []
  const holds = (expr: string) =>
    expr.split('&&').every((term) => defines.has(term.match(/defined\((\w+)\)/)![1]))
  const lines: string[] = []
  for (const line of source.split('\n')) {
    const t = line.trim()
    let m: RegExpMatchArray | null
    if ((m = t.match(/^#ifdef (\w+)/)))
      stack.push({ active: defines.has(m[1]), taken: defines.has(m[1]) })
    else if ((m = t.match(/^#if (.*)/))) stack.push({ active: holds(m[1]), taken: holds(m[1]) })
    else if ((m = t.match(/^#elif (.*)/))) {
      const top = stack[stack.length - 1]
      top.active = !top.taken && holds(m[1])
      top.taken ||= top.active
    } else if (t.startsWith('#else')) {
      const top = stack[stack.length - 1]
      top.active = !top.taken
      top.taken = true
    } else if (t.startsWith('#endif')) stack.pop()
    else if (stack.every((frame) => frame.active)) lines.push(line)
  }
  return lines.join('\n')
}

describe('cloud march from inside the shell (tides-01v.8.4)', () => {
  const sea = sceneRadius(12742000)
  const outer = sea + CLOUD_LAYER_TOP

  it('starts at the near plane inside the shell and at the shell outside it', () => {
    const near = 0.002
    const inside = marchSpanFromEye([0, sea + 0.11, 0], [1, 0, 0], sea, outer, near)!
    expect(inside.start).toBe(near)
    expect(inside.end).toBeCloseTo(Math.sqrt(outer ** 2 - (sea + 0.11) ** 2), 9)
    const down = marchSpanFromEye([0, sea + 0.11, 0], [0, -1, 0], sea, outer, near)!
    expect(down.end).toBeCloseTo(0.11 - CLOUD_CLEARANCE, 9)
    const outside = marchSpanFromEye([0, sea + 0.3, 0], [0, -1, 0], sea, outer, near)!
    expect(outside.start).toBeCloseTo(0.3 - CLOUD_LAYER_TOP, 9)
    expect(marchSpanFromEye([0, sea + 0.3, 0], [0, 1, 0], sea, outer, near)).toBeNull()
  })

  it('keeps every march from inside within the step budget', () => {
    // Eyes above the low deck; from below it (tides-01v.8.5) a ray can pass
    // through the globe, which the shader's step clamp and the depth test
    // cover.
    let longest = 0
    for (let alt = CLOUD_FLAT_ALTITUDE; alt <= CLOUD_LAYER_TOP + 0.01; alt += 0.005) {
      for (let deg = -90; deg <= 90; deg += 0.5) {
        const a = (deg * Math.PI) / 180
        const span = marchSpanFromEye(
          [0, sea + alt, 0],
          [Math.cos(a), Math.sin(a), 0],
          sea,
          outer,
          0.001
        )
        if (span) longest = Math.max(longest, span.end - span.start)
      }
    }
    expect(longest / MARCH_STEP).toBeLessThanOrEqual(MARCH_STEPS)
  })

  for (const flat of [false, true]) {
    it(`leaves the outside program as it was (${flat ? 'flat' : 'relief'})`, () => {
      const clouds = createCloudLayer(createEclipseShadow('earth'), flat)
      const defines = new Set(flat ? ['CLOUD_FLAT'] : [])
      const { vertexShader, fragmentShader } = clouds.material
      for (const name of ['gl_FragDepth', 'vEye', 'sNear']) {
        expect(preprocess(fragmentShader, defines)).not.toContain(name)
        expect(preprocess(fragmentShader, new Set([...defines, 'FLIP_SIDED']))).toContain(name)
      }
      expect(preprocess(vertexShader, defines)).toContain('projectionMatrix * viewMatrix * world')
      clouds.dispose()
    })

    it(`draws back faces only within the ship camera's reach (${flat ? 'flat' : 'relief'})`, () => {
      const clouds = createCloudLayer(createEclipseShadow('earth'), flat)
      clouds.uniforms.uSeaLevel.value = sea
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), clouds.material)
      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.001, 100)
      const render = (cam: THREE.Camera) =>
        clouds.material.onBeforeRender(
          {} as THREE.WebGLRenderer,
          new THREE.Scene(),
          cam,
          mesh.geometry,
          mesh,
          null
        )
      const versionAt = (altitude: number) => {
        camera.position.set(0, sea + altitude, 0)
        camera.updateMatrixWorld()
        render(camera)
        return clouds.material.version
      }
      try {
        setLimbBody('earth')
        const v0 = versionAt(clouds.shellAltitude - 0.005)
        expect(clouds.material.side).toBe(THREE.BackSide)
        expect(clouds.material.depthTest).toBe(true)
        expect(versionAt(clouds.shellAltitude - 0.006)).toBe(v0)
        versionAt(clouds.shellAltitude + 0.1)
        expect(clouds.material.side).toBe(THREE.FrontSide)
        // Other views' cameras (the main view's orthographic one, or any
        // camera outside ship mode) keep the front faces.
        const ortho = new THREE.OrthographicCamera()
        ortho.position.set(0, sea, 0)
        ortho.updateMatrixWorld()
        render(ortho)
        expect(clouds.material.side).toBe(THREE.FrontSide)
        setLimbBody(null)
        versionAt(clouds.shellAltitude - 0.005)
        expect(clouds.material.side).toBe(THREE.FrontSide)
      } finally {
        setLimbBody(null)
        clouds.dispose()
      }
    })
  }
})
