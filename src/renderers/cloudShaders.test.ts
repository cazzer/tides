import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { createCloudLayer, MARCH_STEP, MARCH_STEPS } from './cloudShaders'
import {
  CLOUD_CLEARANCE,
  CLOUD_LAYER_TOP,
  CLOUD_MIN_ALPHA,
  cloudPathClear,
  columnDepth,
  marchCrossing,
  marchSpanFromEye,
} from '../cloud-layer'
import { sceneRadius } from '../planets'
import { clearLimbView, updateLimbView } from '../ship/limb-detail'

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

  it('carries a ray that skims over the sea on, up under the deck', () => {
    const eye: [number, number, number] = [0, sea + 0.004, 0]
    // Level: below the lowest base, then up under the bases beyond.
    const level = marchSpanFromEye(eye, [1, 0, 0], sea, outer, 0.001)!
    expect(level.end).toBeCloseTo(Math.sqrt(outer ** 2 - (sea + 0.004) ** 2), 9)
    // Down toward the sea: nothing past the lowest base (or from below it,
    // the sea) but the ground.
    const a = (-30 * Math.PI) / 180
    const dir: [number, number, number] = [Math.cos(a), Math.sin(a), 0]
    // Where a ray from (0, r, 0) along dir meets the sphere of radius to.
    const meets = (r: number, to: number) => {
      const b = r * dir[1]
      return -b - Math.sqrt(b * b - (r * r - to * to))
    }
    expect(marchSpanFromEye(eye, dir, sea, outer, 0.001)!.end).toBeCloseTo(meets(sea + 0.004, sea), 9)
    const high = marchSpanFromEye([0, sea + 0.05, 0], dir, sea, outer, 0.001)!
    expect(high.end).toBeCloseTo(meets(sea + 0.05, sea + CLOUD_CLEARANCE), 9)
    // Up from below the deck: the sea behind the eye ends nothing.
    const up = marchSpanFromEye(eye, [Math.cos(a), -Math.sin(a), 0], sea, outer, 0.001)!
    const b = (sea + 0.004) * -Math.sin(a)
    expect(up.end).toBeCloseTo(-b + Math.sqrt(b * b - ((sea + 0.004) ** 2 - outer ** 2)), 9)
  })

  it('keeps every march from inside within the step budget', () => {
    // From the deck's bottom to above the shell. Rays that skim over the sea
    // from the shell's top stretch the clamped steps, by under 2%.
    let longest = 0
    for (let alt = 0.001; alt <= CLOUD_LAYER_TOP + 0.01; alt += 0.005) {
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
    expect(longest / MARCH_STEPS).toBeLessThanOrEqual(MARCH_STEP * 1.02)
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
        // Ship mode with Earth nearest.
        const earth = { key: 'earth', position: new THREE.Vector3(), radius: sea }
        updateLimbView('earth', [earth], new THREE.Vector3(0, sea + 0.1, 0), 800, 60)
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
        clearLimbView()
        versionAt(clouds.shellAltitude - 0.005)
        expect(clouds.material.side).toBe(THREE.FrontSide)
      } finally {
        clearLimbView()
        clouds.dispose()
      }
    })
  }
})

