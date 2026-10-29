import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { neutralTypeTexture } from './cloudBlend'
import { SKY_VIEW_GLSL } from './skyView'
import { createGroundHaze, GROUND_HAZE_GLSL, groundHazeDepth, groundHazeWeights } from './groundHaze'
import { TYPED_TOPS_GLSL } from './cloudTypeGlsl'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import {
  CLOUD_GROUND_GLSL,
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
  GROUND_FADE,
  GROUND_SHADOW,
  GROUND_SHADOW_ADAPT_FROM,
  GROUND_SHADOW_ADAPT_SUN,
  GROUND_SHADOW_ADAPT_TOP,
  GROUND_SHADOW_UNDER,
  groundShadowStrength,
  MARCH_PHASE_FADE,
  MARCH_REFINE,
  MARCH_STEP,
  MARCH_STEPS,
  marchPhaseAfter,
  marchPhaseShare,
  marchStepFor,
} from './cloudShaders'
import {
  MAX_CLOUD_TOP_KM,
  CLOUD_CLEARANCE,
  cloudDeckAt,
  CLOUD_DECK_BAND_KM,
  EXAGGERATED_DECK,
  fogPath,
  TERRAIN_MAX_GREY,
  TRUE_DECK,
  CLOUD_FLAT_ALTITUDE,
  CLOUD_LAYER_TOP,
  CLOUD_MIN_ALPHA,
  CLOUD_UNITS_PER_KM,
  cloudPathClear,
  defaultTopKm,
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
  refineTopCrossing,
  type ShadeSum,
  shadeAdd,
  shadePlace,
  TERRAIN_DISPLACEMENT,
  type Vec3,
  cloudShape,
  cloudTopKm,
  maxTopKm,
  EARTH_RADIUS_KM,
} from '../cloud-layer'
import {
  CIRRUS_STRETCH,
  IR_COLD_KM,
  IR_DECK_OPACITY,
  IR_DEEP_KM,
  IR_THIN_OPACITY,
  IR_WARM_KM,
  IR_WEIGHT,
  NEUTRAL_LOOK,
  STRETCH_EDGES,
  TYPE_LOOKS,
  TYPED_TOPS_KM,
} from '../cloud-types'
import { sceneRadius } from '../planets'
import { EARTH_KM_PER_UNIT } from '../surface-handover'
import { clearLimbView, updateLimbView } from '../ship/limb-detail'
import { prefersReducedMotion } from '../ship/reduced-motion'
import {
  setEarthTerrain,
  TERRAIN_GREY_MARGIN,
  TERRAIN_MAP_SIZE,
  type TerrainFloor,
} from '../ship/terrain-floor'
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
      // The shell alone reads the cloud types (tides-tvr.4.2).
      expect(shader.fragmentShader).not.toContain('uCloudType')
      expect(shader.fragmentShader).not.toContain('cloudLook')
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
    else if ((m = t.match(/^#ifndef (\w+)/)))
      stack.push({ active: !defines.has(m[1]), taken: !defines.has(m[1]) })
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
        most = Math.max(most, marchSteps(span, MARCH_STEP, MARCH_STEPS, 0.999).length)
      }
    }
    expect(longest / MARCH_STEPS).toBeLessThanOrEqual(MARCH_STEP * 1.02)
    // The origin and MARCH_STEPS steps on, one more where the phase
    // (tides-ndh) pushes the last past them: the eye's read and the
    // shader's loop.
    expect(most).toBeLessThanOrEqual(MARCH_STEPS + 2)
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
        updateLimbView('earth', [earth], new THREE.Vector3(0, sea + 0.1, 0), 800, 60, camera)
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
  ].flatMap((v) => [v, [...v, 'CLOUD_TYPED']])) {
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
        'lookD',
        'lookL',
        'pDetail',
        'wStretch',
        'dz',
        'pDetail',
        'pass',
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
      // Over the ground the relief's hit takes the ground's haze (tides-d9f.10).
      expect(inside).toContain(
        flat
          ? 'cloudHazeFront(eye, d, length(pShade - eye), shell)'
          : 'cloudHazeHit(eye, d, length(pShade - eye), shell, hazeScale)'
      )
      // The atmosphere's own haze, shared with its shader.
      expect(inside).toContain('float columnAhead(')
      // Only the relief march has columns to stand in.
      expect(inside.includes('cloudFogEdge(colq, alt)')).toBe(!flat)
      // A camera in a cloud no longer sees a flat card.
      expect(inside).not.toContain('vec3(0.8)')
      // Both programs premultiply, as the material blends.
      expect(clouds.material.premultipliedAlpha).toBe(true)
      expect(outside).toContain('gl_FragColor.rgb *= gl_FragColor.a')
      expect(inside).toContain('gl_FragColor.rgb * (gl_FragColor.a - cover * share)')
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
        updateLimbView('earth', [earth], new THREE.Vector3(0, sea + 0.1, 0), 800, 60, camera)
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
      updateLimbView('earth', [earth], new THREE.Vector3(0, sea + 0.1, 0), 800, 60, camera)
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
    expect(inside).toContain('float s = min(sOrigin + ds * (float(i) - phase), sEnd);')
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
    expect(inside).toContain('float s = min(sOrigin + ds * (float(i) - phase), sEnd);')
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

  it('erodes as tides-tvr.3 did with the untyped look\'s interior', () => {
    for (const px of [1, 10, DETAIL_HOLE_PX, 100]) {
      for (const edge of [0, 0.4, 1]) {
        for (let k = 0; k < DETAIL_OCTAVES; k++) {
          const footprint = wave(0) / px
          expect(detailErosion(footprint, wave(k), edge, DETAIL_INTERIOR)).toBe(detailErosion(footprint, wave(k), edge))
        }
      }
    }
    // A lumpier look's inside erodes more, a smooth one's less.
    expect(detailErosion(wave(0) / 100, wave(0), 0, 0.45)).toBeCloseTo(0.45, 9)
    expect(detailErosion(wave(0) / 100, wave(0), 0, 0.45)).toBeGreaterThan(detailErosion(wave(0) / 100, wave(0), 0))
  })

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

describe('cloud tops holding still in flight (tides-ndh)', () => {
  // A field of tops with a knot every 0.0072 (about a texel of the
  // real-weather map, 2560 wide), linear between, along a ray. Flat ground:
  // over a step the Earth's curve is nothing to the field's.
  const TEXEL = 0.0072
  const hash = (k: number) => {
    const x = Math.sin(k * 12.9898 + 4.1414) * 43758.5453
    return x - Math.floor(x)
  }
  const field = (knot: (k: number) => number) => (x: number) => {
    const k = Math.floor(x / TEXEL)
    const t = x / TEXEL - k
    return knot(k) + (knot(k + 1) - knot(k)) * t
  }
  // Rays descending 5..20° from above tops 0.018..0.03 tall, over stretches
  // of the field further and further on, in dense cloud.
  const tops = field((k) => 0.018 + 0.012 * hash(k))
  const rays: ((s: number) => MarchSample)[] = []
  for (const deg of [5, 8, 12, 16, 20]) {
    for (const x0 of [0, 0.05, 0.11, 0.23, 0.37]) {
      const a = (deg * Math.PI) / 180
      rays.push((s) => ({ alt: 0.034 - s * Math.sin(a), base: 0.006, top: tops(x0 + s * Math.cos(a)), alpha: 0.6 }))
    }
  }
  const gap = (q: MarchSample) => q.alt - q.top

  // Where a ray first comes down to the tops, to a thousandth of a step,
  // then bisected; and whether it does so once within [s0, s1].
  const firstDown = (sampleAt: (s: number) => MarchSample, s0: number, s1: number) => {
    let lo = -1
    let downs = 0
    let was = gap(sampleAt(s0)) <= 0
    const n = Math.ceil(((s1 - s0) / MARCH_STEP) * 1000)
    for (let k = 1; k <= n; k++) {
      const s = s0 + ((s1 - s0) * k) / n
      const now = gap(sampleAt(s)) <= 0
      if (now && !was) {
        downs++
        if (lo < 0) lo = s0 + ((s1 - s0) * (k - 1)) / n
      }
      was = now
    }
    if (lo < 0) return null
    let hi = lo + (s1 - s0) / n
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2
      if (gap(sampleAt(mid)) <= 0) hi = mid
      else lo = mid
    }
    return { at: hi, once: downs === 1 }
  }

  // The top the march stops at over steps of MARCH_STEP from phase: as the
  // step found it, refined `iterations` times, and where the field itself
  // comes down to it where it does so once in the step.
  const topHit = (sampleAt: (s: number) => MarchSample, phase: number, iterations: number) => {
    let sPrev = 0
    let prev = sampleAt(sPrev)
    for (let i = 1; i < 400; i++) {
      const s = MARCH_STEP * (i - phase)
      if (s <= sPrev) continue
      const next = sampleAt(s)
      const found = marchCrossing(prev, next)
      if (found && found.side) return null
      if (found) {
        const len = s - sPrev
        const from = sPrev
        const w = refineTopCrossing(prev, next, (t) => sampleAt(from + t * len), iterations, found.until)
        const truth = firstDown(sampleAt, sPrev, s)
        return {
          hit: sPrev + w * len,
          coarse: sPrev + found.at * len,
          truth: truth?.once ? truth.at : null,
        }
      }
      sPrev = s
      prev = next
    }
    return null
  }
  const PHASES = Array.from({ length: 16 }, (_, p) => (p + 0.5) / 16)
  const sorted = (xs: number[]) => xs.sort((a, b) => a - b)
  const p95 = (xs: number[]) => sorted(xs)[Math.floor(0.95 * (xs.length - 1))]
  // Over the phases, how far apart (in steps) the hits on a ray land, where
  // the steps find the ray's first top (not one past a top they miss).
  const spreads = (iterations: number) =>
    rays.map((sampleAt) => {
      const first = firstDown(sampleAt, 0, 0.6)!.at
      const hits = PHASES.map((phase) => topHit(sampleAt, phase, iterations))
        .filter((h) => h != null && Math.abs(h.coarse - first) < MARCH_STEP)
        .map((h) => (iterations > 0 ? h!.hit : h!.coarse) / MARCH_STEP)
      return Math.max(...hits) - Math.min(...hits)
    })

  it('pins a top the march stops at to the field, wherever the steps fall', () => {
    const errors: number[] = []
    const coarse: number[] = []
    for (const sampleAt of rays) {
      for (const phase of PHASES) {
        const h = topHit(sampleAt, phase, MARCH_REFINE)
        if (h?.truth == null) continue
        errors.push(Math.abs(h.hit - h.truth) / MARCH_STEP)
        coarse.push(Math.abs(h.coarse - h.truth) / MARCH_STEP)
      }
    }
    expect(errors.length).toBeGreaterThan(150)
    // Each read halves where the crossing can lie.
    expect(Math.max(...errors)).toBeLessThanOrEqual(2 ** -MARCH_REFINE + 1e-9)
    expect(p95(errors)).toBeLessThan(0.1)
    expect(p95(coarse)).toBeGreaterThan(0.4)
    // No reads: the step's own crossing.
    for (const sampleAt of rays.slice(0, 5)) {
      const h = topHit(sampleAt, 0.3, 0)
      if (h) expect(h.hit).toBeCloseTo(h.coarse, 12)
    }
  })

  it('holds a top still as the steps slide along the ray in flight', () => {
    // How far a ray's top moves as the eye flies a step: the steps' phase
    // along the ray runs through a whole step.
    expect(p95(spreads(MARCH_REFINE))).toBeLessThan(0.15)
    expect(p95(spreads(0))).toBeGreaterThan(0.5)
  })

  it('never takes a refined top past where the step has the ray leave the cloud', () => {
    // A thin top: the ray is under it for a sliver of the step.
    const prev = { alt: 0.03, base: 0.006, top: 0.02, alpha: 0.6 }
    const next = { alt: 0.02, base: 0.006, top: 0.0201, alpha: 0.6 }
    const sampleAt = (w: number) => ({ ...prev, alt: 0.03 - 0.01 * w, top: 0.02 + 0.0001 * w })
    const hit = marchCrossing(prev, next)!
    expect(hit.side).toBe(false)
    expect(refineTopCrossing(prev, next, sampleAt, MARCH_REFINE, 0.9)).toBeLessThanOrEqual(0.9)
  })

  it('refines the top after the march, from the step it stopped in', () => {
    const clouds = createCloudLayer(createEclipseShadow('earth'), false)
    const inside = preprocess(clouds.material.fragmentShader, new Set(['FLIP_SIDED']))
    const outside = preprocess(clouds.material.fragmentShader, new Set())
    expect(inside).toContain(`#define MARCH_REFINE ${MARCH_REFINE}`)
    // Kept, as the march stops at a top, in its own state, which nothing
    // reads after it: nothing more carried step to step.
    expect(inside).toContain('altPrev = s;\n          underPrev = gap;\n          alphaPrev = sPrev + stepLen * until;\n          break;')
    expect(inside).toContain('if (depthHit == 0.0) {')
    expect(inside.match(/depthHit = 0\.0;/g)).toHaveLength(1)
    // Each step's read, and the refinement's, after the march.
    const calls = [...inside.matchAll(/[^\w ]\s*cloudMarchColumn\(|= cloudMarchColumn\(|- cloudMarchColumn\(/g)]
    expect(calls).toHaveLength(2)
    const march = inside.indexOf('for (int i = max(iFirst, 1);')
    const refine = inside.indexOf('for (int k = 0; k < MARCH_REFINE; k++)')
    expect(refine).toBeGreaterThan(march)
    expect(refine).toBeLessThan(inside.indexOf('if (sHit < 0.0 && sVeil >= 0.0)'))
    expect(outside).not.toContain('MARCH_REFINE; k++')
    clouds.dispose()
  })

  const sea = sceneRadius(12742000)
  const outer = sea + CLOUD_LAYER_TOP
  const eye: Vec3 = [0, sea + 0.05, 0]
  const along = (deg: number): Vec3 => {
    const a = (deg * Math.PI) / 180
    return [Math.cos(a), Math.sin(a), 0]
  }
  const plus = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]

  it('steps a phase of a step short of whole steps from the eye, the same on every ray', () => {
    let checked = 0
    for (const phase of [0.25, 0.7]) {
      for (let deg = -60; deg <= 60; deg += 0.5) {
        const steps = marchSteps(marchSpanFromEye(eye, along(deg), sea, outer)!, MARCH_STEP, MARCH_STEPS, phase)
        if (Math.abs(steps[3] - steps[2] - MARCH_STEP) > 1e-12) continue
        // The first at the eye; the rest (but the last, cut short) a whole
        // number of steps on from phase short of the eye's step.
        expect(steps[0]).toBe(0)
        for (const [i, s] of steps.slice(1, -1).entries()) expect(s).toBeCloseTo((i + 1 - phase) * MARCH_STEP, 12)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(300)
    const clouds = createCloudLayer(createEclipseShadow('earth'), false)
    const inside = preprocess(clouds.material.fragmentShader, new Set(['FLIP_SIDED']))
    expect(inside).toContain('flat varying float vMarchPhase;')
    expect(inside).toContain('float phase = vMarchPhase;')
    // A first step the phase made short reads the cloud at the eye's mip.
    expect(inside).toContain('lod = mix(cloudEyeLod(), lod, min(s / ds, 1.0));')
    expect(inside).toContain('ceil(span / ds + phase - 1e-3), 1.0, float(MARCH_STEPS + 1))')
    expect(inside).toContain('for (int i = max(iFirst, 1); i <= MARCH_STEPS + 1; i++)')
    // The ceiling's skips count the same steps.
    expect(inside).toContain('int(floor((sFirst - sOrigin) / ds + phase)) - 1')
    expect(inside).toContain('int(ceil((sLast - sOrigin) / ds + phase)) + 1')
    expect(preprocess(clouds.material.fragmentShader, new Set())).not.toContain('uMarchPhase')
    clouds.dispose()
  })

  it('keeps the steps along the view where they were over the clouds in forward flight', () => {
    for (const deg of [-40, -8, 0, 12]) {
      const d = along(deg)
      let phase = 0.37
      let from = eye
      const before = marchSteps(marchSpanFromEye(from, d, sea, outer)!, MARCH_STEP, MARCH_STEPS, phase)
        .slice(1, -1)
        .map((s) => plus(from, d, s))
      // A few frames' flight along the view, short of a step and past one.
      for (const move of [0.0013, 0.004, 0.0091, 0.0007]) {
        const to = plus(from, d, move)
        phase = marchPhaseAfter(phase, from, to, d, MARCH_STEP)
        expect(phase).toBeGreaterThanOrEqual(0)
        expect(phase).toBeLessThan(1)
        from = to
      }
      const after = marchSteps(marchSpanFromEye(from, d, sea, outer)!, MARCH_STEP, MARCH_STEPS, phase)
        .slice(1, -1)
        .map((s) => plus(from, d, s))
      // Every step but those passed and the last is a step of before's.
      let shared = 0
      for (const p of after.slice(1, -1)) {
        const gap = Math.min(...before.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])))
        expect(gap).toBeLessThan(1e-9)
        shared++
      }
      expect(shared).toBeGreaterThanOrEqual(2)
    }
    // Sideways, the phase stays.
    expect(marchPhaseAfter(0.4, eye, plus(eye, [0, 0, 1], 0.02), along(10), MARCH_STEP)).toBeCloseTo(0.4, 12)
  })

  it('moves the phase on with the ship camera along its view, and never as it turns', () => {
    const clouds = createCloudLayer(createEclipseShadow('earth'), false)
    clouds.uniforms.uSeaLevel.value = sea
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), clouds.material)
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.001, 100)
    const phase = () => clouds.material.uniforms.uMarchPhase.value as number
    const at = new THREE.Vector3(0, sea + clouds.shellAltitude - 0.01, 0)
    const look = (yaw: number, pitch: number) => {
      camera.position.copy(at)
      camera.rotation.set(pitch, yaw, 0, 'YXZ')
      camera.updateMatrixWorld()
      clouds.faceCamera(mesh, camera)
    }
    try {
      const earth = { key: 'earth', position: new THREE.Vector3(), radius: sea }
      updateLimbView('earth', [earth], new THREE.Vector3(0, sea + 0.1, 0), 800, 60, camera)
      look(0, 0)
      expect(clouds.material.side).toBe(THREE.BackSide)
      const start = phase()
      // Turning in place: no step moves.
      for (const [yaw, pitch] of [[0.4, 0], [0.4, -0.3], [-1.2, 0.2]]) {
        look(yaw, pitch)
        expect(phase()).toBe(start)
      }
      // Forward along the view, a fifth of a step.
      look(0, 0)
      const f = camera.getWorldDirection(new THREE.Vector3())
      at.addScaledVector(f, 0.2 * MARCH_STEP)
      look(0, 0)
      expect(phase()).toBeCloseTo((start + 0.2) % 1, 9)
      // Another camera, out of reach, renders between: the phase holds, and
      // the ship camera's next frame moves it on from where it was.
      const ortho = new THREE.OrthographicCamera()
      ortho.position.set(0, sea + 5, 0)
      ortho.updateMatrixWorld()
      clouds.faceCamera(mesh, ortho)
      expect(phase()).toBeCloseTo((start + 0.2) % 1, 9)
      at.addScaledVector(f, 0.5 * MARCH_STEP)
      look(0, 0)
      expect(phase()).toBeCloseTo((start + 0.7) % 1, 9)
    } finally {
      clearLimbView()
      clouds.dispose()
    }
  })

  it('leaves the phase alone on the flat shell, which does not march', () => {
    const clouds = createCloudLayer(createEclipseShadow('earth'), true)
    clouds.uniforms.uSeaLevel.value = sea
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), clouds.material)
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.001, 100)
    try {
      const earth = { key: 'earth', position: new THREE.Vector3(), radius: sea }
      updateLimbView('earth', [earth], new THREE.Vector3(0, sea + 0.1, 0), 800, 60, camera)
      for (const y of [0, 0.003, 0.006]) {
        camera.position.set(0.001, sea + clouds.shellAltitude - 0.005 - y, 0)
        camera.lookAt(1, sea, 0)
        camera.updateMatrixWorld()
        clouds.faceCamera(mesh, camera)
      }
      expect(clouds.material.uniforms.uMarchPhase.value).toBe(0)
    } finally {
      clearLimbView()
      clouds.dispose()
    }
  })

  it('fades the phase out as the eye goes into a cloud, once a draw, in the vertex stage', () => {
    for (const flat of [false, true]) {
      const clouds = createCloudLayer(createEclipseShadow('earth'), flat)
      const defines = new Set(['FLIP_SIDED', ...(flat ? ['CLOUD_FLAT'] : [])])
      const vertex = preprocess(clouds.material.vertexShader, defines)
      expect(vertex).toContain('flat varying float vMarchPhase;')
      if (flat) {
        // The flat shell doesn't march: nothing read.
        expect(vertex).toContain('vMarchPhase = 0.0;')
        expect(vertex).not.toContain('cloudFogStep(vEye)')
      } else {
        // By the fog's extinction over a step at the eye, as the march's
        // start reads it (cloudEyeLod()), with or without reduced motion's
        // fog ease (marchPhaseShare()).
        const [a, b] = MARCH_PHASE_FADE.map((x) => x.toFixed(6))
        for (const v of [vertex, preprocess(clouds.material.vertexShader, new Set([...defines, 'FOG_EASE']))]) {
          expect(v).toContain(`* (1.0 - smoothstep(${a}, ${b}, cloudFogStep(vEye)));`)
          expect(v).toContain('cloudColumn(uv, cloudEyeLod(), cloudTerrain(uv))')
          // The live step (uMarchStep, tides-d9f.10).
          expect(v).toContain('cloudFogDensity(col) * cloudFogEdge(col, r - uSeaLevel) * uMarchStep;')
        }
      }
      // From outside the reach the vertex stage reads nothing.
      const outside = preprocess(clouds.material.vertexShader, new Set(flat ? ['CLOUD_FLAT'] : []))
      expect(outside).not.toContain('vMarchPhase')
      expect(outside).not.toContain('uCloudMap')
      // Nor does the ground's shadow, which shares the field.
      const shader = phongShader()
      clouds.groundPatch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
      expect(shader.vertexShader + shader.fragmentShader).not.toContain('MarchPhase')
      expect(shader.fragmentShader).not.toContain('cloudFogStep')
      clouds.dispose()
    }
  })

  it('keeps the phase in clear air, veils and soft edges, and drops it in dense fog', () => {
    // A column based at 0.012 and topped at 0.036, the eye at alt in it.
    const share = (alpha: number, alt: number) =>
      marchPhaseShare(fogExtinction(alpha, 0.012, 0.036, alt) * MARCH_STEP)
    // Clear air, a gap, over a top and under a base.
    for (const [alpha, alt] of [[0.9, 0.04], [0.9, 0.01], [0.01, 0.024]]) expect(share(alpha, alt)).toBe(1)
    // Veils and thicker cloud, deep in them: a step's light gets through.
    for (const alpha of [0.05, 0.17, 0.3, 0.5, 0.8]) expect(share(alpha, 0.024)).toBe(1)
    // Dense cloud, deep in it: the fog goes opaque within a step.
    expect(share(0.99, 0.024)).toBe(0)
    // Its soft top, and the phase falls as the fog thickens.
    let last = 1
    for (let alt = 0.0365; alt >= 0.024; alt -= 0.0005) {
      const s = share(0.99, alt)
      expect(s).toBeLessThanOrEqual(last + 1e-12)
      last = s
    }
    expect(last).toBe(0)
    // As the shader takes it (smoothstep of the bounds).
    const [a, b] = MARCH_PHASE_FADE
    expect(marchPhaseShare(a)).toBe(1)
    expect(marchPhaseShare(b)).toBe(0)
    expect(marchPhaseShare((a + b) / 2)).toBeCloseTo(0.5, 12)
  })

  it('keeps the phase under a whole step, as a float too', () => {
    const eye: Vec3 = [0, sea + 0.05, 0]
    const d = along(10)
    // A hair back along the view from a phase of 0, and a phase a hair under 1.
    expect(marchPhaseAfter(0, eye, plus(eye, d, -1e-20), d, MARCH_STEP)).toBe(0)
    expect(marchPhaseAfter(1 - 1e-9, eye, eye, d, MARCH_STEP)).toBe(0)
    for (let k = 0; k < 1000; k++) {
      const p = marchPhaseAfter(k / 1000, eye, plus(eye, d, (k - 500) * 1e-7), d, MARCH_STEP)
      expect(Math.fround(p)).toBeLessThan(1)
      expect(p).toBeGreaterThanOrEqual(0)
    }
  })

  it('moves the phase with the eye among the clouds, whatever the turn of the mesh and their drift', () => {
    const clouds = createCloudLayer(createEclipseShadow('earth'), false)
    clouds.uniforms.uSeaLevel.value = sea
    clouds.uniforms.uCloudShift.value = 0.137
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), clouds.material)
    mesh.rotation.set(0.3, 1.1, -0.2)
    mesh.updateMatrixWorld()
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.001, 100)
    const phase = () => clouds.material.uniforms.uMarchPhase.value as number
    const at = new THREE.Vector3(0.01, sea + clouds.shellAltitude - 0.01, 0.02)
    const frame = () => {
      camera.position.copy(at)
      camera.rotation.set(-0.1, 0.8, 0, 'YXZ')
      camera.updateMatrixWorld()
      clouds.faceCamera(mesh, camera)
    }
    try {
      const earth = { key: 'earth', position: new THREE.Vector3(), radius: sea }
      updateLimbView('earth', [earth], new THREE.Vector3(0, sea + 0.1, 0), 800, 60, camera)
      frame()
      expect(clouds.material.side).toBe(THREE.BackSide)
      const start = phase()
      const f = camera.getWorldDirection(new THREE.Vector3())
      // Along the view, 0.3 of a step: the phase moves on by as much.
      at.addScaledVector(f, 0.3 * MARCH_STEP)
      frame()
      expect(phase()).toBeCloseTo((start + 0.3) % 1, 9)
      // Across it: none.
      const across = new THREE.Vector3(0, 1, 0).cross(f).normalize()
      at.addScaledVector(across, 0.4 * MARCH_STEP)
      frame()
      expect(phase()).toBeCloseTo((start + 0.3) % 1, 9)
    } finally {
      clearLimbView()
      clouds.dispose()
    }
  })
})

