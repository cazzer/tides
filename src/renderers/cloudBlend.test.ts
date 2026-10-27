import * as THREE from 'three'
import { describe, expect, test } from 'vitest'
import {
  createCloudBlender,
  FADE_MS,
  neutralTypeTexture,
  outputFlags,
  planBlendPass,
  typesOf,
  type BlendPassState,
} from './cloudBlend'
import { CLOUD_TYPED_TOP_GLSL, TYPED_CODE_GLSL } from './cloudTypeGlsl'
import {
  CUMULUS_TOP_KM,
  TYPE_SHAPES,
  TYPE_TOP_KM,
  LIFTED_THICKNESS_KM,
  TYPED_LIFT_EASE_KM,
  TYPED_LIFT_KM,
  TYPED_LIFT_SHARES,
  TYPED_LIFT_STEPS,
  TYPED_LOWEST_SHARE,
  TYPED_ZERO_CODE,
  TYPED_ZERO_SLACK,
} from '../cloud-types'
import { MAX_CLOUD_TOP_KM, MIN_MEASURED_TOP_KM } from '../cloud-layer'

/** State after a first output whose fade had finished by wall 0. */
function settled(a: string, b: string, mix: number): BlendPassState {
  const first = planBlendPass(null, { a, b, mix }, -FADE_MS).state
  return planBlendPass(first, { a, b, mix }, 0).state
}

describe('planBlendPass', () => {
  test('the first output swaps and fades in over FADE_MS', () => {
    const first = planBlendPass(null, { a: '1', b: '2', mix: 0.2 }, 0)
    expect(first.pass).toEqual({ swap: true, fade: 0 })
    let state = first.state
    let fade = 0
    for (let wall = 16; wall <= FADE_MS; wall += 16) {
      const r = planBlendPass(state, { a: '1', b: '2', mix: 0.2 }, wall)
      state = r.state
      if (r.pass) {
        expect(r.pass.swap).toBe(false)
        expect(r.pass.fade).toBeGreaterThanOrEqual(fade)
        fade = r.pass.fade
      }
    }
    expect(Math.round(fade * 255)).toBe(255)
    const end = planBlendPass(first.state, { a: '1', b: '2', mix: 0.2 }, FADE_MS)
    expect(end.pass).toEqual({ swap: false, fade: 1 })
  })

  test('the fade always ends with a pass at exactly 1', () => {
    const first = planBlendPass(null, { a: '1', b: '2', mix: 0.2 }, 0)
    const nearly = planBlendPass(first.state, { a: '1', b: '2', mix: 0.2 }, FADE_MS - 4)
    expect(Math.round((nearly.pass?.fade ?? 0) * 255)).toBe(255)
    const end = planBlendPass(nearly.state, { a: '1', b: '2', mix: 0.2 }, FADE_MS)
    expect(end.pass).toEqual({ swap: false, fade: 1 })
  })

  test('a small step in mix draws without a swap', () => {
    const r = planBlendPass(settled('1', '2', 0.2), { a: '1', b: '2', mix: 0.25 }, 1000)
    expect(r.pass).toEqual({ swap: false, fade: 1 })
  })

  test('no pass while nothing changes in 8 bits', () => {
    const r = planBlendPass(settled('1', '2', 0.2), { a: '1', b: '2', mix: 0.2001 }, 1000)
    expect(r.pass).toBeNull()
  })

  test('a second call in the same frame draws nothing', () => {
    const first = planBlendPass(settled('1', '2', 0.2), { a: '1', b: '2', mix: 0.3 }, 1000)
    expect(first.pass).not.toBeNull()
    expect(planBlendPass(first.state, { a: '1', b: '2', mix: 0.3 }, 1000).pass).toBeNull()
  })

  test('moving on to the next pair is no discontinuity', () => {
    const r = planBlendPass(settled('1', '2', 0.97), { a: '2', b: '3', mix: 0.02 }, 1000)
    expect(r.pass).toEqual({ swap: false, fade: 1 })
  })

  test('a late frame, a jump or a big step swaps and fades', () => {
    const late = planBlendPass(settled('1', '1', 0), { a: '1', b: '2', mix: 0.5 }, 1000)
    expect(late.pass).toEqual({ swap: true, fade: 0 })
    const jump = planBlendPass(settled('1', '2', 0.5), { a: '7', b: '8', mix: 0.5 }, 1000)
    expect(jump.pass).toEqual({ swap: true, fade: 0 })
    const step = planBlendPass(settled('1', '2', 0.2), { a: '1', b: '2', mix: 0.6 }, 1000)
    expect(step.pass).toEqual({ swap: true, fade: 0 })
    const halfway = planBlendPass(step.state, { a: '1', b: '2', mix: 0.6 }, 1000 + FADE_MS / 2)
    expect(halfway.pass).toEqual({ swap: false, fade: 0.5 })
  })
})

