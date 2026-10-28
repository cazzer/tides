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
  TYPE_FRAGMENT_SHADER,
} from './cloudBlend'
import { CLOUD_TYPED_TOP_GLSL, TYPED_TOPS_GLSL } from './cloudTypeGlsl'
import {
  CUMULUS_TOP_KM,
  TYPE_SHAPES,
  TYPE_TOP_KM,
  LIFTED_THICKNESS_KM,
  TYPED_LIFT_SHARES,
  TYPED_LOWEST_SHARE,
  TYPED_TOPS_KM,
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
  test('mixes the grids as they are: their shares premultiplied by confidence (tides-tvr.4.4)', () => {
    expect(TYPE_FRAGMENT_SHADER).toContain('return textureLod(t, vUv, 0.0) * typed;')
    expect(TYPE_FRAGMENT_SHADER).toContain('vec4 frames = mix(typeTexel(uA, uATyped), typeTexel(uB, uBTyped), uMix);')
    expect(TYPE_FRAGMENT_SHADER).toContain('gl_FragColor = mix(typeTexel(uPrev, uPrevTyped), frames, uFade);')
  })

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

describe('typed tops in the blend (tides-tvr.4.3, tides-tvr.4.9)', () => {
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

  test("draws the type grid first, for the main pass to work its output's tops out from", () => {
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
    blender.release()
  })

  test('writes the map and its tops to two textures alike, read with the same coordinates and mip', () => {
    const { gl, passes } = recorder()
    const blender = createCloudBlender()
    const out = blender.update(gl, { a: new THREE.Texture(), b: new THREE.Texture(), mix: 0.5 }, new THREE.Texture(), 0)!
    const target = passes[1].target!
    expect(target.textures).toHaveLength(2)
    expect(target.textures[0]).toBe(out.texture)
    expect(target.textures[1]).toBe(out.topsTexture)
    const [map, tops] = target.textures
    for (const key of ['format', 'type', 'minFilter', 'magFilter', 'generateMipmaps', 'wrapS', 'wrapT', 'colorSpace'] as const) {
      expect(tops[key], key).toBe(map[key])
    }
    expect(map.generateMipmaps).toBe(true)
    expect(map.minFilter).toBe(THREE.LinearMipmapLinearFilter)
    expect([tops.image.width, tops.image.height]).toEqual([map.image.width, map.image.height])
    // GLSL3, for the second output; the map's alpha back to 1 as before
    // tides-tvr.4.3, and the frozen output's map alone fed back.
    const main = passes[1].material
    expect(main.glslVersion).toBe(THREE.GLSL3)
    const src = main.fragmentShader
    expect(src).toContain('layout(location = 0) out highp vec4 cloudMap;')
    expect(src).toContain('layout(location = 1) out highp vec4 cloudTops;')
    expect(src).not.toContain('gl_FragColor')
    expect(src).toContain('cloudMap = vec4(c, 1.0);')
    expect(src).toContain('cloudTops = cloudTypedTops(textureLod(uTypes, vUv, 0.0), c);')
    // A swap: the next pass fades from this output's map, not its tops.
    blender.update(gl, { a: new THREE.Texture(), b: new THREE.Texture(), mix: 0.5 }, new THREE.Texture(), 1000)
    expect(passes[3].material.uniforms.uPrev.value).toBe(out.texture)
    blender.release()
  })

  test("works the tops out with ../cloud-types.ts's numbers", () => {
    const f = (x: number) => x.toFixed(6)
    const src = CLOUD_TYPED_TOP_GLSL
    // The tops' scale, shared with the march's cloudColumn().
    expect(src).toContain(TYPED_TOPS_GLSL)
    expect(TYPED_TOPS_GLSL).toContain(`#define TYPED_TOPS_KM ${f(TYPED_TOPS_KM)}`)
    expect(TYPED_TOPS_KM).toBe(MAX_CLOUD_TOP_KM)
    for (const line of [
      `#define TYPED_LOWEST_SHARE ${f(TYPED_LOWEST_SHARE)}`,
      `#define LIFTED_THICKNESS(alpha) (${f(LIFTED_THICKNESS_KM[0])} + ${f(LIFTED_THICKNESS_KM[1])} * (alpha))`,
    ]) {
      expect(src).toContain(line)
    }
    expect(src).not.toMatch(/TYPED_ZERO|TYPED_LIFT_KM|TYPED_LIFT_EASE|cloudTypedCode/)
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
    // No confidence, untyped; the shares refined as at the hit.
    const fn = src.slice(src.indexOf('vec4 cloudTypedTops('))
    expect(fn.indexOf('if (t.a <= 0.0) return vec4(untyped / TYPED_TOPS_KM, 0.0, 0.0, 0.0);')).toBeGreaterThan(0)
    expect(fn.indexOf('if (t.a <= 0.0) return')).toBeLessThan(fn.indexOf('cloudTypeShares(t, c)'))
    // typedTops(): lowered on the ground to a share, never raised; lifted to
    // a layer where mostly cirrus and alto (R and B); then confidence of the
    // way from the untyped column, both channels over TYPED_TOPS_KM.
    for (const line of [
      'float typed = dot(s, km * shape);',
      'float top = clamp(typed, TYPED_LOWEST_SHARE * untyped, untyped);',
      'float lift = 0.0;',
      'float share = s.x + s.z;',
      `if (share >= ${f(TYPED_LIFT_SHARES[0])}) {`,
      `float rise = smoothstep(${f(TYPED_LIFT_SHARES[0])}, ${f(TYPED_LIFT_SHARES[1])}, share);`,
      'float lifted = min(typed, untyped) + rise * max(typed - untyped, 0.0);',
      'float layer = min(untyped, LIFTED_THICKNESS(g));',
      'if (lifted > layer) {\n      top = lifted;\n      lift = lifted - layer;\n    }',
      'return vec4(mix(untyped, top, t.a) / TYPED_TOPS_KM, t.a * lift / TYPED_TOPS_KM, 1.0, 0.0);',
    ]) {
      expect(fn).toContain(line)
    }
  })
})