describe('cloud look by type (tides-tvr.4.2)', () => {
  const variants = [
    [],
    ['CLOUD_FLAT'],
    ['FLIP_SIDED'],
    ['CLOUD_FLAT', 'FLIP_SIDED'],
    ['FLIP_SIDED', 'FOG_EASE'],
  ]
  const LOOK_WORDS = ['uCloudType', 'cloudLook', 'lookD', 'lookL', 'wStretch', 'CLOUD_STRETCH', 'cloudTypeShares']

  for (const variant of variants) {
    const name = variant.join('+') || 'relief'
    it(`draws untyped clouds with tides-tvr.3's program itself (${name})`, () => {
      const clouds = createCloudLayer(createEclipseShadow('earth'), variant.includes('CLOUD_FLAT'))
      const src = preprocess(clouds.material.fragmentShader, new Set(variant)).replace(/\/\/.*$/gm, '')
      for (const word of LOOK_WORDS) expect(src).not.toContain(word)
      expect(src).toContain('vec4 cloudDetail(vec3 p, float footprint, float texel, float edge) {')
      expect(src).toContain('float spare = (1.0 - DETAIL_INTERIOR) * (1.0 - edge);')
      expect(src).toContain('vec2 slope = RELIEF * vec2(colE.z - topC, colN.z - topC) / h;')
      expect(src).toContain('vec4 detail = cloudDetail(cloudFrame(p, uCloudShift), topFootprint, texel, edge);')
      expect(src).toContain('float alpha = clamp(col.x + DETAIL_EDGE * detail.x * 4.0 * col.x * (1.0 - col.x), 0.0, 1.0);\n  if (alpha < CLOUD_MIN_ALPHA) {')
      expect(src).toContain('* DETAIL_RELIEF * ')
      expect(src).toContain('vec3 radiance = cloudRadiance(upShade, n, d, alpha, depth, cloudKm(colShade.z, colShade.y), occ,')
      clouds.dispose()
    })

    it(`reads the look once, after the march, its refinement and the edge (${name})`, () => {
      const clouds = createCloudLayer(createEclipseShadow('earth'), variant.includes('CLOUD_FLAT'))
      const typed = new Set([...variant, 'CLOUD_TYPED'])
      const src = preprocess(clouds.material.fragmentShader, typed)
      const main = src.slice(src.indexOf('void main()'))
      const look = main.indexOf('cloudLook(')
      expect(look).toBeGreaterThan(0)
      expect(main.indexOf('cloudLook(', look + 1)).toBe(-1)
      // Past the march (and from inside, the top's refinement, so the look
      // is the pinned top's), the miss of a hit that doesn't show and the
      // edge, whose reads it would hold registers across; ahead of all it sets.
      if (variant.includes('FLIP_SIDED') && !variant.includes('CLOUD_FLAT')) {
        expect(look).toBeGreaterThan(main.indexOf('if (depthHit == 0.0) {'))
      }
      expect(look).toBeGreaterThan(main.indexOf('if (col.x < CLOUD_MIN_ALPHA) {'))
      expect(look).toBeGreaterThan(main.indexOf('if (edgeNear) {'))
      // The tops' rise is read where the slope was, tilted once the look is.
      const dz = main.indexOf('vec2 dz = vec2(colE.z - topC, colN.z - topC);')
      expect(dz).toBeGreaterThan(0)
      expect(dz).toBeLessThan(main.indexOf('if (edgeNear) {'))
      expect(main.indexOf('vec2 slope = lookD.x * dz / h;')).toBeGreaterThan(look)
      // The march, the refinement and the fog never see the types.
      const before = main.slice(0, main.indexOf('vec4 lookD;')).replace(/\/\/.*$/gm, '')
      for (const word of LOOK_WORDS) expect(before).not.toContain(word)
      // The grid is read in cloudLook() only, at its own texel, and only
      // when the map is typed and the texel confident; the map's heights a
      // mip down at most, so the type doesn't change with the zoom.
      expect(src.match(/\buCloudType\b/g)).toHaveLength(2)
      const fn = src.slice(src.indexOf('void cloudLook('))
      expect(fn.indexOf('if (uCloudTyped < 0.5) return;')).toBeLessThan(fn.indexOf('textureLod(uCloudType'))
      expect(fn.indexOf('if (t.a <= 0.0) return;')).toBeLessThan(fn.indexOf('textureLod(uCloudMap'))
      expect(fn).toContain('uCloudMeasured > 0.5 ? textureLod(uCloudMap, st, min(lod, 1.0)).rgb : vec3(0.0)')
      // Never in the vertex stage, where the march's phase must be the same
      // at every vertex.
      const vertex = preprocess(clouds.material.vertexShader, typed)
      expect(vertex).not.toMatch(/uCloudType|cloudLook|lookD|lookL/)
      // Every knob in its place: one call of the detail, a pass for each noise.
      expect(src).toContain('vec4 cloudDetail(vec3 p, float footprint, float texel, float edge, float interior) {')
      expect(src.replace(/\/\/.*$/gm, '').match(/cloudDetail\(/g)).toHaveLength(2)
      expect(src).toContain('float spare = (1.0 - interior) * (1.0 - edge);')
      expect(main).toContain('vec4 pass = cloudDetail(pDetail * scale, topFootprint, texel, edge, lookD.y);')
      expect(main).toContain('vec3 scale = i == 0 ? vec3(1.0) : CLOUD_STRETCH;')
      expect(main).toContain('pass.yzw *= scale;')
      expect(main.includes('wStretch = step(0.5, wStretch);')).toBe(variant.includes('CLOUD_FLAT'))
      expect(main).toMatch(/smoothstep\(STRETCH_FROM, STRETCH_TO, lookL\.x\)\s+\* \(1\.0 - smoothstep\(STRETCH_POLE_FROM, STRETCH_POLE_TO, abs\(up\.y\)\)\)/)
      // tides-tvr.3's erosion as it was, then the look's past it (a hole
      // stays one), and the opacity's scale, before a faint hit is dropped.
      const erosion = main.indexOf('float alpha = clamp(col.x + DETAIL_EDGE * detail.x * 4.0 * col.x * (1.0 - col.x), 0.0, 1.0);')
      const own = main.indexOf('alpha = (alpha > 0.0 ? clamp(alpha + (lookD.z - DETAIL_EDGE) / DETAIL_EDGE * (alpha - col.x), 0.0, 1.0) : 0.0)\n    * lookL.w;')
      expect(erosion).toBeGreaterThan(look)
      expect(own).toBeGreaterThan(erosion)
      expect(own).toBeLessThan(main.indexOf('if (alpha < CLOUD_MIN_ALPHA) {'))
      expect(main).toContain('* lookD.w * ')
      const occ = main.indexOf('occ *= lookL.y;\n  depth *= lookL.z;')
      expect(occ).toBeGreaterThan(main.indexOf('for (int j = 1; j <= SHADOW_STEPS; j++) {'))
      expect(occ).toBeLessThan(main.indexOf('vec3 radiance = cloudRadiance('))
      clouds.dispose()
    })
  }

  it('draws untyped clouds with tides-tvr.3\'s own numbers', () => {
    const clouds = createCloudLayer(createEclipseShadow('earth'), false)
    const src = preprocess(clouds.material.fragmentShader, new Set(['CLOUD_TYPED']))
    const define = (name: string) => Number(src.match(new RegExp(`#define ${name} (\\S+)`))![1])
    expect(define('RELIEF')).toBe(NEUTRAL_LOOK.relief)
    expect(define('DETAIL_INTERIOR')).toBe(NEUTRAL_LOOK.interior)
    expect(define('DETAIL_EDGE')).toBe(NEUTRAL_LOOK.edge)
    expect(define('DETAIL_RELIEF')).toBe(NEUTRAL_LOOK.grain)
    expect(NEUTRAL_LOOK.interior).toBe(DETAIL_INTERIOR)
    expect(src).toContain('#define LOOK_NEUTRAL_D vec4(RELIEF, DETAIL_INTERIOR, DETAIL_EDGE, DETAIL_RELIEF)')
    expect(src).toContain('#define LOOK_NEUTRAL_L vec4(0.000000, 1.000000, 1.000000, 1.000000)')
    // The kinds' knobs, a column each in the grid's order.
    const matrix = (name: string) =>
      src.match(new RegExp(`const mat4 ${name} = mat4\\(([^;]*)\\);`))![1].match(/-?\d+\.\d+/g)!.map(Number)
    const kinds = [TYPE_LOOKS.cirrus, TYPE_LOOKS.cumulus, TYPE_LOOKS.alto, TYPE_LOOKS.stratus]
    expect(matrix('LOOK_D')).toEqual(kinds.flatMap((k) => [k.relief, k.interior, k.edge, k.grain]))
    expect(matrix('LOOK_L')).toEqual(kinds.flatMap((k) => [k.stretch, k.occ, k.under, k.alpha]))
    expect(src).toContain(`#define CLOUD_STRETCH vec3(${(1 / CIRRUS_STRETCH).toFixed(6)}, 1.0, ${(1 / CIRRUS_STRETCH).toFixed(6)})`)
    expect(define('STRETCH_FROM')).toBe(STRETCH_EDGES[0])
    expect(define('STRETCH_TO')).toBe(STRETCH_EDGES[1])
    clouds.dispose()
  })

  it('refines the shares by the infrared as refineWithIr() does', () => {
    const clouds = createCloudLayer(createEclipseShadow('earth'), false)
    const src = preprocess(clouds.material.fragmentShader, new Set(['CLOUD_TYPED']))
    const fn = src.slice(src.indexOf('vec4 cloudTypeShares('), src.indexOf('void cloudLook('))
    const f = (x: number) => x.toFixed(6)
    // The grid's shares, premultiplied by its confidence, divided back
    // (tides-tvr.4.4); its callers read it only where that is over 0.
    expect(fn).toContain('vec3 shares = min(t.rgb / t.a, vec3(1.0));')
    expect(fn).toContain('vec4 s = vec4(shares, max(1.0 - shares.r - shares.g - shares.b, 0.0));')
    // Each rule's edges, from ../cloud-types.ts, and the rule itself.
    for (const line of [
      `float w = ${f(IR_WEIGHT)} * raw.b;`,
      `float km = raw.r * ${f(MAX_CLOUD_TOP_KM)};`,
      `float cold = smoothstep(${f(IR_COLD_KM[0])}, ${f(IR_COLD_KM[1])}, km);`,
      `float deep = smoothstep(${f(IR_DEEP_KM[0])}, ${f(IR_DEEP_KM[1])}, km);`,
      `float warm = 1.0 - smoothstep(${f(IR_WARM_KM[0])}, ${f(IR_WARM_KM[1])}, km);`,
      `float thin = 1.0 - smoothstep(${f(IR_THIN_OPACITY[0])}, ${f(IR_THIN_OPACITY[1])}, raw.g);`,
      'float toLow = warm * (1.0 - thin);',
      `float deck = smoothstep(${f(IR_DECK_OPACITY[0])}, ${f(IR_DECK_OPACITY[1])}, raw.g);`,
      'vec4 lowSplit = mix(low > 1e-3 ? vec4(0.0, s.y, 0.0, s.w) / low : vec4(0.0, 0.0, 0.0, 1.0),\n    vec4(0.0, 0.0, 0.0, 1.0), deck);',
      'vec4 target = cold * thin * vec4(1.0, 0.0, 0.0, 0.0) + deep * (1.0 - thin) * vec4(0.0, 1.0, 0.0, 0.0)\n    + toLow * lowSplit;',
      'return s * (1.0 - w * (cold * thin + deep * (1.0 - thin) + toLow)) + w * target;',
    ]) {
      expect(fn).toContain(line)
    }
    clouds.dispose()
  })

  it('shows a map with its type grid, and draws typed maps with their own program', () => {
    for (const flat of [false, true]) {
      const clouds = createCloudLayer(createEclipseShadow('earth'), flat)
      const { uniforms, material } = clouds
      // Untyped to start, with the neutral grid, shared with the shell.
      expect(uniforms.uCloudTyped.value).toBe(0)
      expect(uniforms.uCloudType.value).toBe(neutralTypeTexture())
      expect(material.uniforms.uCloudTyped).toBe(uniforms.uCloudTyped)
      expect(material.uniforms.uCloudType).toBe(uniforms.uCloudType)
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.001, 100)
      camera.position.set(0, 10, 0)
      camera.updateMatrixWorld()
      clouds.faceCamera(mesh, camera)
      expect(material.defines).not.toHaveProperty('CLOUD_TYPED')

      // The typed columns too (tides-tvr.4.9), neutral to start: zeros,
      // untyped.
      expect(uniforms.uCloudTops.value).toBe(neutralTypeTexture())
      expect(material.uniforms.uCloudTops).toBe(uniforms.uCloudTops)

      const map = new THREE.Texture()
      const types = { grid: new THREE.Texture(), tops: new THREE.Texture() }
      clouds.setMap(map, true, types)
      expect(uniforms.uCloudMap.value).toBe(map)
      expect(uniforms.uCloudMeasured.value).toBe(1)
      expect(uniforms.uCloudMaxKm.value).toBe(MAX_CLOUD_TOP_KM)
      expect(uniforms.uCloudType.value).toBe(types.grid)
      expect(uniforms.uCloudTops.value).toBe(types.tops)
      expect(uniforms.uCloudTyped.value).toBe(1)
      let version = material.version
      clouds.faceCamera(mesh, camera)
      expect(material.defines).toHaveProperty('CLOUD_TYPED')
      expect(material.version).toBeGreaterThan(version)
      // Once a frame: no new program while the map stays typed.
      version = material.version
      clouds.faceCamera(mesh, camera)
      expect(material.version).toBe(version)

      clouds.setMap(map, false, null)
      expect(uniforms.uCloudMeasured.value).toBe(0)
      expect(uniforms.uCloudType.value).toBe(neutralTypeTexture())
      expect(uniforms.uCloudTops.value).toBe(neutralTypeTexture())
      expect(uniforms.uCloudTyped.value).toBe(0)
      clouds.faceCamera(mesh, camera)
      expect(material.defines).not.toHaveProperty('CLOUD_TYPED')
      expect(material.version).toBeGreaterThan(version)
      // The ship's warm-up links the typed program ahead.
      expect(material.userData.warmDefines).toEqual(['CLOUD_TYPED'])
      clouds.dispose()
    }
  })
})