describe('cloud undersides and gaps from below the deck (tides-01v.8.5)', () => {
  const solid = 0.6
  const clear = 0.005
  // A column based at 0.006, its top at `top`, and a step at `alt` over it.
  const at = (alt: number, top: number, alpha: number) => ({ alt, base: 0.006, top, alpha })

  it('meets a top from above only where the cloud there shows', () => {
    const top = marchCrossing(at(0.024, 0.022, solid), at(0.02, 0.022, solid))
    expect(top).toEqual({ at: expect.closeTo(0.5, 9), side: false, depth: 0 })
    expect(marchCrossing(at(0.009, 0.0075, clear), at(0.0055 + 0.0015, 0.0075, clear))).toBeNull()
    expect(marchCrossing(at(0.026, 0.022, solid), at(0.024, 0.022, solid))).toBeNull()
  })

  it('meets tops as from outside from above the deck', () => {
    const faint = marchCrossing(at(0.009, 0.0075, clear), at(0.007, 0.0075, clear), true)
    expect(faint).toEqual({ at: expect.closeTo(0.75, 9), side: false, depth: 0 })
  })

  it('meets a base from below where the cloud shows, and passes up through a gap', () => {
    const below = at(0.003, 0.03, solid)
    expect(marchCrossing(below, at(0.007, 0.03, solid))).toEqual({
      at: expect.closeTo(0.75, 9),
      side: false,
      depth: 1,
    })
    expect(marchCrossing({ ...below, alpha: clear }, at(0.007, 0.0075, clear))).toBeNull()
    // A thin column crossed whole in one step still counts.
    expect(marchCrossing(below, at(0.014, 0.01, solid))!.at).toBeCloseTo(0.003 / 0.011, 9)
    expect(marchCrossing(below, at(0.005, 0.03, solid))).toBeNull()
  })

  it('meets a side from a gap within the deck', () => {
    const gap = at(0.007, 0.0075, 0)
    const hit = marchCrossing(gap, at(0.007, 0.03, 0.2))!
    expect(hit).toEqual({ at: expect.closeTo(CLOUD_MIN_ALPHA / 0.2, 9), side: true, depth: null })
    expect(marchCrossing(gap, at(0.007, 0.0075, clear))).toBeNull()
    // Within a cloud already, or leaving the deck, nothing new.
    expect(marchCrossing({ ...gap, top: 0.03, alpha: solid }, at(0.007, 0.03, solid))).toBeNull()
    expect(marchCrossing(gap, at(0.009, 0.0075, solid))).toBeNull()
  })

  it('takes a wall met from a gap above its faint top for a side', () => {
    // Mid-gap, over the faint top, stepping into a tall column beside it:
    // its top passed the ray's height, not the ray its top.
    const hit = marchCrossing(at(0.012, 0.0075, clear), at(0.012, 0.0216, solid))!
    expect(hit.side).toBe(true)
    expect(hit.depth).toBeNull()
    // From above the deck the same crossing is a top, as from outside.
    expect(marchCrossing(at(0.012, 0.0075, clear), at(0.012, 0.0216, solid), true)!.side).toBe(false)
  })

  it('meets a side past a faint top in the same step', () => {
    // Half way the cloud is still under CLOUD_MIN_ALPHA; past that, solid.
    const hit = marchCrossing(at(0.0085, 0.0075, 0), at(0.0065, 0.0075, 0.03))!
    const t = (CLOUD_MIN_ALPHA - 0.015) / (0.03 - 0.015)
    expect(hit).toEqual({ at: expect.closeTo(0.5 + 0.5 * t, 9), side: true, depth: null })
  })

  it('shades by how far down its column a hit lies', () => {
    expect(columnDepth(0.03, 0.01, 0.03)).toBe(0)
    expect(columnDepth(0.01, 0.01, 0.03)).toBe(1)
    expect(columnDepth(0.02, 0.01, 0.03)).toBeCloseTo(0.5, 9)
    expect(columnDepth(0.005, 0.01, 0.03)).toBe(1)
  })

  it('makes a side as opaque as the cloud seen across', () => {
    // Across its own thickness, a column's own opacity; further, more.
    expect(1 - cloudPathClear(0.4, 0.01, 0.01)).toBeCloseTo(0.4, 9)
    expect(1 - cloudPathClear(0.1, 0.002, 0.011)).toBeGreaterThan(0.4)
    expect(cloudPathClear(0, 0.01, 1)).toBe(1)
  })

  for (const variant of [[], ['CLOUD_FLAT'], ['FLIP_SIDED'], ['CLOUD_FLAT', 'FLIP_SIDED']]) {
    it(`declares what the program reads (${variant.join('+') || 'relief'})`, () => {
      // Without a WebGL context, a guard against names one branch defines
      // and the shared code reads.
      const clouds = createCloudLayer(createEclipseShadow('earth'), variant.includes('CLOUD_FLAT'))
      const src = preprocess(clouds.material.fragmentShader, new Set(variant))
      const names = ['colIn', 'side', 'sideClear', 'depthHit', 'fromAbove', 'depth', 'eye', 'shell']
      for (const name of names) {
        if (new RegExp(`\\b${name}\\b`).test(src.replace(/\/\/.*$/gm, ''))) {
          expect(src).toMatch(new RegExp(`(float|vec3|vec4|bool) ${name}\\b`))
        }
      }
      clouds.dispose()
    })
  }
})
