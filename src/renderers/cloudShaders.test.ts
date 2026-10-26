import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import {
  createCloudLayer,
  DETAIL_EDGE_FAR,
  DETAIL_EDGE_NEAR,
  DETAIL_GRAIN_PX,
  DETAIL_HOLE_PX,
  DETAIL_INTERIOR,
  DETAIL_VIEW_PX,
  detailEdge,
  detailErosion,
  detailFall,
  detailPixelScale,
  MARCH_STEP,
  MARCH_STEPS,
} from './cloudShaders'
import {
  CLOUD_CLEARANCE,
  CLOUD_LAYER_TOP,
  CLOUD_MIN_ALPHA,
  cloudPathClear,
  DETAIL_BASE_TEXELS,
  DETAIL_OCTAVES,
  detailOctaveWeights,
  columnDepth,
  easedFogExtinction,
  eyePastOffsets,
  FOG_EASE_SAMPLES,
  FOG_EASE_SECONDS,
  FOG_SOFT,
  fogEaseShare,
  fogExtinction,
  lightCentroid,
  marchCrossing,
  marchSpanFromEye,
  marchSteps,
  type MarchSample,
  type ShadeSum,
  shadeAdd,
  shadePlace,
  type Vec3,
} from '../cloud-layer'
import { sceneRadius } from '../planets'
import { clearLimbView, updateLimbView } from '../ship/limb-detail'
import { prefersReducedMotion } from '../ship/reduced-motion'
import {
  AURORA_SHELL_INNER,
  CLOUD_REACH_RENDER_ORDER,
  CLOUD_UNDER_AURORA_RENDER_ORDER,
} from './earth-shells'