describe('typed tops in the march (tides-tvr.4.3)', () => {
  // SHA-256 of each untyped program as three builds it (vertex, a newline,
  // fragment, after the shader's own conditionals), and of the ground's and
  // the tiles' cloud shadow as injected, at tides-tvr.4.2 (404f3eb), and
  // unchanged by tides-zmw.21, which took the live-relief programs away: the
  // typed tops are the typed program's alone. The back faces' (from inside,
  // where a cloud lays the haze in front of it over itself) regenerated at
  // tides-34q, whose haze from inside is the sky's (haze.glsl hazeSky()),
  // and at tides-d9f.3, which declares its cover (hazeCover()) beside it and
  // has the clouds take it, and at tides-zmw.17, which only reworded a comment
  // in cloudHazeFront(). The back faces' with reduced motion (FOG_EASE)
  // regenerated at tides-tvr.10, whose easing fog shows as the side it
  // eases from did: at uOpacity, under the haze in front of it (the flat
  // sheet's fog never eases, so only its text changed); the programs
  // without FOG_EASE are as they were. The relief programs' and the relief
  // ground shadow's regenerated at tides-d9f.10: the deck's clearance and km
  // scale are uniforms on the relief path; the flat ones are as they were.
  // tides-d9f.10 B: deck-sized lengths (fog path, ground fade, shadow steps,
  // march step) follow the live deck; again only the relief ones regenerated.
  // tides-d9f.10: a cloud on a ray that ends on the ground takes the ground's
  // haze for the air in front of it (cloudHazeHit(), the relief back faces'),
  // the colour mixed by each side's share across the sea horizon's band.
  const UNTYPED_SHELL_SHA256: Record<string, string> = {
    'relief-full-front-noease': 'c469d704a652aa84704d52157834e5b14664a8abdda9ed23c6e341df5f5cd6be',
    'relief-full-front-ease': 'c469d704a652aa84704d52157834e5b14664a8abdda9ed23c6e341df5f5cd6be',
    'relief-full-back-noease': 'ee1445c154828932346a69a09697508e5a61b9f13f29bd86ae7da46be88e444a',
    'relief-full-back-ease': 'cab1e55312942351b72563eb27097c72f076e1ef07221fda107500c6e18443b7',
    'flat-full-front-noease': '8aad56312c3414dacf7297ae3cd34429a05bfc25e565f7a1b7c07cf64168cb63',
    'flat-full-front-ease': '8aad56312c3414dacf7297ae3cd34429a05bfc25e565f7a1b7c07cf64168cb63',
    'flat-full-back-noease': '3a79db74cfaf67b5d9e8669562c686a9a09d1d8cea9c02036d6cd8de28049129',
    'flat-full-back-ease': '87b1586468186a76d84a8a944b70ea30effd6801014ce53242a31bece750311a',
  }
  const GROUND_SHADOW_SHA256: Record<string, string> = {
    'relief-full': '3cee3553208d7322e96f5507d89d81fa32e04bf000460b8126a86f7295576768',
    'flat-full': '58c11faac7965ebe03d6804b82152c11ab78ce3884eaa3d605f35c9e65f3a5f4',
  }
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
  // The sky-view table's uniforms (tides-34q.2), declared with the haze in
  // the programs from inside: taken out, and its read at level 0
  // (tides-d9f.4: the sea reads it inside a branch) put back as it was, so
  // the rest is pinned.
  const TABLE_READ = ['textureLod(uSkyView, (0.5 + uv * (uSkyViewSize - 1.0)) / uSkyViewSize, 0.0)', 'texture(uSkyView, (0.5 + uv * (uSkyViewSize - 1.0)) / uSkyViewSize)']
  const withoutSkyView = (fragment: string) => {
    const declared = preprocess(SKY_VIEW_GLSL, new Set()) + '\n'
    expect(fragment.split(declared).length).toBeLessThanOrEqual(2)
    expect(fragment.split(TABLE_READ[0]).length).toBe(fragment.split(declared).length)
    return fragment.replace(declared, '').replace(TABLE_READ[0], TABLE_READ[1])
  }
  const TYPED_WORDS = /TYPED_|LIFTED_THICKNESS|CLOUD_TYPED|uCloudTops/
  // The low tier's flat sheet from inside, entered as decided at the eye
  // (tides-tvr.11): put back as it was, so the rest is pinned.
  const FLAT_ENTRY = [
    `  // where the ray leaves: decided at the eye, not the near plane
  // (tides-tvr.11), whose edge would otherwise cut a line between the two
  // that moves as the camera turns. A hit short of the near plane is drawn
  // at it (below).
  float sFlat = sIn > 0.0 ? sIn : sOut;
  if (sFlat <= 0.0) CLOUD_MISS;`,
    `  // where the ray leaves.
  float sFlat = sIn >= sNear ? sIn : sOut;
  if (sFlat < sNear) CLOUD_MISS;`,
  ]
  const asBeforeFlatEntry = (fragment: string) => {
    expect(fragment.split(FLAT_ENTRY[0]).length).toBeLessThanOrEqual(2)
    return fragment.replace(FLAT_ENTRY[0], FLAT_ENTRY[1])
  }

  for (const flat of [false, true]) {
    const name = `${flat ? 'flat' : 'relief'}-full`
    it(`leaves the untyped programs exactly as tides-tvr.4.2 left them (${name})`, () => {
      const clouds = createCloudLayer(createEclipseShadow('earth'), flat)
      const { vertexShader, fragmentShader } = clouds.material
      for (const side of ['front', 'back']) {
        for (const ease of ['noease', 'ease']) {
          const defines = new Set([
            ...(flat ? ['CLOUD_FLAT'] : []),
            ...(side === 'back' ? ['FLIP_SIDED'] : []),
            ...(ease === 'ease' ? ['FOG_EASE'] : []),
          ])
          const vertex = preprocess(vertexShader, defines)
          const fragment = asBeforeFlatEntry(withoutSkyView(preprocess(fragmentShader, defines)))
          expect(vertex + fragment).not.toMatch(TYPED_WORDS)
          expect(sha256(vertex + '\n' + fragment), `${name}-${side}-${ease}`).toBe(
            UNTYPED_SHELL_SHA256[`${name}-${side}-${ease}`]
          )
        }
      }
      // The ground's shadow, the globe's and the tiles', is untyped
      // whatever the map, and its text is as it was but for its strength,
      // a uniform since tides-l0z.
      const head = CLOUD_GROUND_GLSL.head(flat)
      expect(head).not.toMatch(TYPED_WORDS)
      const asDefine = head
        .replace(
          '// groundShadowStrength() for the camera drawn (faceCamera()).\nuniform float uGroundShadow;',
          `#define GROUND_SHADOW ${GROUND_SHADOW.toFixed(1)}`
        )
        .replace('uGroundShadow * occ', 'GROUND_SHADOW * occ')
      expect(sha256(asDefine + '\n' + CLOUD_GROUND_GLSL.light)).toBe(GROUND_SHADOW_SHA256[name])
      clouds.dispose()
    })
  }

  const variants = [
    [],
    ['CLOUD_FLAT'],
    ['FLIP_SIDED'],
    ['CLOUD_FLAT', 'FLIP_SIDED'],
    ['FLIP_SIDED', 'FOG_EASE'],
  ]
  it("never tops an untyped column over the map's tallest, so the typed column needs no branch for it (tides-tvr.4.8)", () => {
    for (const measured of [0, 1]) {
      for (let k = 0; k <= 20; k++) {
        for (const r of [0, 0.5, 1]) {
          for (const coverage of [0, 0.5, 1]) {
            const alpha = k / 20
            expect(cloudTopKm(r, coverage, alpha, measured) * cloudShape(alpha)).toBeLessThanOrEqual(maxTopKm(measured === 1))
          }
        }
      }
    }
  })

  const columnOf = (src: string) => src.slice(src.indexOf('vec4 cloudColumn('), src.indexOf('float cloudShade('))
  for (const variant of variants) {
    const name = variant.join('+') || 'relief'
    it(`reads the typed tops beside the map (${name})`, () => {
      const clouds = createCloudLayer(createEclipseShadow('earth'), variant.includes('CLOUD_FLAT'))
      const untyped = new Set(variant)
      const typed = new Set([...variant, 'CLOUD_TYPED'])
      for (const stage of ['vertexShader', 'fragmentShader'] as const) {
        const src = preprocess(clouds.material[stage], typed)
        if (!src.includes('vec4 cloudColumn(')) continue
        const column = columnOf(src)
        const before = columnOf(preprocess(clouds.material[stage], untyped))
        // The map read as untyped, and the tops read the same way beside
        // it: the same place, mip and smoothing near the poles.
        const mapRead = before.match(/vec3 c = (cloudPoleSmoothed\(uCloudMap, st,[^;]*textureLod\(uCloudMap, st, lod\)\))\.rgb;/)
        expect(mapRead).not.toBeNull()
        expect(column).toContain(`vec3 c = ${mapRead![1]}.rgb;`)
        expect(column).toContain(`vec3 typedTop = ${mapRead![1].replace(/uCloudMap/g, 'uCloudTops')}.rgb;`)
        // Nothing from the map's alpha, nor the byte's codes, any more.
        expect(column).not.toMatch(/\bc\.a\b|TYPED_ZERO|vec4 c = /)
        // Untyped tops, the untyped column exactly; else the top mixed
        // toward it by how far the texel is untyped, under the map's
        // tallest, and the base lifted, never over it.
        for (const line of [
          'float topKm = min(mix(km * shape, typedTop.r * TYPED_TOPS_KM, typedTop.b), uCloudMaxKm);',
          'float liftKm = min(typedTop.b * typedTop.g * TYPED_TOPS_KM, topKm);',
          'return vec4(c.g, base + CLOUD_UNITS_PER_KM * liftKm, base + CLOUD_UNITS_PER_KM * topKm, base);',
        ]) {
          expect(column).toContain(line)
        }
        // With no branch for an untyped texel (tides-tvr.4.8): B 0 lifts
        // nothing, and the min against the map's tallest leaves the untyped
        // top as it is (the test after these).
        expect(column).not.toMatch(/if \(typedTop\.b/)
        expect(src).toContain('uniform sampler2D uCloudTops;')
        expect(src).toContain(TYPED_TOPS_GLSL)
        expect(src).toContain(`#define TYPED_TOPS_KM ${TYPED_TOPS_KM.toFixed(6)}`)
      }
      // The vertex stage reads the tops, never the grid.
      expect(preprocess(clouds.material.vertexShader, typed)).not.toMatch(/uCloudType\b|cloudLook/)
      clouds.dispose()
    })

    it(`meets a lifted layer from outside only between its base and its top (${name})`, () => {
      const clouds = createCloudLayer(createEclipseShadow('earth'), variant.includes('CLOUD_FLAT'))
      const outside = !variant.includes('FLIP_SIDED') && !variant.includes('CLOUD_FLAT')
      const src = preprocess(clouds.material.fragmentShader, new Set([...variant, 'CLOUD_TYPED']))
      const main = src.replace(/\/\/.*$/gm, '').slice(src.replace(/\/\/.*$/gm, '').indexOf('void main()'))
      if (outside) {
        // From the column it already reads, its height over the top and
        // under the base, each taken linear over the step; at the first
        // step, whether it is in between.
        for (const line of [
          'vec4 colq = cloudColumn(cloudUv(q / r), lodq, terrain);',
          'float gap = r - uSeaLevel - colq.z;',
          'float under = colq.y - (r - uSeaLevel);',
          'vec2 underTop = i > 0 ? cloudSpan(gapPrev, gap) : gap <= 0.0 ? vec2(0.0, 1.0) : vec2(1.0, 0.0);',
          'vec2 overBase = i > 0 ? cloudSpan(underPrev, under) : under <= 0.0 ? vec2(0.0, 1.0) : vec2(1.0, 0.0);',
          'if (from <= min(underTop.y, overBase.y)) {',
          'tHit = i == 0 ? t : mix(tPrev, t, from);',
          'underPrev = under;',
        ]) {
          expect(main).toContain(line)
        }
        expect(main).not.toContain('if (gap <= 0.0) {')
        // Untyped, the tops alone, as ever.
        expect(preprocess(clouds.material.fragmentShader, new Set(variant))).toContain(
          'float gap = r - uSeaLevel - cloudColumn(cloudUv(q / r), lodq, terrain).z;\n    if (gap <= 0.0) {'
        )
      }
      clouds.dispose()
    })

    it(`reckons from the ground under a lifted base where the untyped program took the base for it (${name})`, () => {
      const clouds = createCloudLayer(createEclipseShadow('earth'), variant.includes('CLOUD_FLAT'))
      const src = preprocess(clouds.material.fragmentShader, new Set([...variant, 'CLOUD_TYPED']))
      const code = src.replace(/\/\/.*$/gm, '')
      const main = code.slice(code.indexOf('void main()'))
      expect(main).toContain('cloudKm(colShade.z, colShade.w)')
      expect(main).not.toMatch(/colShade\.y\b|colShade\.zy\b/)
      if (variant.includes('FLIP_SIDED')) {
        expect(code).toContain('shade += w * vec4(depth, mix(s0, s1, t), c.z, c.w);')
      }
      if (variant.includes('FLIP_SIDED') && !variant.includes('CLOUD_FLAT')) {
        expect(main).toContain('cloudKm(length(eye) - uSeaLevel, colFog.w)')
        expect(main).toContain('vec4 place = (sideShade + hitLight * vec4(depth, eyeDist, col.z, col.w)) / shadeW;')
        expect(main).toContain('colShade.zw = place.zw;')
        expect(main).toContain('terrainShade = place.w - CLOUD_CLEARANCE;')
        expect(main).toContain('float ground = mix(colPrev.w, colIn.w, (sm - sPrev) / len) - CLOUD_CLEARANCE;')
        expect(main).not.toMatch(/colFog\.y\b|colPrev\.y\b/)
      }
      clouds.dispose()
    })
  }
})

describe('the ground shadow under the deck (tides-l0z)', () => {
  const sea = sceneRadius(12742000)
  const low = GROUND_SHADOW_ADAPT_FROM
  const high = GROUND_SHADOW_ADAPT_TOP
  const [dusk, day] = GROUND_SHADOW_ADAPT_SUN
  const strength = (height: number, sunSin: number) => groundShadowStrength(height, high, sunSin)

  it('eases to GROUND_SHADOW_UNDER only under the clouds by day', () => {
    // Under the lowest base, the Sun well up: all of the adaptation.
    expect(strength(low, day)).toBeCloseTo(GROUND_SHADOW_UNDER, 12)
    expect(strength(0, 1)).toBeCloseTo(GROUND_SHADOW_UNDER, 12)
    // Over the layer's top, and from far off: as before.
    expect(strength(high, 1)).toBe(GROUND_SHADOW)
    expect(strength(10, 1)).toBe(GROUND_SHADOW)
    // Dusk and night, at any height: as before.
    for (const sunSin of [dusk, 0, -0.5]) expect(strength(0, sunSin)).toBe(GROUND_SHADOW)
    // Between, weaker the lower the eye and the higher the Sun.
    let last = GROUND_SHADOW_UNDER
    for (let k = 1; k <= 10; k++) {
      const s = strength(low + ((high - low) * k) / 10, day)
      expect(s).toBeGreaterThanOrEqual(last)
      last = s
    }
    expect(strength(0, (dusk + day) / 2)).toBeGreaterThan(GROUND_SHADOW_UNDER)
    expect(strength(0, (dusk + day) / 2)).toBeLessThan(GROUND_SHADOW)
    // The relief layer's band spans its lowest base to its thickest untyped
    // top; over a lower top (the flat deck's) it is gone by that top.
    expect(low).toBe(CLOUD_CLEARANCE)
    expect(high).toBeCloseTo(CLOUD_CLEARANCE + CLOUD_UNITS_PER_KM * defaultTopKm(1), 12)
    expect(groundShadowStrength(0.02, 0.02, 1)).toBe(GROUND_SHADOW)
    expect(groundShadowStrength(0.02, 0.01, 1)).toBe(GROUND_SHADOW)
    expect(GROUND_SHADOW_UNDER).toBeLessThan(GROUND_SHADOW)
  })

  it('sets the strength for each camera before it draws, over the ground under the eye', () => {
    for (const flat of [false, true]) {
      const clouds = createCloudLayer(createEclipseShadow('earth'), flat)
      clouds.uniforms.uSeaLevel.value = sea
      clouds.uniforms.uSunDir.value.set(0, 1, 0)
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), clouds.material)
      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.0001, 100)
      const at = (position: THREE.Vector3) => {
        camera.position.copy(position)
        camera.updateMatrixWorld()
        clouds.faceCamera(mesh, camera)
        return clouds.uniforms.uGroundShadow.value
      }
      // A flat floor of grey g everywhere (terrain-floor.ts), for the ground
      // under the eye.
      const floorOf = (g: number): TerrainFloor => {
        const [w, h] = TERRAIN_MAP_SIZE
        return { segments: [w, h], grey: new Float32Array((w + 1) * (h + 1)).fill(g), poles: [g, g], slope: new Float32Array(w * h) }
      }
      try {
        // Under the deck at noon, then the system view, then under it at night.
        expect(at(new THREE.Vector3(0, sea + low * 0.5, 0))).toBeCloseTo(GROUND_SHADOW_UNDER, 12)
        expect(at(new THREE.Vector3(0, sea * 5, 0))).toBe(GROUND_SHADOW)
        expect(at(new THREE.Vector3(0, -(sea + low * 0.5), 0))).toBe(GROUND_SHADOW)
        // Over the flat deck, which is the low tier's only cloud: as before.
        if (flat) expect(at(new THREE.Vector3(0, sea + CLOUD_FLAT_ALTITUDE + 0.001, 0))).toBe(GROUND_SHADOW)
        // Over high ground (here 0.03 up), under its clouds' base: adapted,
        // though well over the sea's.
        if (!flat) {
          const grey = (0.03 * 255) / TERRAIN_DISPLACEMENT
          setEarthTerrain(floorOf(grey - TERRAIN_GREY_MARGIN))
          expect(at(new THREE.Vector3(0, sea + 0.03 + low * 0.5, 0))).toBeCloseTo(GROUND_SHADOW_UNDER, 9)
          expect(at(new THREE.Vector3(0, sea + 0.03 + high, 0))).toBe(GROUND_SHADOW)
        }
        // The ground's patch reads the same uniform object.
        const shader = phongShader()
        clouds.groundPatch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
        expect(shader.uniforms.uGroundShadow).toBe(clouds.uniforms.uGroundShadow)
        expect(shader.fragmentShader).toContain('return 1.0 - uGroundShadow * occ;')
      } finally {
        setEarthTerrain(null)
        clouds.dispose()
      }
    }
  })
})