// The cloud-type grids (tides-tvr.4.1) blended alongside the frames.
describe('type grids', () => {
  const frame = (geo: boolean, typed: boolean) => ({ geo, typed })
  const none = { measured: false, typed: false }

  test('typed where either frame carries types', () => {
    expect(outputFlags(frame(true, true), frame(true, false), none, 1)).toEqual({ measured: true, typed: true })
    expect(outputFlags(frame(false, false), frame(false, true), none, 1)).toEqual({ measured: false, typed: true })
    // The static clouds and untyped frames: neither.
    expect(outputFlags(frame(false, false), frame(false, false), none, 1)).toEqual(none)
  })

  test('the frozen output counts until its fade ends', () => {
    const prev = { measured: true, typed: true }
    expect(outputFlags(frame(false, false), frame(false, false), prev, 0.5)).toEqual(prev)
    expect(outputFlags(frame(false, false), frame(false, false), prev, 1)).toEqual(none)
  })

  test("a frame's types are in userData.types; the static clouds have none", () => {
    const types = new THREE.DataTexture(new Uint8Array(4), 1, 1)
    const typed = new THREE.Texture()
    typed.userData.types = types
    expect(typesOf(typed)).toBe(types)
    expect(typesOf(new THREE.Texture())).toBeNull()
    const untyped = new THREE.Texture()
    untyped.userData.types = null
    expect(typesOf(untyped)).toBeNull()
  })

  test('the neutral grid is one texel of confidence 0, shared', () => {
    const neutral = neutralTypeTexture()
    expect([neutral.image.width, neutral.image.height]).toEqual([1, 1])
    expect([...(neutral.image.data as Uint8Array)]).toEqual([0, 0, 0, 0])
    expect(neutral.colorSpace).toBe(THREE.NoColorSpace)
    expect(neutralTypeTexture()).toBe(neutral)
  })
})