vi.mock('../ship/reduced-motion', () => ({ prefersReducedMotion: vi.fn(() => false) }))

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

  it('starts at the eye inside the shell, whatever the near plane, and at the shell outside it', () => {
    // An eye in the shell, under its top whatever the relief (0.11 at 25x).
    const eye = CLOUD_LAYER_TOP - 0.028
    const inside = marchSpanFromEye([0, sea + eye, 0], [1, 0, 0], sea, outer)!
    // From the eye, its first step too (tides-16z, tides-tvr.1).
    expect(inside.origin).toBe(0)
    expect(marchSteps(inside, MARCH_STEP, MARCH_STEPS)[0]).toBe(0)
    expect(inside.end).toBeCloseTo(Math.sqrt(outer ** 2 - (sea + eye) ** 2), 9)
    const down = marchSpanFromEye([0, sea + eye, 0], [0, -1, 0], sea, outer)!
    expect(down.end).toBeCloseTo(eye - CLOUD_CLEARANCE, 9)
    const outside = marchSpanFromEye([0, sea + 0.3, 0], [0, -1, 0], sea, outer)!
    expect(outside.origin).toBeCloseTo(0.3 - CLOUD_LAYER_TOP, 9)
    expect(marchSpanFromEye([0, sea + 0.3, 0], [0, 1, 0], sea, outer)).toBeNull()
    // The shader's march has no near plane in it: the near plane only
    // bounds the depth a hit is drawn at.
    const clouds = createCloudLayer(createEclipseShadow('earth'), false)
    const program = preprocess(clouds.material.fragmentShader, new Set(['FLIP_SIDED']))
      .replace(/\/\/.*$/gm, '')
    expect(program.match(/\bsNear\b/g)).toHaveLength(2)
    expect(program).toContain('float sNear = vNear * length(vRayDir) / vViewDepth;')
    expect(program).toContain('max(eyeDist, sNear)')
    clouds.dispose()
  })

  it('carries a ray that skims over the sea on, up under the deck', () => {
    const eye: [number, number, number] = [0, sea + 0.004, 0]
    // Level: below the lowest base, then up under the bases beyond.
    const level = marchSpanFromEye(eye, [1, 0, 0], sea, outer)!
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
    expect(marchSpanFromEye(eye, dir, sea, outer)!.end).toBeCloseTo(meets(sea + 0.004, sea), 9)
    const high = marchSpanFromEye([0, sea + 0.05, 0], dir, sea, outer)!
    expect(high.end).toBeCloseTo(meets(sea + 0.05, sea + CLOUD_CLEARANCE), 9)
    // Up from below the deck: the sea behind the eye ends nothing.
    const up = marchSpanFromEye(eye, [Math.cos(a), -Math.sin(a), 0], sea, outer)!
    const b = (sea + 0.004) * -Math.sin(a)
    expect(up.end).toBeCloseTo(-b + Math.sqrt(b * b - ((sea + 0.004) ** 2 - outer ** 2)), 9)
  })

  it('keeps every march from inside within the step budget', () => {
    // From the deck's bottom to above the shell. Rays that skim over the sea
    // from the shell's top stretch the clamped steps, by under 2%. The steps
    // count from the eye (tides-16z).
    let longest = 0
    let most = 0
    for (let alt = 0.001; alt <= CLOUD_LAYER_TOP + 0.01; alt += 0.005) {
      for (let deg = -90; deg <= 90; deg += 0.5) {
        const a = (deg * Math.PI) / 180
        const span = marchSpanFromEye([0, sea + alt, 0], [Math.cos(a), Math.sin(a), 0], sea, outer)
        if (!span) continue
        longest = Math.max(longest, span.end - span.origin)
        most = Math.max(most, marchSteps(span, MARCH_STEP, MARCH_STEPS).length)
      }
    }
    expect(longest / MARCH_STEPS).toBeLessThanOrEqual(MARCH_STEP * 1.02)
    // The origin and MARCH_STEPS steps on: the eye's read and the shader's
    // loop.
    expect(most).toBeLessThanOrEqual(MARCH_STEPS + 1)
  })

  for (const flat of [false, true]) {
    it(`leaves the outside program as it was (${flat ? 'flat' : 'relief'})`, () => {
      const clouds = createCloudLayer(createEclipseShadow('earth'), flat)
      const defines = new Set(flat ? ['CLOUD_FLAT'] : [])
      const { vertexShader, fragmentShader } = clouds.material
      for (const name of ['gl_FragDepth', 'vEye', 'sNear', 'eclipsePoint(pShade)']) {
        expect(preprocess(fragmentShader, defines)).not.toContain(name)
        expect(preprocess(fragmentShader, new Set([...defines, 'FLIP_SIDED']))).toContain(name)
      }
      expect(preprocess(vertexShader, defines)).toContain('projectionMatrix * viewMatrix * world')
      // Reduced motion's fog ease leaves it as it was too.
      for (const source of [vertexShader, fragmentShader]) {
        expect(preprocess(source, new Set([...defines, 'FOG_EASE']))).toBe(preprocess(source, defines))
      }
      clouds.dispose()
    })

    it(`draws back faces only within the ship camera's reach (${flat ? 'flat' : 'relief'})`, () => {
      const clouds = createCloudLayer(createEclipseShadow('earth'), flat)
      clouds.uniforms.uSeaLevel.value = sea
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), clouds.material)
      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.001, 100)
      const render = (cam: THREE.Camera) => clouds.faceCamera(mesh, cam)
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
    expect(top).toEqual({ at: expect.closeTo(0.5, 9), until: 1, side: false, depth: 0 })
    expect(marchCrossing(at(0.009, 0.0075, clear), at(0.0055 + 0.0015, 0.0075, clear))).toBeNull()
    expect(marchCrossing(at(0.026, 0.022, solid), at(0.024, 0.022, solid))).toBeNull()
  })

  it('meets tops as from outside from above the deck', () => {
    const faint = marchCrossing(at(0.009, 0.0075, clear), at(0.007, 0.0075, clear), true)
    expect(faint).toEqual({ at: expect.closeTo(0.75, 9), until: 1, side: false, depth: 0 })
  })

  it('goes up through a base where the cloud shows, as through a side, and up through a gap', () => {
    const below = at(0.003, 0.03, solid)
    expect(marchCrossing(below, at(0.007, 0.03, solid))).toEqual({
      at: expect.closeTo(0.75, 9),
      until: 1,
      side: true,
      depth: null,
    })
    expect(marchCrossing({ ...below, alpha: clear }, at(0.007, 0.0075, clear))).toBeNull()
    // A thin column crossed whole in one step still counts, as far as its top.
    const thin = marchCrossing(below, at(0.014, 0.01, solid))!
    expect(thin.at).toBeCloseTo(0.003 / 0.011, 9)
    expect(thin.until).toBeCloseTo(0.027 / 0.031, 9)
    expect(marchCrossing(below, at(0.005, 0.03, solid))).toBeNull()
  })

  it('meets a side from a gap within the deck', () => {
    const gap = at(0.007, 0.0075, 0)
    const hit = marchCrossing(gap, at(0.007, 0.03, 0.2))!
    expect(hit).toEqual({ at: expect.closeTo(CLOUD_MIN_ALPHA / 0.2, 9), until: 1, side: true, depth: null })
    expect(marchCrossing(gap, at(0.007, 0.0075, clear))).toBeNull()
    // Within a cloud already, or leaving the deck before the cloud shows,
    // nothing new.
    expect(marchCrossing({ ...gap, top: 0.03, alpha: solid }, at(0.007, 0.03, solid))).toBeNull()
    expect(marchCrossing(gap, at(0.009, 0.0075, 0.05))).toBeNull()
  })

  it('meets cloud the ray clips between two steps', () => {
    // Out of the deck by the next step, but in the cloud a while before.
    const hit = marchCrossing(at(0.007, 0.0075, 0), at(0.009, 0.0075, solid))!
    expect(hit.at).toBeCloseTo(CLOUD_MIN_ALPHA / solid, 9)
    expect(hit.until).toBeCloseTo(0.25, 9)
    expect(hit.side).toBe(true)
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
    expect(hit).toEqual({ at: expect.closeTo(0.5 + 0.5 * t, 9), until: 1, side: true, depth: null })
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

  for (const variant of [
    [],
    ['CLOUD_FLAT'],
    ['FLIP_SIDED'],
    ['CLOUD_FLAT', 'FLIP_SIDED'],
    ['FLIP_SIDED', 'FOG_EASE'],
  ]) {
    it(`declares what the program reads (${variant.join('+') || 'relief'})`, () => {
      // Without a WebGL context, a guard against names one branch defines
      // and the shared code reads.
      const clouds = createCloudLayer(createEclipseShadow('earth'), variant.includes('CLOUD_FLAT'))
      const src = preprocess(clouds.material.fragmentShader, new Set(variant))
      const names = [
        'colIn',
        'side',
        'sideClear',
        'depthHit',
        'fromAbove',
        'depth',
        'eye',
        'shell',
        'fogged',
        'fogClear',
        'fogLight',
        'fogEase',
        'sidePrev',
        'sideDensity',
        'sideShade',
      ]
      for (const name of names) {
        if (new RegExp(`\\b${name}\\b`).test(src.replace(/\/\/.*$/gm, ''))) {
          expect(src).toMatch(new RegExp(`(float|vec2|vec3|vec4|bool) ${name}\\b`))
        }
      }
      clouds.dispose()
    })
  }
})