describe('the deck at true height near the ground (tides-d9f.10)', () => {
  const sea = sceneRadius(12742000)

  it('reads the clearance and km scale from uniforms on the relief path, constants on the flat one', () => {
    const relief = createCloudLayer(createEclipseShadow('earth'), false)
    const flat = createCloudLayer(createEclipseShadow('earth'), true)
    try {
      // The shell's one text, as three builds it for each tier, from inside
      // (FLIP_SIDED), where the vertex shader reads the field too.
      for (const shader of [relief.material.vertexShader, relief.material.fragmentShader]) {
        const asRelief = preprocess(shader, new Set(['FLIP_SIDED']))
        expect(asRelief).toContain('uniform float uCloudClearance;')
        expect(asRelief).toContain('uniform float uCloudUnitsPerKm;')
        expect(asRelief).toContain('#define CLOUD_CLEARANCE uCloudClearance')
        expect(asRelief).toContain('#define CLOUD_UNITS_PER_KM uCloudUnitsPerKm')
        const asFlat = preprocess(shader, new Set(['CLOUD_FLAT', 'FLIP_SIDED']))
        expect(asFlat).not.toMatch(/uCloudClearance|uCloudUnitsPerKm/)
        expect(asFlat).toContain(`#define CLOUD_CLEARANCE ${CLOUD_CLEARANCE.toFixed(6)}`)
        expect(asFlat).toContain(`#define CLOUD_UNITS_PER_KM ${CLOUD_UNITS_PER_KM.toFixed(6)}`)
        expect(asRelief.split('uniform float uCloudClearance;').length).toBe(2)
      }
      // The ground's shadow, built for its tier.
      expect(CLOUD_GROUND_GLSL.head(false)).toContain('#define CLOUD_CLEARANCE uCloudClearance')
      expect(CLOUD_GROUND_GLSL.head(false).split('uniform float uCloudUnitsPerKm;').length).toBe(2)
      expect(CLOUD_GROUND_GLSL.head(true)).not.toMatch(/uCloudClearance|uCloudUnitsPerKm/)
      expect(CLOUD_GROUND_GLSL.head(true)).toContain(`#define CLOUD_CLEARANCE ${CLOUD_CLEARANCE.toFixed(6)}`)
      // The shell, the globe's ground and the streamed tiles share the
      // uniform objects (tile-clouds.ts assigns the same ones).
      for (const clouds of [relief, flat]) {
        expect(clouds.material.uniforms.uCloudClearance).toBe(clouds.uniforms.uCloudClearance)
        expect(clouds.material.uniforms.uCloudUnitsPerKm).toBe(clouds.uniforms.uCloudUnitsPerKm)
        const shader = phongShader()
        clouds.groundPatch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
        expect(shader.uniforms.uCloudClearance).toBe(clouds.uniforms.uCloudClearance)
        expect(shader.uniforms.uCloudUnitsPerKm).toBe(clouds.uniforms.uCloudUnitsPerKm)
        // Today's deck until a camera is faced.
        expect(clouds.uniforms.uCloudClearance.value).toBe(EXAGGERATED_DECK.clearance)
        expect(clouds.uniforms.uCloudUnitsPerKm.value).toBe(EXAGGERATED_DECK.unitsPerKm)
      }
    } finally {
      relief.dispose()
      flat.dispose()
    }
  })

  it('sets the deck for each camera from its altitude, true near the ground only on a fine depth buffer', () => {
    for (const flat of [false, true]) {
      const clouds = createCloudLayer(createEclipseShadow('earth'), flat)
      clouds.uniforms.uSeaLevel.value = sea
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), clouds.material)
      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.0001, 100)
      const deckAt = (km: number, fine: boolean) => {
        camera.position.set(0, sea + km / EARTH_KM_PER_UNIT, 0)
        camera.updateMatrixWorld()
        clouds.faceCamera(mesh, camera, fine)
        return { clearance: clouds.uniforms.uCloudClearance.value, unitsPerKm: clouds.uniforms.uCloudUnitsPerKm.value }
      }
      try {
        const near = flat ? EXAGGERATED_DECK : TRUE_DECK
        expect(deckAt(5, true)).toEqual({ ...near })
        expect(deckAt(5, false)).toEqual({ ...EXAGGERATED_DECK })
        expect(deckAt(36000, true)).toEqual({ ...EXAGGERATED_DECK })
        // Halfway up the band, halfway between (to the float).
        if (!flat) {
          const mid = deckAt(60, true)
          expect(mid.clearance).toBeCloseTo(cloudDeckAt(60, true).clearance, 12)
          expect(mid.unitsPerKm).toBeCloseTo(cloudDeckAt(60, true).unitsPerKm, 12)
        }
      } finally {
        clouds.dispose()
      }
    }
  })

  // The longest path from inside through `deck`: under the tallest top
  // over the highest ground, grazing the sea.
  const deckOuter = (deck: typeof TRUE_DECK) =>
    TERRAIN_DISPLACEMENT * TERRAIN_MAX_GREY + deck.clearance + deck.unitsPerKm * MAX_CLOUD_TOP_KM
  const chord = (top: number) => 2 * Math.sqrt((sea + top) ** 2 - sea ** 2)

  it('steps the march as much shorter as the deck\'s longest path, and as it was from orbit', () => {
    expect(deckOuter(EXAGGERATED_DECK)).toBe(CLOUD_LAYER_TOP)
    expect(marchStepFor(EXAGGERATED_DECK)).toBe(MARCH_STEP)
    const ratio = chord(deckOuter(TRUE_DECK)) / chord(CLOUD_LAYER_TOP)
    expect(marchStepFor(TRUE_DECK)).toBeCloseTo(MARCH_STEP * ratio, 15)
    // A little over a third of the step from orbit.
    expect(ratio).toBeGreaterThan(0.3)
    expect(ratio).toBeLessThan(0.4)
    for (const flat of [false, true]) {
      const clouds = createCloudLayer(createEclipseShadow('earth'), flat)
      clouds.uniforms.uSeaLevel.value = sea
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), clouds.material)
      const camera = new THREE.PerspectiveCamera(60, 1.6, 0.0001, 100)
      const stepAt = (km: number) => {
        camera.position.set(0, sea + km / EARTH_KM_PER_UNIT, 0)
        camera.updateMatrixWorld()
        clouds.faceCamera(mesh, camera, true)
        return clouds.material.uniforms.uMarchStep.value
      }
      try {
        expect(clouds.material.uniforms.uMarchStep.value).toBe(MARCH_STEP)
        expect(stepAt(5)).toBe(flat ? MARCH_STEP : marchStepFor(TRUE_DECK))
        expect(stepAt(36000)).toBe(MARCH_STEP)
      } finally {
        clouds.dispose()
      }
    }
  })

  it('scales the relief programs\' deck-sized lengths with the live deck, and leaves the flat sheet\'s literal', () => {
    const clouds = createCloudLayer(createEclipseShadow('earth'), false)
    try {
      const vertex = preprocess(clouds.material.vertexShader, new Set(['FLIP_SIDED']))
      const fragment = preprocess(clouds.material.fragmentShader, new Set(['FLIP_SIDED']))
      for (const v of [vertex, fragment]) {
        expect(v).toContain('uniform float uMarchStep;')
        expect(v).toContain(`#define CLOUD_DECK_SCALE (CLOUD_UNITS_PER_KM / ${CLOUD_UNITS_PER_KM.toFixed(6)})`)
        expect(v).toContain(`/ (${(0.004).toFixed(6)} * CLOUD_DECK_SCALE);`)
      }
      expect(fragment).toContain('#define MARCH_STEP uMarchStep')
      expect(fragment).toContain('#define WALL_DEPTH (MARCH_STEP * 0.5)')
      expect(fragment).toContain('#define SIDE_REST (MARCH_STEP * 4.0)')
      expect(fragment).toContain('#define SHADOW_STEP (0.0065 * CLOUD_DECK_SCALE)')
      expect(fragment).toContain('#define SHADOW_SOFT (0.02 * CLOUD_DECK_SCALE)')
      expect(fragment).toContain(
        `#define GROUND_FADE (${GROUND_FADE.toFixed(6)} * (CLOUD_CLEARANCE / ${CLOUD_CLEARANCE.toFixed(6)}))`
      )
      const flatFragment = preprocess(clouds.material.fragmentShader, new Set(['CLOUD_FLAT', 'FLIP_SIDED']))
      expect(flatFragment).not.toMatch(/uMarchStep|CLOUD_DECK_SCALE/)
      expect(flatFragment).toContain(`#define MARCH_STEP ${MARCH_STEP.toFixed(6)}`)
      expect(flatFragment).toContain(`#define GROUND_FADE ${GROUND_FADE.toFixed(6)}`)
      expect(CLOUD_GROUND_GLSL.head(false)).toContain(
        `float soft = 0.008 * (CLOUD_UNITS_PER_KM / ${CLOUD_UNITS_PER_KM.toFixed(6)});`
      )
      expect(CLOUD_GROUND_GLSL.head(true)).toContain('smoothstep(-0.008, 0.008, col.z - alt)')
    } finally {
      clouds.dispose()
    }
  })

  it('fogs a column of so many km as it did, at any deck', () => {
    expect(fogPath(EXAGGERATED_DECK)).toBe(fogPath())
    // The opacity through the whole thickness of a column of km km, at the
    // deck's own scale: the true deck's, some nine times thinner in scene
    // units, as dense per unit as it is thinner.
    const through = (deck: typeof TRUE_DECK, alpha: number, km: number) => {
      const base = deck.clearance
      const top = base + deck.unitsPerKm * km
      const n = 4000
      let depth = 0
      for (let i = 0; i < n; i++) depth += fogExtinction(alpha, base, top, base + ((i + 0.5) / n) * (top - base), deck)
      return 1 - Math.exp((-depth * (top - base)) / n)
    }
    for (const alpha of [0.05, 0.3, 0.8])
      for (const km of [0.5, 2, 9]) expect(through(TRUE_DECK, alpha, km)).toBeCloseTo(through(EXAGGERATED_DECK, alpha, km), 12)
    // And over a step: the eye's share of the phase reads the same fog
    // over the live step as the shader's cloudFogStep().
    const fog = fogExtinction(0.5, TRUE_DECK.clearance, TRUE_DECK.clearance + 0.003, TRUE_DECK.clearance + 0.0015, TRUE_DECK)
    expect(fog * marchStepFor(TRUE_DECK)).toBeCloseTo(
      ((0.5 * -Math.log(0.5)) / (0.004 * (TRUE_DECK.unitsPerKm / CLOUD_UNITS_PER_KM))) * marchStepFor(TRUE_DECK),
      9
    )
  })

  it('keeps every march from inside within the step budget at every deck in the band', () => {
    // From under the deck's base to above its reach, at each step's own deck.
    for (let km = 0; km <= CLOUD_DECK_BAND_KM[1] + 20; km += 5) {
      const deck = cloudDeckAt(km, true)
      const step = marchStepFor(deck)
      const outer = sea + deckOuter(deck)
      let longest = 0
      let most = 0
      for (let alt = deck.clearance / 2; alt <= deckOuter(deck) + 0.01; alt += deckOuter(deck) / 20) {
        for (let deg = -90; deg <= 90; deg += 0.5) {
          const a = (deg * Math.PI) / 180
          const span = marchSpanFromEye([0, sea + alt, 0], [Math.cos(a), Math.sin(a), 0], sea, outer, deck)
          if (!span) continue
          longest = Math.max(longest, span.end - span.origin)
          most = Math.max(most, marchSteps(span, step, MARCH_STEPS, 0.999).length)
        }
      }
      expect(longest / MARCH_STEPS, `${km} km`).toBeLessThanOrEqual(step * 1.02)
      expect(most, `${km} km`).toBeLessThanOrEqual(MARCH_STEPS + 2)
    }
  })

  it('lays the ground haze in front of a cloud on a ray that ends on the ground, on the relief path alone', () => {
    const relief = createCloudLayer(createEclipseShadow('earth'), false)
    const flat = createCloudLayer(createEclipseShadow('earth'), true)
    try {
      const inside = preprocess(relief.material.fragmentShader, new Set(['FLIP_SIDED']))
      // The ground's own function, once, on the cloud's Sun.
      expect(inside.split(GROUND_HAZE_GLSL).length).toBe(2)
      expect(inside).toContain('#define uGroundHazeSun uSunDir')
      expect(inside).toContain('vec4 haze = groundHaze(eye, d * s, cover);')
      expect(inside.split('uniform float uGroundHaze;').length).toBe(2)
      // The ground's program takes the same text.
      const ground = phongShader()
      const haze = createGroundHaze(relief.uniforms.uSunDir, sea, false)
      haze.patch.onBeforeCompile(ground, {} as THREE.WebGLRenderer)
      expect(ground.fragmentShader).toContain(GROUND_HAZE_GLSL)
      // Neither the flat tier nor the faces from outside.
      expect(preprocess(flat.material.fragmentShader, new Set(['CLOUD_FLAT', 'FLIP_SIDED']))).not.toMatch(/groundHaze\(|uGroundHaze/)
      expect(preprocess(relief.material.fragmentShader, new Set())).not.toMatch(/groundHaze\(|uGroundHaze/)
      // Off until shared; then the ground's own uniform objects.
      expect(relief.material.uniforms.uGroundHaze.value).toBe(0)
      haze.shareWith(relief.material)
      for (const name of ['uGroundHaze', 'uGroundHazeLength', 'uGroundHazeTop']) {
        const own = ground.uniforms[name]
        expect(own).toBeDefined()
        expect(relief.material.uniforms[name]).toBe(own)
      }
    } finally {
      relief.dispose()
      flat.dispose()
    }
  })

  it('gives a cloud under a low eye no more haze than the ground beside it gets (groundHazeWeights())', () => {
    const km = sea / EARTH_RADIUS_KM
    const eye = new THREE.Vector3(0, sea + 5 * km, 0)
    const share = (to: THREE.Vector3) =>
      groundHazeWeights(eye.length(), groundHazeDepth(eye, to.clone().sub(eye), sea), 0, sea, false).haze
    // Straight down onto a top 2 km up: the segment's share, where
    // cloudHazeFront() laid a quarter of the ray's column.
    expect(share(new THREE.Vector3(0, sea + 2 * km, 0))).toBeLessThan(1e-3)
    // Along a slanting ray, a cloud before the ground takes less than the
    // ground behind it, the ground's own model either side.
    const d = new THREE.Vector3(1, -0.1, 0).normalize()
    const b = eye.dot(d)
    const sSea = -b - Math.sqrt(b * b - (eye.lengthSq() - sea * sea))
    let last = 0
    for (const f of [0.25, 0.5, 0.75, 1]) {
      const next = share(eye.clone().addScaledVector(d, f * sSea))
      expect(next).toBeGreaterThan(last)
      last = next
    }
  })
})