describe('typed tops in the blend (tides-tvr.4.3)', () => {
  /** A renderer that records what each pass draws, and into what. */
  function recorder() {
    let target: THREE.WebGLRenderTarget | null = null
    const passes: { target: THREE.WebGLRenderTarget | null; material: THREE.ShaderMaterial }[] = []
    const gl = {
      getRenderTarget: () => target,
      setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
        target = t
      },
      render: (mesh: THREE.Mesh) => {
        passes.push({ target, material: mesh.material as THREE.ShaderMaterial })
      },
    }
    return { gl: gl as unknown as THREE.WebGLRenderer, passes }
  }

  test("draws the type grid first, for the main pass to code its output's tops from", () => {
    const { gl, passes } = recorder()
    const blender = createCloudBlender()
    const a = new THREE.Texture()
    a.userData.types = new THREE.DataTexture(new Uint8Array(4), 1, 1)
    const b = new THREE.Texture()
    const out = blender.update(gl, { a, b, mix: 0.5 }, new THREE.Texture(), 0)!
    expect(out.typed).toBe(true)
    expect(passes).toHaveLength(2)
    const [types, main] = passes
    expect(types.target!.texture).toBe(out.typeTexture)
    expect(main.target!.texture).toBe(out.texture)
    // The output's own grid, just drawn; not the frozen output's.
    expect(main.material.uniforms.uTypes.value).toBe(out.typeTexture)
    expect(main.material.fragmentShader).toContain(
      'gl_FragColor = vec4(c, cloudTypedCode(textureLod(uTypes, vUv, 0.0), c));'
    )
    blender.release()
  })

  test("codes the tops with ../cloud-types.ts's numbers", () => {
    const f = (x: number) => x.toFixed(6)
    const src = CLOUD_TYPED_TOP_GLSL
    // The code, shared with the march's cloudColumn().
    expect(src).toContain(TYPED_CODE_GLSL)
    for (const line of [
      `#define TYPED_ZERO_CODE ${f(TYPED_ZERO_CODE)}`,
      `#define TYPED_ZERO_SLACK ${f(TYPED_ZERO_SLACK)}`,
      `#define TYPED_LOWEST_SHARE ${f(TYPED_LOWEST_SHARE)}`,
      `#define TYPED_LIFT_KM_PER_CODE (${f(TYPED_LIFT_KM)} / ${f(TYPED_LIFT_STEPS)})`,
      `#define TYPED_LIFT_STEPS ${f(TYPED_LIFT_STEPS)}`,
      `#define TYPED_LIFT_EASE_KM ${f(TYPED_LIFT_EASE_KM)}`,
      `#define LIFTED_THICKNESS(alpha) (${f(LIFTED_THICKNESS_KM[0])} + ${f(LIFTED_THICKNESS_KM[1])} * (alpha))`,
    ]) {
      expect(TYPED_CODE_GLSL).toContain(line)
    }
    // Each kind in the grid's order: cirrus, cumulus, alto, stratus.
    const kinds = [TYPE_SHAPES.cirrus, TYPE_SHAPES.cumulus, TYPE_SHAPES.alto, TYPE_SHAPES.stratus]
    for (const [name, i] of [['FLOOR', 0], ['FROM', 1], ['TO', 2]] as const) {
      expect(src).toContain(`#define TYPE_SHAPE_${name} vec4(${kinds.map((k) => f(k[i])).join(', ')})`)
    }
    expect(src).toContain(
      `vec4 km = mix(vec4(${f(TYPE_TOP_KM.cirrus)}, ${f(CUMULUS_TOP_KM[0])} + ${f(CUMULUS_TOP_KM[1])} * g * g, ` +
        `${f(TYPE_TOP_KM.alto)}, ${f(TYPE_TOP_KM.stratus)}),\n    vec4(measured), c.b);`
    )
    // The untyped top, as cloudColumn() has it.
    expect(src).toContain(`float measured = max(c.r * ${f(MAX_CLOUD_TOP_KM)}, ${f(MIN_MEASURED_TOP_KM)});`)
    expect(src).toContain(
      'float untyped = mix(1.5 + 7.0 * g * g, measured, c.b) * (0.25 + 0.75 * smoothstep(0.0, 0.65, g));'
    )
    // No confidence, no change; the shares refined as at the hit.
    const fn = src.slice(src.indexOf('float cloudTypedCode('))
    expect(fn.indexOf('if (t.a <= 0.0) return TYPED_ZERO_CODE / 255.0;')).toBeLessThan(fn.indexOf('cloudTypeShares(t, c)'))
    // typedTopCode(): the typed top, confidence of the way; lifted to it
    // where mostly cirrus and alto (R and B) and the march reads the layer
    // as lifted for; else lowered by a share, never raised.
    for (const line of [
      'float typed = mix(untyped, dot(s, km * shape), t.a);',
      'float share = s.x + s.z;',
      `if (share >= ${f(TYPED_LIFT_SHARES[0])}) {`,
      `float rise = smoothstep(${f(TYPED_LIFT_SHARES[0])}, ${f(TYPED_LIFT_SHARES[1])}, share);`,
      'float layer = min(untyped, LIFTED_THICKNESS(g));',
      'float lift = min(typed, untyped) + rise * max(typed - untyped, 0.0) - layer;',
      'float misread = mix(untyped, layer, smoothstep(0.0, TYPED_LIFT_EASE_KM, lift)) - layer;',
      'if (lift >= TYPED_LIFT_KM_PER_CODE && misread <= TYPED_LIFT_KM_PER_CODE) {',
      'return (TYPED_ZERO_CODE + min(lift / TYPED_LIFT_KM_PER_CODE, TYPED_LIFT_STEPS)) / 255.0;',
      'float keep = clamp(typed / max(untyped, 1e-6), TYPED_LOWEST_SHARE, 1.0);',
      'return TYPED_ZERO_CODE * keep / 255.0;',
    ]) {
      expect(fn).toContain(line)
    }
  })
})