describe('fog inside a cloud (tides-01v.8.6)', () => {
  const sea = sceneRadius(12742000)
  // A column based at 0.006 and topped at 0.03.
  const fog = (alpha: number, altitude: number) => fogExtinction(alpha, 0.006, 0.03, altitude)
  const clear = (sigma: number, path: number) => Math.exp(-sigma * path)

  it('whites out in dense cloud and only veils in thin', () => {
    // Level through the middle of the column, a few march steps.
    expect(clear(fog(0.85, 0.018), 2 * MARCH_STEP)).toBeLessThan(0.01)
    expect(clear(fog(0.1, 0.018), 2 * MARCH_STEP)).toBeGreaterThan(0.5)
    expect(fog(0.3, 0.018)).toBeGreaterThan(fog(0.1, 0.018))
    expect(fog(0.85, 0.018)).toBeGreaterThan(fog(0.3, 0.018))
  })

  it('is clear outside a cloud and in a gap', () => {
    expect(fog(0.9, 0.005)).toBe(0)
    expect(fog(0.9, 0.031)).toBe(0)
    expect(fog(CLOUD_MIN_ALPHA / 2, 0.018)).toBe(0)
  })

  it('thickens from nothing at the top and base', () => {
    expect(fog(0.8, 0.03)).toBe(0)
    expect(fog(0.8, 0.006)).toBe(0)
    const deep = fog(0.8, 0.018)
    const nearTop = 0.03 - 0.5 * FOG_SOFT * 0.024
    expect(fog(0.8, nearTop)).toBeGreaterThan(0)
    expect(fog(0.8, nearTop)).toBeLessThan(deep)
  })

  it('eases in from the side as seen from outside (tides-01v.8.15)', () => {
    // Eased out, the fog over a path is the side's over it.
    for (const alpha of [0.1, 0.4, 0.85]) {
      const sigma = easedFogExtinction(alpha, 0.006, 0.03, 0.018, 0)
      expect(Math.exp(-sigma * 0.01)).toBeCloseTo(cloudPathClear(alpha, 0.024, 0.01), 9)
    }
    // Eased in, the fog's own; between, between; outside a cloud, none.
    expect(easedFogExtinction(0.8, 0.006, 0.03, 0.018, 1)).toBe(fog(0.8, 0.018))
    const side = easedFogExtinction(0.8, 0.006, 0.03, 0.018, 0)
    const half = easedFogExtinction(0.8, 0.006, 0.03, 0.018, 0.5)
    expect(half).toBeCloseTo((side + fog(0.8, 0.018)) / 2, 9)
    expect(easedFogExtinction(0.8, 0.006, 0.03, 0.031, 0)).toBe(0)
    expect(easedFogExtinction(CLOUD_MIN_ALPHA / 2, 0.006, 0.03, 0.018, 0)).toBe(0)
  })

  it('times the ease from when the march\'s start was last out of the cloud', () => {
    // In for the whole window, or never out: all of it; out now: none.
    expect(fogEaseShare(0.5, [0.5, 0.4, 0.3, 0.2])).toBe(1)
    expect(fogEaseShare(0, [0.5, 0.5])).toBe(0)
    // Out between the second and third samples back, halfway: 1.5 of 4.
    const share = fogEaseShare(0.5, [0.4, 0.2, -0.2, -0.4])
    const t = 2.5 / 4
    expect(share).toBeCloseTo(t * t * (3 - 2 * t), 9)
    // Later out, more eased in.
    expect(fogEaseShare(0.5, [-0.5, -0.5])).toBeLessThan(share)
  })

  it('reads where the eye was over the ease, between its samples', () => {
    const track = [
      { t: 0, p: [0, 0, 0] as [number, number, number] },
      { t: 0.5, p: [1, 0, 0] as [number, number, number] },
      { t: 1, p: [2, 0, 0] as [number, number, number] },
    ]
    const offsets = eyePastOffsets(track, 0.5, 2)
    expect(offsets[0][0]).toBeCloseTo(-0.5, 9)
    expect(offsets[1][0]).toBeCloseTo(-1, 9)
    // Before the oldest sample, there; a still eye, nowhere.
    expect(eyePastOffsets(track, 4, 2)[1][0]).toBeCloseTo(-2, 9)
    expect(eyePastOffsets(track.slice(2), 1, 3)).toEqual([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ])
  })

  for (const flat of [false, true]) {
    it(`fogs from inside a cloud only from within reach (${flat ? 'flat' : 'relief'})`, () => {
      const clouds = createCloudLayer(createEclipseShadow('earth'), flat)
      const variant = flat ? ['CLOUD_FLAT'] : []
      const outside = preprocess(clouds.material.fragmentShader, new Set(variant))
      const inside = preprocess(clouds.material.fragmentShader, new Set([...variant, 'FLIP_SIDED']))
      for (const name of ['cloudFogDensity', 'cloudHazeFront', 'fogged']) {
        expect(outside).not.toContain(name)
      }
      expect(inside).toContain('cloudHazeFront(eye, d, length(pShade - eye), shell)')
      // The atmosphere's own haze, shared with its shader.
      expect(inside).toContain('float columnAhead(')
      // Only the relief march has columns to stand in.
      expect(inside.includes('cloudFogEdge(colq, alt)')).toBe(!flat)
      // A camera in a cloud no longer sees a flat card.
      expect(inside).not.toContain('vec3(0.8)')
      // Both programs premultiply, as the material blends.
      expect(clouds.material.premultipliedAlpha).toBe(true)
      expect(outside).toContain('gl_FragColor.rgb *= gl_FragColor.a')
      expect(inside).toContain('gl_FragColor.rgb * gl_FragColor.a')
      clouds.dispose()
    })

    it(`draws after the haze within reach, and under the aurora after it (${flat ? 'flat' : 'relief'})`, () => {
      const clouds = createCloudLayer(createEclipseShadow('earth'), flat)
      clouds.uniforms.uSeaLevel.value = sea
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), clouds.material)
      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.001, 100)
      const orderAt = (altitude: number) => {
        camera.position.set(0, sea + altitude, 0)
        camera.updateMatrixWorld()
        clouds.faceCamera(mesh, camera)
        return mesh.renderOrder
      }
      try {
        const earth = { key: 'earth', position: new THREE.Vector3(), radius: sea }
        updateLimbView('earth', [earth], new THREE.Vector3(0, sea + 0.1, 0), 800, 60)
        const auroraBase = sea * (AURORA_SHELL_INNER - 1)
        expect(orderAt(clouds.shellAltitude + 0.1)).toBe(0)
        const top = clouds.shellAltitude - 0.001
        expect(orderAt(top)).toBe(
          top < auroraBase ? CLOUD_UNDER_AURORA_RENDER_ORDER : CLOUD_REACH_RENDER_ORDER
        )
        expect(orderAt(0.02)).toBe(CLOUD_UNDER_AURORA_RENDER_ORDER)
        expect(CLOUD_REACH_RENDER_ORDER).toBeGreaterThan(1)
        expect(CLOUD_REACH_RENDER_ORDER).toBeLessThan(2)
        clearLimbView()
        expect(orderAt(0.02)).toBe(0)
      } finally {
        clearLimbView()
        clouds.dispose()
      }
    })
  }

  it('eases the fog in with reduced motion, from where the eye has been', () => {
    const clouds = createCloudLayer(createEclipseShadow('earth'), false)
    clouds.uniforms.uSeaLevel.value = sea
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), clouds.material)
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.001, 100)
    const now = vi.spyOn(performance, 'now')
    const renderAt = (ms: number, x: number) => {
      now.mockReturnValue(ms)
      camera.position.set(x, sea + 0.02, 0)
      camera.updateMatrixWorld()
      clouds.faceCamera(mesh, camera)
    }
    try {
      const earth = { key: 'earth', position: new THREE.Vector3(), radius: sea }
      updateLimbView('earth', [earth], new THREE.Vector3(0, sea + 0.1, 0), 800, 60)
      renderAt(0, 0)
      expect(clouds.material.defines).not.toHaveProperty('FOG_EASE')
      vi.mocked(prefersReducedMotion).mockReturnValue(true)
      const version = clouds.material.version
      // Flying along x at 0.01 a second, another camera, far off, rendering
      // between.
      const far = new THREE.PerspectiveCamera()
      far.position.set(0, sea * 10, 0)
      far.updateMatrixWorld()
      for (let ms = 0; ms <= 2000; ms += 100) {
        renderAt(ms, ms / 1e5)
        clouds.faceCamera(mesh, far)
      }
      expect(clouds.material.defines).toHaveProperty('FOG_EASE')
      expect(clouds.material.version).toBeGreaterThan(version)
      const past = clouds.material.uniforms.uFogPast.value as THREE.Vector3[]
      expect(past).toHaveLength(FOG_EASE_SAMPLES)
      past.forEach((offset, k) => {
        const back = ((k + 1) / FOG_EASE_SAMPLES) * FOG_EASE_SECONDS * 0.01
        expect(offset.x).toBeCloseTo(-back, 6)
      })
      vi.mocked(prefersReducedMotion).mockReturnValue(false)
      renderAt(2100, 0.021)
      expect(clouds.material.defines).not.toHaveProperty('FOG_EASE')
    } finally {
      vi.mocked(prefersReducedMotion).mockReturnValue(false)
      now.mockRestore()
      clearLimbView()
      clouds.dispose()
    }
  })

  it('ends the march past its fog at the ground mesh, under a ridge too (tides-01v.8.13)', () => {
    const clouds = createCloudLayer(createEclipseShadow('earth'), false)
    const inside = preprocess(clouds.material.fragmentShader, new Set(['FLIP_SIDED']))
    // Where the ray goes under the mesh within a step, the step is cut there:
    // its fog and what it meets short of the ground count, nothing past.
    expect(inside).toContain('float aboveGround = alt - cloudGround(uvq);')
    expect(inside).toContain('clip * stepLen')
    expect(inside).toContain('if (clip < 1.0) break;')
    clouds.dispose()
  })
})

describe('cloud march holding still as the camera moves (tides-16z)', () => {
  const sea = sceneRadius(12742000)
  const outer = sea + CLOUD_LAYER_TOP
  const eye: Vec3 = [0, sea + 0.05, 0]
  const along = (deg: number): Vec3 => {
    const a = (deg * Math.PI) / 180
    return [Math.cos(a), Math.sin(a), 0]
  }

  it('anchors the steps to the eye, so turning moves none of them, the first too', () => {
    // The ship's camera turns about the eye: a ray on the view axis, turned
    // 45° off it, meets the near plane further on, near / cos 45°. The march
    // takes no near plane (tides-tvr.1): a ray's steps are a whole number of
    // steps from the eye, from the first, the eye itself, on.
    expect(marchSpanFromEye).toHaveLength(4)
    for (const deg of [-60, -30, -10, 0, 10, 30]) {
      const steps = marchSteps(marchSpanFromEye(eye, along(deg), sea, outer)!, MARCH_STEP, MARCH_STEPS)
      expect(steps[0]).toBe(0)
      const ds = steps[1]
      for (const [i, s] of steps.slice(0, -1).entries()) expect(s).toBeCloseTo(i * ds, 12)
    }
    // In the shader, each step from the eye on, none from the near plane.
    const clouds = createCloudLayer(createEclipseShadow('earth'), false)
    const inside = preprocess(clouds.material.fragmentShader, new Set(['FLIP_SIDED']))
    expect(inside).toContain('float s = min(sOrigin + ds * float(i), sEnd);')
    expect(inside).not.toContain('max(sOuter, sNear)')
    clouds.dispose()
  })

  it('keeps the same step phase from ray to ray inside the shell (tides-01v.8.12)', () => {
    // Steps MARCH_STEP from the eye on every ray long enough for them: but
    // for the end, on the same spheres about the eye.
    let checked = 0
    for (let deg = -60; deg <= 60; deg += 0.25) {
      const span = marchSpanFromEye(eye, along(deg), sea, outer)!
      const steps = marchSteps(span, MARCH_STEP, MARCH_STEPS)
      if (Math.abs(steps[2] - steps[1] - MARCH_STEP) > 1e-12) continue
      for (const s of steps.slice(0, -1)) {
        expect(Math.abs(s / MARCH_STEP - Math.round(s / MARCH_STEP))).toBeLessThan(1e-9)
      }
      checked++
    }
    expect(checked).toBeGreaterThan(300)
  })

  it('reads the ray spread off the image plane, and the deck without a toggle', () => {
    const clouds = createCloudLayer(createEclipseShadow('earth'), false)
    const inside = preprocess(clouds.material.fragmentShader, new Set(['FLIP_SIDED']))
    const outside = preprocess(clouds.material.fragmentShader, new Set())
    expect(inside).toContain('vec3 plane = vRayDir / vViewDepth;')
    expect(inside).toContain('length(dFdx(plane))')
    expect(inside).not.toContain('length(dFdx(d))')
    expect(inside).not.toContain('inDeck')
    expect(inside).toContain('cloudMarchColumn(uvq, r, mu, cloudTerrain(uvq), s, ds, spread, fromAbove)')
    // The march from outside is as it was.
    expect(outside).toContain('float spread = max(length(dFdx(d)), length(dFdy(d)));')
    expect(outside).not.toContain('cloudMarchColumn(')
    clouds.dispose()
  })
})

describe('cloud march from the eye, under and inside the deck (tides-tvr.1)', () => {
  // A column based at 0.006 and topped at 0.03.
  const at = (alt: number, alpha = 0.6) => ({ alt, base: 0.006, top: 0.03, alpha })

  it('decides at the eye whether the march starts in a cloud', () => {
    // The eye just under the base, the near plane past it: the first step,
    // from the eye, goes up through the base short of the near plane.
    const under = marchCrossing(at(0.0055), at(0.0075))!
    expect(under.side).toBe(true)
    expect(under.at).toBeCloseTo(0.25, 9)
    expect(under.at).toBeLessThan(1)
    // The eye in the cloud: nothing to cross, the fog runs from the eye.
    expect(marchCrossing(at(0.007), at(0.009))).toBeNull()
    // Under a gap, nothing.
    expect(marchCrossing(at(0.0055, 0), at(0.0075, 0))).toBeNull()
  })

  // The light a crossing's stretch of cloud within its step sends back, and
  // where from (cloudShadeAdd() at the hit step), the step s0 to s1 along
  // the ray.
  const shadeOf = (prev: MarchSample, next: MarchSample, s0: number, s1: number) => {
    const hit = marchCrossing(prev, next)!
    const clear = cloudPathClear(next.alpha, next.top - next.base, (s1 - s0) * (hit.until - hit.at))
    const sum: ShadeSum = { weight: 0, depth: 0, distance: 0, top: 0, base: 0 }
    shadeAdd(sum, 1 - clear, prev, next, s0, s1, hit.at + (hit.until - hit.at) * lightCentroid(clear))
    return { hit, clear, sum }
  }

  it('shades a base and the side beside it alike where they meet', () => {
    // Up through the base, and a ray a hair higher meeting the side beside
    // that base from a gap: both shaded from the light they send back.
    const up = shadeOf(at(0.0055), at(0.0075), 0.1, 0.111)
    const beside = shadeOf(at(0.00605, 0), at(0.00615), 0.1, 0.111)
    expect(up.hit.side && beside.hit.side).toBe(true)
    const a = shadePlace(up.sum, 0, { depth: 0, distance: 0, top: 0, base: 0 })!
    const b = shadePlace(beside.sum, 0, { depth: 0, distance: 0, top: 0, base: 0 })!
    expect(a.depth).toBeGreaterThan(0.9)
    expect(Math.abs(a.depth - b.depth)).toBeLessThan(0.05)
    expect(Math.abs(a.distance - b.distance)).toBeLessThan(0.002)
  })

  it('shades a veil alike whether it ends the ray or a cloud past it shows', () => {
    // A dense side the ray meets: on one ray it ends there, on the next it
    // goes on through it as a veil to a top far beyond (so far as the
    // march's SIDE_REST lets it), seen through what the veil lets through.
    const near = shadeOf(at(0.0055, 0.95), at(0.0075, 0.95), 0.1, 0.111)
    const ends = shadePlace(near.sum, 0, { depth: 0, distance: 0, top: 0, base: 0 })!
    const veilClear = Math.max(near.clear, 0.02)
    const top = { depth: 0, distance: 0.4, top: 0.012, base: 0.006 }
    const past = shadePlace(near.sum, veilClear * 0.9, top)!
    // Shaded at the far top, as the hit was, the two would be a whole
    // column's depth apart; from where the light comes, only by what the
    // veil lets through.
    expect(Math.abs(ends.depth - top.depth)).toBeGreaterThan(0.5)
    expect(Math.abs(ends.depth - past.depth)).toBeLessThan(2 * veilClear)
    expect(Math.abs(past.distance - ends.distance)).toBeLessThan(2 * veilClear * top.distance)
    expect(Math.abs(past.top - ends.top)).toBeLessThan(2 * veilClear * 0.03)
    // Nothing that sends light back: no place.
    expect(shadePlace({ weight: 0, depth: 0, distance: 0, top: 0, base: 0 }, 0, top)).toBeNull()
  })

  it('finds where a stretch of cloud sends its light back from', () => {
    expect(lightCentroid(1)).toBeCloseTo(0.5, 9)
    expect(lightCentroid(0.999)).toBeCloseTo(0.5, 3)
    // Dense: about one optical depth in.
    expect(lightCentroid(Math.exp(-10))).toBeCloseTo(1 / 10, 3)
    // Continuous where the series hands over, and nearer the front the
    // denser the stretch.
    expect(lightCentroid(Math.exp(-0.04999))).toBeCloseTo(lightCentroid(Math.exp(-0.05001)), 5)
    let last = 0.5
    for (let tau = 0.01; tau < 30; tau *= 1.3) {
      const c = lightCentroid(Math.exp(-tau))
      expect(c).toBeLessThan(last + 1e-12)
      expect(c).toBeGreaterThan(0)
      last = c
    }
  })

  it('starts the march at the eye and draws what it meets short of the near plane there', () => {
    const clouds = createCloudLayer(createEclipseShadow('earth'), false)
    const inside = preprocess(clouds.material.fragmentShader, new Set(['FLIP_SIDED']))
    // From the eye on, not from the near plane, which only bounds the depth.
    expect(inside).not.toContain('max(sOuter, sNear)')
    expect(inside).toContain('float s = min(sOrigin + ds * float(i), sEnd);')
    expect(inside).toContain('vec3 q0 = eye + d * sOrigin;')
    expect(inside).toContain('vec4 col0 = cloudColumn(uv0, lod0,')
    // The same mip at the eye on every ray, a pixel's from outside the reach.
    expect(inside).toContain(': cloudEyeLod();')
    expect(inside).toContain('for (int i = max(iFirst, 1);')
    expect(inside.match(/cloudShadeAdd\(sideShade, sideLight,/g)).toHaveLength(3)
    expect(inside).toContain('max(eyeDist, sNear)')
    // With reduced motion, the fog's ease is read at the eye too.
    const ease = preprocess(clouds.material.vertexShader, new Set(['FLIP_SIDED', 'FOG_EASE']))
    expect(ease).toContain('cloudFogEase(vEye)')
    expect(ease).not.toContain('-vNear)')
    expect(ease).toContain('cloudColumn(uv, cloudEyeLod(), cloudTerrain(uv))')
    clouds.dispose()
  })
})

describe('cloud depth on either depth buffer (tides-zmw.9.3)', () => {
  it("writes its depth through depth.glsl, so reversed-Z's mapping holds", () => {
    const clouds = createCloudLayer(createEclipseShadow('earth'), false)
    const { vertexShader, fragmentShader } = clouds.material
    for (const reversed of [false, true]) {
      const defines = new Set(reversed ? ['FLIP_SIDED', 'USE_REVERSED_DEPTH_BUFFER'] : ['FLIP_SIDED'])
      const vertex = preprocess(vertexShader, defines)
      const fragment = preprocess(fragmentShader, defines)
      expect(vertex).toContain('vNear = isOrthographic ? 0.0 : viewDepthNear(projectionMatrix);')
      expect(vertex).toContain(`#define FRAG_DEPTH_NEAREST ${reversed ? '1.0' : '0.0'}`)
      expect(fragment).toContain(`#define FRAG_DEPTH_NEAREST ${reversed ? '1.0' : '0.0'}`)
      // The fog, at the eye, draws nearest at both sites (a miss and a hit).
      expect(fragment.match(/fogLight, 1\.0 - fogClear\), FRAG_DEPTH_NEAREST,/g)).toHaveLength(1)
      expect(fragment).toContain('fogged ? FRAG_DEPTH_NEAREST : viewDepthToFragDepth(projectionMatrix, z),')
      for (const source of [vertex, fragment]) {
        expect(source).not.toContain('projectionMatrix[3][2]')
        expect(source).not.toContain('0.5 + 0.5 * (projectionMatrix')
      }
      expect(fragment).not.toContain('#error')
    }
    // A log depth buffer would still be wrong.
    expect(preprocess(fragmentShader, new Set(['FLIP_SIDED', 'USE_LOGARITHMIC_DEPTH_BUFFER']))).toContain(
      '#error'
    )
    clouds.dispose()
  })
})

describe('cloud detail eroding only edges and grain (tides-tvr.3)', () => {
  const texel = 0.01
  // An octave's wavelength, coarsest first.
  const wave = (k: number) => (DETAIL_BASE_TEXELS * texel) / 2 ** k

  it('erodes every octave in full where the coarsest is no bigger than grain on screen', () => {
    const far = (texel * DETAIL_BASE_TEXELS) / DETAIL_GRAIN_PX
    for (const footprint of [far, 1.5 * far, 4 * far]) {
      const shown = detailOctaveWeights(footprint, texel, DETAIL_OCTAVES).length
      for (let k = 0; k < shown; k++) {
        for (const edge of [0, 0.3, 1]) expect(detailErosion(footprint, wave(k), edge)).toBe(1)
      }
    }
  })

  it('erodes a cloud\'s inside less, an octave large on screen least, and its edges in full', () => {
    for (const px of [DETAIL_HOLE_PX, 2 * DETAIL_HOLE_PX, 100]) {
      expect(detailErosion(wave(0) / px, wave(0), 0)).toBeCloseTo(DETAIL_INTERIOR, 9)
      expect(detailErosion(wave(0) / px, wave(0), 1)).toBe(1)
    }
    let last = 1
    for (let px = 1; px < 200; px *= 1.2) {
      for (const edge of [0, 0.5]) {
        const erode = detailErosion(wave(0) / px, wave(0), edge)
        expect(erode).toBeLessThanOrEqual(1)
        expect(erode).toBeGreaterThanOrEqual(DETAIL_INTERIOR)
      }
      const erode = detailErosion(wave(0) / px, wave(0), 0)
      expect(erode).toBeLessThanOrEqual(last)
      last = erode
    }
    // At the ship's lowest stop over the deck (tides-01v.2: a pixel 1/53 of
    // a texel), the two coarsest octaves erode a cloud's inside least.
    for (const k of [0, 1]) expect(detailErosion(texel / 53, wave(k), 0)).toBeCloseTo(DETAIL_INTERIOR, 9)
  })

  it('finds a cloud\'s edge by how many steps of its reads on it stops showing', () => {
    const fall = 0.1
    expect(detailEdge(CLOUD_MIN_ALPHA + DETAIL_EDGE_NEAR * fall, fall)).toBe(1)
    expect(detailEdge(CLOUD_MIN_ALPHA + 0.5 * fall, fall)).toBe(1)
    expect(detailEdge(CLOUD_MIN_ALPHA + DETAIL_EDGE_FAR * fall, fall)).toBe(0)
    const mid = detailEdge(CLOUD_MIN_ALPHA + 0.5 * (DETAIL_EDGE_NEAR + DETAIL_EDGE_FAR) * fall, fall)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    // Where the map is level, no edge; where it doesn't show, all edge.
    expect(detailEdge(0.3, 0)).toBe(0)
    expect(detailEdge(0, fall)).toBe(1)
    // A crisp rim through the hit: the whole fall within the reads.
    expect(detailEdge(0.3, detailFall(0, 0.6, 0.6, 0.6))).toBe(1)
  })

  it('reads a rim alike whichever way it faces', () => {
    // A cloud of opacity 0.5 that thins to nothing over a texel, across a
    // rim through the origin facing n; the edge at a point d texels inside,
    // from the four reads a step (3 texels) east, west, north and south.
    const step = 3
    const edgeAt = (n: [number, number], d: number) => {
      const map = (x: number, y: number) => 0.5 * THREE.MathUtils.clamp(0.5 - (x * n[0] + y * n[1]), 0, 1)
      const [x, y] = [-d * n[0], -d * n[1]]
      const at = (sx: number, sy: number) => map(x + sx * step, y + sy * step)
      return detailEdge(map(x, y), detailFall(at(1, 0), at(-1, 0), at(0, 1), at(0, -1)))
    }
    for (const angle of [0, 30, 45, 60, 90, 135]) {
      const a = (angle * Math.PI) / 180
      const n: [number, number] = [Math.cos(a), Math.sin(a)]
      for (const d of [0, 1, 2, 3, 4, 5]) {
        // The mirrored rim (facing -n) at the same depth inside it.
        expect(edgeAt(n, d)).toBeCloseTo(edgeAt([-n[0], -n[1]], d), 9)
      }
      // At the rim, edge; well inside, none.
      expect(edgeAt(n, 0)).toBe(1)
      expect(edgeAt(n, 6)).toBe(0)
    }
  })

  it('sizes the detail on screen as a share of the view, in any window and at any pixel ratio', () => {
    // A view 60 degrees tall, a scene unit from the deck: a reference pixel,
    // and the coarsest wave under DETAIL_GRAIN_PX of them.
    const angle = (cssHeight: number, dpr: number) => (2 * Math.tan(Math.PI / 6)) / (cssHeight * dpr)
    const far = 1 * angle(DETAIL_VIEW_PX, 1)
    const close = far / 40
    for (const cssHeight of [DETAIL_VIEW_PX, 1100, 1440]) {
      for (const dpr of [1, 2, 3]) {
        const scale = detailPixelScale(cssHeight * dpr)
        const pixel = (footprint: number) => (footprint / angle(DETAIL_VIEW_PX, 1)) * angle(cssHeight, dpr) * scale
        for (let k = 0; k < DETAIL_OCTAVES; k++) {
          expect(detailErosion(pixel(far), wave(k), 0)).toBeCloseTo(detailErosion(far, wave(k), 0), 12)
          expect(detailErosion(pixel(close), wave(k), 0)).toBeCloseTo(detailErosion(close, wave(k), 0), 12)
        }
      }
    }
    expect(DETAIL_BASE_TEXELS * texel).toBeLessThan(DETAIL_GRAIN_PX * far * 2)
  })

  for (const variant of [[], ['CLOUD_FLAT'], ['FLIP_SIDED'], ['CLOUD_FLAT', 'FLIP_SIDED']]) {
    it(`erodes by the edge at the hit, read only close up (${variant.join('+') || 'relief'})`, () => {
      const clouds = createCloudLayer(createEclipseShadow('earth'), variant.includes('CLOUD_FLAT'))
      const src = preprocess(clouds.material.fragmentShader, new Set(variant))
      const edge = src.indexOf('float edge = 1.0;')
      const call = src.indexOf('vec4 detail = cloudDetail(cloudFrame(p, uCloudShift), topFootprint, texel, edge);')
      expect(edge).toBeGreaterThan(0)
      expect(call).toBeGreaterThan(edge)
      expect(src).toContain('vec4 cloudDetail(vec3 p, float footprint, float texel, float edge)')
      expect(src).toContain('float spare = (1.0 - DETAIL_INTERIOR) * (1.0 - edge);')
      // Worked out only where the coarsest wave is large on screen, as a
      // share of the view, from the slope's reads.
      expect(src).toContain('DETAIL_GRAIN_PX * topFootprint * uPixelScale;')
      expect(src).toContain('float screenRatio = footprint * uPixelScale / wavelength;')
      expect(src.slice(edge, call)).toContain('if (edgeNear) {')
      expect(src.slice(edge, call)).toContain('vec2 fallEN = vec2(colE.x, colN.x);')
      expect(src.slice(edge, call)).toContain('cloudColumn(uv - hitE, lodHit, terrain).x')
      // A side is all edge; shaded elsewhere, the hit reads its own.
      expect(src.includes('edgeNear = edgeNear && !side;')).toBe(variant.includes('FLIP_SIDED'))
      expect(src.includes('if (sideLight > 0.0) {')).toBe(variant.includes('FLIP_SIDED'))
      // The slope reads where the hit is shaded, as before.
      expect(src).toContain('vec2 slope = RELIEF * vec2(colE.z - topC, colN.z - topC) / h;')
      clouds.dispose()
    })
  }

  it('takes the detail\'s sizes on screen from the view it draws', () => {
    const clouds = createCloudLayer(createEclipseShadow('earth'), false)
    const { material } = clouds
    expect(material.uniforms.uPixelScale.value).toBe(1)
    const renderer = {
      getCurrentViewport: (target: THREE.Vector4) => target.set(0, 0, 2880, 1600),
    } as unknown as THREE.WebGLRenderer
    material.onBeforeRender(renderer, new THREE.Scene(), new THREE.PerspectiveCamera(), new THREE.BufferGeometry(), new THREE.Mesh(), null)
    expect(material.uniforms.uPixelScale.value).toBe(1600 / DETAIL_VIEW_PX)
    clouds.dispose()
  })
})
