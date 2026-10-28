// Open water that reads as water (tides-07z, tides-d9f.5): the TypeScript
// mirrors' physics (Beckmann's normalisation, isotropic and along the sea's
// axis, the glint at grazing and unaliased at sunset, the waves' variance,
// gain and phases, the body's floor) and where the GLSL lands on the globe's
// Phong.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createCloudLayer } from './cloudShaders'
import hazeGlsl from '../shaders/atmosphere/haze.glsl'
import { composePatches, createEclipseShadow } from './eclipseShadow'
import { earthHorizon } from './earthHorizonTexture'
import { createGroundHaze } from './groundHaze'
import { groundDetailPatch } from './groundDetail'
import { groundShadowPatch } from './groundShadow'
import { phongShader } from './surface/tile-test-fixtures'
import { WATER_DEPTH_SAMPLE, WATER_KEEP, waterTinted } from './waterDepth'
import { NOISE_CELLS } from './waterNoise'
import { EARTH_RADIUS_KM } from '../cloud-layer'
import { EARTH_KM_PER_UNIT } from '../surface-handover'
import {
  beckmann,
  beckmannAniso,
  BLINN_PHONG_DIRECT,
  createWater,
  SKY_DAY,
  WATER_BODY_SKY,
  WATER_DEEP,
  WATER_DEEP_LUMA,
  WATER_GLSL,
  WATER_MSS,
  WATER_MSS_BASE,
  WATER_FADE_END,
  WATER_FADE_START,
  WATER_GLINT_HARMONIC,
  WATER_GLOBE_VERTEX,
  WATER_PRELUDE,
  WATER_SKY_LIGHT_ELEVATION,
  WATER_SKY_LIGHT_UV,
  WATER_WAVE_TABLE,
  WATER_WAVES,
  WATER_WAVES_LOW,
  isotropicSlope,
  medianSea,
  waterBaseMss,
  waterBody,
  waterGlint,
  waterLostVariance,
  waterMss,
  waterPatch,
  waterPhases,
  waterSeaVariance,
  WATER_NOISE_CELLS,
  WATER_NOISE_KM,
  splitDouble,
  waveSlope,
  waterSparkle,
  waterSparkleEye,
  waterSparkleMean,
  WATER_SPARKLE_GLOW,
  WATER_SPARKLE_GLOW_DEG,
  WATER_SPARKLE_PERIOD_M,
  WATER_TWINKLE_HZ,
  WATER_SWELL_KM,
  waterSlopeVariance,
  waterVisibleVariance,
  waterWaves,
  waveGain,
  waveStep,
  waveWeight,
  type WaterSea,
  type WaterWave,
} from './water'

type V = [number, number, number]
const UP: V = [0, 1, 0]
const norm = (v: V): V => {
  const l = Math.hypot(...v)
  return [v[0] / l, v[1] / l, v[2] / l]
}
const TAU = 2 * Math.PI
/** A level axis under UP, and an isotropic slope of variance `mss` on it. */
const AXIS: V = [0, 0, 1]
const iso = (mss: number) => isotropicSlope(mss, AXIS)
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1)
  return t * t * (3 - 2 * t)
}
/** A level axis at `up`, turned `turn` radians round it. */
const levelAxis = (up: V, turn: number): V => {
  const e = norm(Math.abs(up[0]) < 0.9 ? [0, -up[2], up[1]] : [-up[1], up[0], 0])
  const c: V = [up[1] * e[2] - up[2] * e[1], up[2] * e[0] - up[0] * e[2], up[0] * e[1] - up[1] * e[0]]
  return [0, 1, 2].map((i) => e[i] * Math.cos(turn) + c[i] * Math.sin(turn)) as V
}
// A GLSL subset run in JS, for the water's own lines (tides-rlj): floats,
// vec2/vec3 and mat3 (column-major, as GLSL), + - * /, unary -, calls,
// indexing, declarations, = += -=, and if blocks. Enough to test what the
// waves do to the normal in a known frame, not text.
type G = number | number[] | { m: number[] }
const isMat = (x: G): x is { m: number[] } => typeof x === 'object' && !Array.isArray(x)
const zip = (a: G, b: G, f: (x: number, y: number) => number): G => {
  if (typeof a === 'number' && typeof b === 'number') return f(a, b)
  if (typeof a === 'number') return (b as number[]).map((y) => f(a, y))
  if (typeof b === 'number') return (a as number[]).map((x) => f(x, b))
  return (a as number[]).map((x, i) => f(x, (b as number[])[i]))
}
const gDot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0)
const col = (m: number[], j: number) => m.slice(3 * j, 3 * j + 3)
const gMul = (a: G, b: G): G => {
  if (isMat(a) && Array.isArray(b)) return [0, 1, 2].map((i) => gDot([a.m[i], a.m[3 + i], a.m[6 + i]], b))
  if (Array.isArray(a) && isMat(b)) return [0, 1, 2].map((j) => gDot(a, col(b.m, j)))
  return zip(a, b, (x, y) => x * y)
}
const FNS: Record<string, (...a: G[]) => G> = {
  vec2: (...a) => a as number[],
  vec3: (...a) => (a.length === 1 ? [a[0], a[0], a[0]] : a) as number[],
  dot: (a, b) => gDot(a as number[], b as number[]),
  length: (a) => Math.hypot(...(a as number[])),
  normalize: (a) => (a as number[]).map((x) => x / Math.hypot(...(a as number[]))),
  sqrt: (a) => zip(a, 0, Math.sqrt),
  sin: (a) => zip(a, 0, Math.sin),
  max: (a, b) => zip(a, b, Math.max),
  mix: (a, b, t) => zip(a, zip(b, a, (y, x) => y - x), (x, d) => x + d * (t as number)),
  smoothstep: (a, b, x) => smoothstep(a as number, b as number, x as number),
}
function runGlsl(code: string, vars: Record<string, G>): Record<string, G> {
  const toks = code.match(/\d+\.?\d*(?:e[-+]?\d+)?|[A-Za-z_]\w*|[-+*/]=|[<>]=?|[-+*/=(),;{}[\]]/g) ?? []
  let i = 0
  const peek = () => toks[i]
  const take = (t?: string) => {
    if (t && toks[i] !== t) throw new Error(`glsl: expected ${t}, got ${toks[i]}`)
    return toks[i++]
  }
  const atom = (): G => {
    const t = take()
    if (t === '(') { const v = expr(); take(')'); return v }
    if (t === '-') return gMul(-1, atom())
    if (/^\d/.test(t)) return parseFloat(t)
    let v: G
    if (peek() === '(') {
      take('(')
      const args: G[] = []
      while (peek() !== ')') { args.push(expr()); if (peek() === ',') take(',') }
      take(')')
      if (!FNS[t]) throw new Error(`glsl: no ${t}()`)
      v = FNS[t](...args)
    } else {
      if (!(t in vars)) throw new Error(`glsl: no ${t}`)
      v = vars[t]
    }
    while (peek() === '[') { take('['); v = (v as number[])[expr() as number]; take(']') }
    return v
  }
  const term = (): G => {
    let v = atom()
    while (peek() === '*' || peek() === '/') v = take() === '*' ? gMul(v, atom()) : zip(v, atom(), (x, y) => x / y)
    return v
  }
  const expr = (): G => {
    let v = term()
    while (peek() === '+' || peek() === '-') v = take() === '+' ? zip(v, term(), (x, y) => x + y) : zip(v, term(), (x, y) => x - y)
    if (peek() === '>' || peek() === '<') { const op = take(); const w = term(); v = (op === '>' ? (v as number) > (w as number) : (v as number) < (w as number)) ? 1 : 0 }
    return v
  }
  const block = (run: boolean) => {
    while (i < toks.length && peek() !== '}') {
      if (peek() === 'if') {
        take('if'); take('(')
        const c = expr()
        take(')'); take('{')
        block(run && c !== 0)
        take('}')
        continue
      }
      if (['float', 'vec2', 'vec3', 'mat3'].includes(peek()) && /^[A-Za-z_]/.test(toks[i + 1])) take()
      const name = take()
      const op = take()
      if (op === ';') { if (run) vars[name] = 0; continue }
      if (!run) { while (take() !== ';'); continue }
      const v = expr()
      take(';')
      vars[name] = op === '=' ? v : zip(vars[name], v, op === '+=' ? (x, y) => x + y : (x, y) => x - y)
    }
  }
  block(true)
  return vars
}
/** A rotation's mat3 (column-major) from its rows, and its action. */
const mat3 = (rows: number[][]): { m: number[] } => ({ m: [0, 1, 2].flatMap((j) => rows.map((r) => r[j])) })
const apply = (rows: number[][], v: number[]) => rows.map((r) => gDot(r, v))
const transpose = (rows: number[][]) => rows.map((_, i) => rows.map((r) => r[i]))
/** Distance between two angles, mod 2 pi. */
const angleGap = (a: number, b: number) => {
  const d = (((a - b) % TAU) + TAU) % TAU
  return Math.min(d, TAU - d)
}

describe('the glint (tides-07z)', () => {
  it('takes Beckmann\'s distribution, normalised over the projected facets', () => {
    for (const mss of [WATER_MSS_BASE, WATER_MSS]) {
      // The integral of D cos over the hemisphere of facet normals.
      const n = 20000
      let sum = 0
      for (let i = 0; i < n; i++) {
        const theta = ((i + 0.5) / n) * (Math.PI / 2)
        const c = Math.cos(theta)
        sum += beckmann(c * c, mss) * c * Math.sin(theta) * (Math.PI / 2 / n)
      }
      expect(Math.abs(sum * TAU - 1)).toBeLessThan(0.02)
    }
  })

  it('stays finite at grazing, with the light behind the eye and from below', () => {
    const level = [0, 0.001, 0.01]
    for (const lv of level) {
      for (const vv of level) {
        const l = norm([1, lv, 0])
        const v = norm([-1, vv, 0])
        const g = waterGlint(l, v, UP, UP, iso(WATER_MSS))
        expect(Number.isFinite(g)).toBe(true)
        expect(g).toBeGreaterThanOrEqual(0)
      }
    }
    // l = -v: no half vector.
    const l = norm([1, 0.5, 0])
    expect(waterGlint(l, [-l[0], -l[1], -l[2]], UP, UP, iso(WATER_MSS))).toBe(0)
    // The Sun under the level horizon: out, whatever the facet.
    expect(waterGlint(norm([1, -0.05, 0]), norm([-1, 0.05, 0]), norm([0.1, 1, 0]), UP, iso(WATER_MSS))).toBe(0)
  })

  it('is brightest at the mirror direction, and the road widens as the sea roughens', () => {
    const l = norm([1, 0.3, 0])
    const mirror = norm([-1, 0.3, 0])
    const off = norm([-1, 0.3, 0.3])
    const smooth = waterGlint(l, mirror, UP, UP, iso(WATER_MSS_BASE))
    expect(smooth).toBeGreaterThan(waterGlint(l, off, UP, UP, iso(WATER_MSS_BASE)))
    expect(waterGlint(l, off, UP, UP, iso(WATER_MSS)) / waterGlint(l, mirror, UP, UP, iso(WATER_MSS))).toBeGreaterThan(
      waterGlint(l, off, UP, UP, iso(WATER_MSS_BASE)) / smooth
    )
  })
})

describe('the glint along the sea\'s axis (tides-d9f.5)', () => {
  it('is Beckmann\'s own when the two variances are equal, whatever the axis', () => {
    for (const mss of [WATER_MSS_BASE, WATER_MSS, 0.1]) {
      for (const nh2 of [1, 0.99, 0.95, 0.8, 0.5]) {
        for (const turn of [0, 0.4, 1.3]) {
          const t = Math.sqrt(1 - nh2)
          const d = beckmannAniso(nh2, t * Math.cos(turn), t * Math.sin(turn), mss / 2, mss / 2)
          expect(d / beckmann(nh2, mss)).toBeCloseTo(1, 9)
        }
      }
      const l = norm([1, 0.3, 0.2])
      const v = norm([-1, 0.4, -0.1])
      const n = norm([0.05, 1, -0.03])
      const g = waterGlint(l, v, n, UP, iso(mss))
      expect(waterGlint(l, v, n, UP, isotropicSlope(mss, [1, 0, 0]))).toBeCloseTo(g, 9)
      expect(waterGlint(l, v, n, UP, isotropicSlope(mss, norm([1, 0, 1])))).toBeCloseTo(g, 9)
    }
  })

  it('stays normalised over the projected facets when the variances differ', () => {
    const [va, vc] = [0.03, 0.006]
    const n = 400
    let sum = 0
    for (let i = 0; i < n; i++) {
      const theta = ((i + 0.5) / n) * (Math.PI / 2)
      for (let j = 0; j < n; j++) {
        const phi = ((j + 0.5) / n) * TAU
        const c = Math.cos(theta)
        const s = Math.sin(theta)
        sum += beckmannAniso(c * c, s * Math.cos(phi), s * Math.sin(phi), va, vc) * c * s * (Math.PI / 2 / n) * (TAU / n)
      }
    }
    expect(Math.abs(sum - 1)).toBeLessThan(0.02)
  })

  it('stretches the Sun\'s road along the axis, and stays finite at grazing', () => {
    const l = norm([1, 0.3, 0])
    const slope = { along: 0.03, cross: 0.005 }
    // The same tilt off the mirror, along the axis and across it.
    const offAlong = norm([-1, 0.3, 0.25])
    const alongZ = waterGlint(l, offAlong, UP, UP, { ...slope, axis: [0, 0, 1] })
    const acrossZ = waterGlint(l, offAlong, UP, UP, { ...slope, axis: [1, 0, 0] })
    expect(alongZ).toBeGreaterThan(acrossZ * 2)
    for (const lv of [0, 0.001, 0.01]) {
      for (const vv of [0, 0.001, 0.01]) {
        for (const axis of [[0, 0, 1], [1, 0, 0], [0, 1, 0]] as V[]) {
          const g = waterGlint(norm([1, lv, 0]), norm([-1, vv, 0]), UP, UP, { ...slope, axis })
          expect(Number.isFinite(g)).toBe(true)
          expect(g).toBeGreaterThanOrEqual(0)
        }
      }
    }
    const lh = norm([1, 0.5, 0])
    expect(waterGlint(lh, [-lh[0], -lh[1], -lh[2]], UP, UP, { ...slope, axis: AXIS })).toBe(0)
  })
})

describe('the glint\'s sparkle (tides-d9f.5)', () => {
  it('scales the glint by a facet count over its mean: 1 on average, from a few facets to many', () => {
    const N = 400
    for (const lambda of [0.05, 0.5, 3, 11, 13, 80]) {
      let sum = 0
      let lit = 0
      for (let i = 0; i < N; i++) for (let j = 0; j < 8; j++) {
        const s = waterSparkle(lambda, (i + 0.5) / N, (j + 0.5) / 8)
        sum += s
        if (s > 0) lit++
      }
      expect(sum / (N * 8), `lambda ${lambda}`).toBeCloseTo(1, 1)
      // Few facets: most pixels dark, the few lit far brighter than the mean.
      if (lambda < 1) expect(lit / (N * 8)).toBeCloseTo(1 - Math.exp(-lambda), 1)
    }
    expect(waterSparkle(0.05, 0.99, 0.5)).toBeGreaterThan(10)
  })

  it('expects facets in proportion to their count and the glint\'s distribution', () => {
    expect(waterSparkleMean(200, 3, 0.9, 0.4)).toBeCloseTo(2 * waterSparkleMean(100, 3, 0.9, 0.4), 10)
    expect(waterSparkleMean(100, 6, 0.9, 0.4)).toBeCloseTo(2 * waterSparkleMean(100, 3, 0.9, 0.4), 10)
    expect(Number.isFinite(waterSparkleMean(100, 3, 1, 0))).toBe(true)
  })

  it('keeps its cells on the Earth: a ground point\'s place mod the period is the same from any eye', () => {
    const scale = EARTH_KM_PER_UNIT * 1000
    const place = (eye: V, ray: V) => {
      const out = new THREE.Vector3()
      waterSparkleEye(eye, out)
      return out.toArray().map((x, i) => {
        const m = x + ray[i] * scale
        return m - WATER_SPARKLE_PERIOD_M * Math.floor(m / WATER_SPARKLE_PERIOD_M)
      })
    }
    const point: V = [0.31, 2.93, -0.42]
    for (const eye of [[0.3, 2.94, -0.41], [0.312, 2.931, -0.4205]] as V[]) {
      const ray: V = [point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]]
      const got = place(eye, ray)
      const want = place([0, 0, 0], point)
      for (let i = 0; i < 3; i++) {
        const gap = Math.abs(got[i] - want[i])
        expect(Math.min(gap, WATER_SPARKLE_PERIOD_M - gap)).toBeLessThan(1e-3)
      }
    }
  })

  it('twinkles on the water\'s clock, still under prefers-reduced-motion', () => {
    const haze = createGroundHaze({ value: new THREE.Vector3(1, 0, 0) }, 2.95, false)
    const water = createWater(haze.frame)
    water.advance(2, false)
    water.update()
    expect(water.uniforms.uWaterTwinkle.value).toBeCloseTo(2 * WATER_TWINKLE_HZ, 6)
    water.advance(5, true)
    water.update()
    expect(water.uniforms.uWaterTwinkle.value).toBeCloseTo(2 * WATER_TWINKLE_HZ, 6)
  })

  it('draws it in the glint from the pixel\'s cell, set before any branch the glint reads', () => {
    const glsl = WATER_GLSL(WATER_WAVE_TABLE)
    expect(glsl.head).toContain('waterSparkle(waterFacets * d * nh')
    expect(glsl.normal).toContain('waterFacets = 0.0;')
    expect(glsl.normal.indexOf('waterFacets = 0.0;')).toBeLessThan(glsl.normal.indexOf('if (specularStrength > 0.0)'))
    expect(glsl.normal).toContain('waterSparkleKey = uvec4(')
  })

  it('keeps a smooth share under a low Sun only, so the sunset road stays gold and a higher Sun\'s is all sparkle', () => {
    const head = WATER_GLSL(WATER_WAVE_TABLE).head
    const sin = (deg: number) => Math.sin((deg * Math.PI) / 180).toFixed(6)
    expect(WATER_SPARKLE_GLOW).toBeGreaterThan(0)
    expect(WATER_SPARKLE_GLOW).toBeLessThan(0.5)
    expect(WATER_SPARKLE_GLOW_DEG[1]).toBeLessThan(20)
    expect(head).toContain(
      `float glow = ${WATER_SPARKLE_GLOW.toFixed(6)} * (1.0 - smoothstep(${sin(WATER_SPARKLE_GLOW_DEG[0])}, ${sin(WATER_SPARKLE_GLOW_DEG[1])}, sunSin));`
    )
    expect(head).toContain('sparkle = mix(waterSparkle(')
  })
})

describe('the glint unaliased at sunset (tides-d9f.5)', () => {
  // One row of pixels on a level sea, the Sun 2 deg up dead ahead (at 0 deg
  // a level facet sees none of it, Smith's term going to 0 for both
  // samplings alike) and the eye 20 deg down toward it, the longest wave
  // crossing the view at 45 deg: what made the stripes. A pixel steps s
  // across and s / sin 20 deg along the view. Each pixel's one sample at its
  // centre against the mean of 4 x 4 over its footprint, of the same drawn
  // sea (its wave at weight W, the glint at what the fade left it): the gap
  // is the aliasing, measured over pixel sizes from 64 pixels a wavelength
  // to 1.
  const el = (20 * Math.PI) / 180
  const sun = (2 * Math.PI) / 180
  const l: V = [Math.cos(sun), Math.sin(sun), 0]
  const v: V = [-Math.cos(el), Math.sin(el), 0]
  const wave: WaterWave = { ...WATER_WAVE_TABLE[0], dir: norm([1, 0, 1]) }
  const base = waterBaseMss(WATER_WAVE_TABLE)
  const v0 = 0.5 * wave.slope * wave.slope
  const tone = (x: number) => x / (1 + x)
  const shade = (phase: number, amplitude: number, along: number, cross: number) => {
    const g = amplitude * Math.sin(phase)
    return tone(waterGlint(l, v, norm([-g * wave.dir[0], 1, -g * wave.dir[2]]), UP, { along, cross, axis: wave.dir }))
  }
  type Fade = (step: number, s: number) => { w: number; along: number; cross: number }
  const worstAliasing = (fade: Fade) => {
    let worst = 0
    for (let px = 64; px >= 1; px /= 1.25) {
      const s = wave.lambda / px
      const kx = wave.k * wave.dir[2] * s
      const ky = (wave.k * wave.dir[0] * s) / Math.sin(el)
      const { w, along, cross } = fade(Math.hypot(kx, ky), s)
      let gap = 0
      let sum = 0
      for (let j = 0; j < 128; j++) {
        const p = 0.37 + j * kx
        let mean = 0
        for (let a = 0; a < 4; a++) {
          for (let b = 0; b < 4; b++) mean += shade(p + ((a + 0.5) / 4 - 0.5) * kx + ((b + 0.5) / 4 - 0.5) * ky, w, along, cross) / 16
        }
        gap += Math.abs(shade(p, w, along, cross) - mean)
        sum += mean
      }
      worst = Math.max(worst, gap / sum)
    }
    return worst
  }

  it('keeps each pixel within a quarter of its supersampled value, where the old fade let the wave\'s glint lines alias', () => {
    const now = worstAliasing((step) => {
      const w = waveWeight(step)
      const lost = (1 - w * w) * v0
      return { w, along: base / 2 + lost, cross: base / 2 }
    })
    // Before: faded from 12 to 6 pixels a wavelength on the wavelength
    // alone, W of the variance taken off the glint's.
    const before = worstAliasing((_, s) => {
      const w = 1 - smoothstep(WATER_FADE_START, WATER_FADE_END, s / wave.lambda)
      const lost = (1 - w) * v0
      return { w, along: (base + lost) / 2, cross: (base + lost) / 2 }
    })
    expect(now).toBeLessThan(0.25)
    expect(before).toBeGreaterThan(0.25)
  })
})

describe('the waves (tides-07z)', () => {
  it('runs twelve waves from 120 m, and the low tier keeps the six longest', () => {
    expect(WATER_WAVE_TABLE).toHaveLength(WATER_WAVES)
    const metres = WATER_WAVE_TABLE.map((w) => w.metres).sort((a, b) => b - a)
    expect(metres[0]).toBeCloseTo(120, 9)
    for (let i = 1; i < metres.length; i++) expect(metres[i] / metres[i - 1]).toBeCloseTo(0.715, 9)
    const low = waterWaves(true)
    expect(low).toHaveLength(WATER_WAVES_LOW)
    expect(low.map((w) => w.metres).sort((a, b) => b - a)).toEqual(metres.slice(0, WATER_WAVES_LOW))
    expect(waterWaves(false)).toBe(WATER_WAVE_TABLE)
    // Deep water's dispersion, and unit directions.
    for (const w of WATER_WAVE_TABLE) {
      expect(w.omega).toBeCloseTo(Math.sqrt((9.81 * TAU) / w.metres), 9)
      expect(Math.hypot(...w.dir)).toBeCloseTo(1, 9)
    }
  })

  it('fades a wave out on its phase step across the pixel, WATER_GLINT_HARMONIC sooner than its wavelength, a rougher wave sooner still', () => {
    const at = (cycles: number) => (TAU * cycles) / WATER_GLINT_HARMONIC
    expect(waveWeight(0)).toBe(1)
    expect(waveWeight(at(WATER_FADE_START))).toBe(1)
    expect(waveWeight(at(WATER_FADE_END))).toBe(0)
    const mid = at((WATER_FADE_START + WATER_FADE_END) / 2)
    expect(waveWeight(mid, 2)).toBeLessThan(waveWeight(mid))
    expect(waveWeight(mid, 0.5)).toBeGreaterThan(waveWeight(mid))
    let last = 1
    for (let x = 0; x <= 2; x += 0.01) {
      const w = waveWeight(x)
      expect(w).toBeLessThanOrEqual(last)
      last = w
    }
    // The step is the wave's level wavenumber across the pixel.
    const w = WATER_WAVE_TABLE[3]
    expect(waveStep(w, UP, 1e-5)).toBeCloseTo(w.k * Math.hypot(w.dir[0], w.dir[2]) * 1e-5, 12)
  })

  const ups: V[] = [UP, [1, 0, 0], norm([0.3, 0.5, -0.8]), norm([-0.6, -0.2, 0.4])]
  const seas = (up: V): WaterSea[] => [
    medianSea(levelAxis(up, 0)),
    { windScale: 1.8, swellScale: Math.sqrt(1.8), noise: 1.3, settled: 0.9, axis: levelAxis(up, 0.7) },
    { windScale: 0.6, swellScale: Math.sqrt(0.6), noise: 0.5, settled: 0.4, axis: levelAxis(up, 2.1) },
  ]
  /** A wave's drawn slope variance, from the amplitude the GLSL draws it at
   * (W sqrt(F) times its slope, along its level direction). */
  const drawn = (w: WaterWave, up: V, sea: WaterSea, footprint: number) => {
    const along = w.dir[0] * up[0] + w.dir[1] * up[1] + w.dir[2] * up[2]
    const gain = waveGain(w, up, sea)
    const amplitude = waveWeight(waveStep(w, up, footprint), gain) * Math.sqrt(gain) * w.slope
    return 0.5 * amplitude * amplitude * (1 - along * along)
  }

  it('keeps the sea\'s slope variance whole, mid-fade too: what the waves draw and what the glint takes add up to the sea\'s (the swell at the wind\'s scale), on either tier', () => {
    for (const low of [false, true]) {
      const waves = waterWaves(low)
      for (const up of ups) {
        for (const sea of seas(up)) {
          const whole = waterSeaVariance(up, waves, sea)
          // Across every wave's fade band (a pixel from a millimetre to a kilometre on the sea).
          for (let footprint = 1e-9; footprint < 1e-3; footprint *= 1.3) {
            const shown = waves.reduce((sum, w) => sum + drawn(w, up, sea, footprint), 0)
            expect(waterVisibleVariance(footprint, up, waves, sea)).toBeCloseTo(shown, 12)
            expect(shown + waterMss(footprint, up, waves, sea)).toBeCloseTo(whole, 12)
            expect(waterLostVariance(footprint, up, waves, sea) + waterBaseMss(waves) * sea.windScale * sea.noise).toBeCloseTo(
              waterMss(footprint, up, waves, sea),
              12
            )
          }
          // All faded: the glint holds the whole sea.
          expect(waterMss(1e9, up, waves, sea)).toBeCloseTo(whole, 12)
        }
        // The median sea's whole is the sea's, give or take how the waves'
        // directions lie against this up (the long waves, carrying more of
        // the slope, swing it most).
        expect(Math.abs(waterSeaVariance(up, waves, medianSea(levelAxis(up, 0))) - WATER_MSS)).toBeLessThan(low ? 0.008 : 0.003)
      }
    }
    expect(waterBaseMss(waterWaves(false))).toBeCloseTo(WATER_MSS_BASE, 12)
    expect(waterBaseMss(waterWaves(true))).toBeGreaterThan(WATER_MSS_BASE)
  })

  it('roughens the glint with the wind, not the swell: the swell\'s height scales only what\'s drawn', () => {
    const swell = WATER_WAVE_TABLE.find((w) => w.metres > 100)!
    for (const up of ups) {
      const calm: WaterSea = { windScale: 1.2, swellScale: 0.5, noise: 1, settled: 0.5, axis: levelAxis(up, 0.3) }
      const heavy = { ...calm, swellScale: 2 }
      for (const footprint of [1e9, 0]) {
        expect(waterMss(footprint, up, WATER_WAVE_TABLE, heavy)).toBeCloseTo(waterMss(footprint, up, WATER_WAVE_TABLE, calm), 12)
      }
      expect(drawn(swell, up, heavy, 0)).toBeGreaterThan(drawn(swell, up, calm, 0) * 10)
    }
  })

  it('lays a faded wave\'s variance on the glint along its own direction', () => {
    const w = WATER_WAVE_TABLE.find((x) => Math.abs(x.dir[1]) < 0.5)!
    const dir = norm([w.dir[0], 0, w.dir[2]])
    for (const [axis, share] of [[dir, 1], [norm([-dir[2], 0, dir[0]]), 0]] as [V, number][]) {
      const sea = medianSea(axis)
      const slope = waterSlopeVariance(1e9, UP, [w], sea)
      const base = 0.5 * waterBaseMss([w])
      const lost = waterLostVariance(1e9, UP, [w], sea)
      expect(slope.along - base).toBeCloseTo(share * lost, 12)
      expect(slope.cross - base).toBeCloseTo((1 - share) * lost, 12)
    }
  })

  it('pulls each wave\'s slope toward the climate\'s axis, its mean gain over directions the sea\'s own', () => {
    const base = WATER_WAVE_TABLE[0]
    const n = 720
    for (const settled of [0, 0.5, 1]) {
      const sea: WaterSea = { windScale: 1, swellScale: 1, noise: 1, settled, axis: AXIS }
      let sum = 0
      for (let i = 0; i < n; i++) {
        const a = ((i + 0.5) / n) * TAU
        sum += waveGain({ ...base, dir: [Math.cos(a), 0, Math.sin(a)] }, UP, sea)
      }
      expect(Math.abs(sum / n - 1)).toBeLessThan(0.01)
      const aligned = waveGain({ ...base, dir: AXIS }, UP, sea)
      const crossing = waveGain({ ...base, dir: [1, 0, 0] }, UP, sea)
      if (settled === 0) {
        expect(aligned).toBeCloseTo(1, 12)
        expect(crossing).toBeCloseTo(1, 12)
      } else expect(aligned).toBeGreaterThan(crossing)
    }
    // The swell takes the swell's scale, squared; the wind sea the wind's;
    // the noise scales both.
    const sea: WaterSea = { windScale: 1.5, swellScale: 0.5, noise: 1.2, settled: 0, axis: AXIS }
    const swell = { ...base, dir: [1, 0, 0] as const, metres: 120 }
    const wind = { ...base, dir: [1, 0, 0] as const, metres: 5 }
    expect(waveGain(swell, UP, sea)).toBeCloseTo(1.2 * 0.25, 12)
    expect(waveGain(wind, UP, sea)).toBeCloseTo(1.2 * 1.5, 12)
  })

  it('tilts the view-space normal against the waves\' slope, the frame changed both ways (tides-rlj)', () => {
    // A frame that isn't its own transpose: view space to the ground's.
    const c = Math.cos(0.7), sn = Math.sin(0.7), c2 = Math.cos(-1.1), s2 = Math.sin(-1.1)
    const rx = [[1, 0, 0], [0, c, -sn], [0, sn, c]]
    const rz = [[c2, -s2, 0], [s2, c2, 0], [0, 0, 1]]
    const toGround = rz.map((r) => [0, 1, 2].map((j) => gDot(r, rx.map((q) => q[j]))))
    const toView = transpose(toGround)
    const up = norm([0.3, 0.9, -0.2])
    const glsl = WATER_GLSL(WATER_WAVE_TABLE)
    // The prelude's up in view space, on either chain: the ground's up seen
    // from view space.
    for (const [body, name, frame] of [
      [WATER_PRELUDE.globe.body, 'waterUpGround', 'uWaterViewToGround'],
      [WATER_PRELUDE.tiles.body, 'surfaceUp', 'uSurfaceViewToGround'],
    ] as const) {
      const line = body.split('\n').find((l) => l.startsWith('waterUpView ='))!
      const out = runGlsl(line, { [name]: up, [frame]: mat3(toGround) })
      expect(apply(toGround, out.waterUpView as number[]).map((x, i) => x - up[i]).every((d) => Math.abs(d) < 1e-12), body).toBe(true)
    }
    // One wave's block from the normal piece, at a pixel that draws it,
    // against waveSlope(), the TS mirror of its slope and fade.
    const sea: WaterSea = { windScale: 1.3, swellScale: 0.8, noise: 1.1, settled: 0.5, axis: levelAxis(up, 0.4) }
    const footprint = 2e-8 // ~4 cm: every wave drawn
    const e1 = levelAxis(up, 0)
    const e2 = levelAxis(up, Math.PI / 2)
    for (const w of [WATER_WAVE_TABLE[0], WATER_WAVE_TABLE[7]]) {
      const drawn = glsl.normal.indexOf(`uWavePhase[${w.index}]`)
      const start = glsl.normal.lastIndexOf(`waterD = vec3(${w.dir.map((x) => x.toFixed(6)).join(', ')});`, drawn)
      const end = glsl.normal.indexOf('}', drawn)
      const ray = [1.5e-4, -2e-5, 3e-5]
      const phases = new Array(WATER_WAVES).fill(0.9)
      const out = runGlsl(glsl.normal.slice(start, end + 1), {
        waterUpGround: up, waterAxis: [...sea.axis], waterSettled: sea.settled, waterGroups: 0, waterGroupNoise: [0, 0],
        waterWindF: sea.noise * sea.windScale, waterSwellF: sea.noise * sea.swellScale ** 2,
        waterRx: e1.map((x) => x * footprint), waterRy: e2.map((x) => x * footprint),
        waterWarpK: 0, waterBendK: 0, waterPx: footprint, waterAlong: 0, waterCross: 0, waterWarp: 0,
        waterBendNoise: [0, 0], waterRay: ray, uWavePhase: phases, waterGrad: [0, 0, 0],
      })
      const want = waveSlope(w, up, sea, footprint, 0.9 + w.k * gDot([...w.dir], ray))
      expect(Math.hypot(...want)).toBeGreaterThan(1e-3)
      for (let k = 0; k < 3; k++) expect((out.waterGrad as number[])[k]).toBeCloseTo(want[k], 5)
    }
    // The bent normal: the ground's up less the slope, seen from view space.
    const grad = [0.05, 0.02, -0.04]
    const line = glsl.normal.split('\n').find((l) => l.trim().startsWith('normal = normalize(normal -'))!
    const out = runGlsl(line, { normal: apply(toView, up), specularStrength: 1, waterGrad: grad, waterViewToGround: mat3(toGround) })
    const bent = apply(toGround, out.normal as number[])
    const expected = norm(up.map((x, i) => x - grad[i]) as V)
    for (let k = 0; k < 3; k++) expect(bent[k]).toBeCloseTo(expected[k], 9)
  })

  it('keeps its phases fixed to the Earth: the eye\'s phase plus k.ray is the phase at eye + ray', () => {
    const eye: V = [1.2, 2.1, -1.6] // ~2.9 units out, the ground's radius
    const ray: V = [3e-4, -1e-4, 2e-4]
    const at = new Float32Array(WATER_WAVES)
    const there = new Float64Array(WATER_WAVES) as unknown as number[]
    const here = new Float64Array(WATER_WAVES) as unknown as number[]
    for (const t of [0, 13.7]) {
      waterPhases(eye, t, here)
      waterPhases([eye[0] + ray[0], eye[1] + ray[1], eye[2] + ray[2]], t, there)
      for (const w of WATER_WAVE_TABLE) {
        const k = w.k * (w.dir[0] * ray[0] + w.dir[1] * ray[1] + w.dir[2] * ray[2])
        expect(angleGap(here[w.index] + k, there[w.index])).toBeLessThan(1e-6)
        expect(here[w.index]).toBeGreaterThanOrEqual(0)
        expect(here[w.index]).toBeLessThan(TAU)
      }
    }
    // And they travel: w t later, the same phase w t back.
    waterPhases(eye, 0, here)
    waterPhases(eye, 2, at)
    for (const w of WATER_WAVE_TABLE) expect(angleGap(at[w.index] + w.omega * 2, here[w.index])).toBeLessThan(1e-5)
  })

  it('takes the globe\'s ray in float from the eye split in double, so a ground point holds still under a moving eye (tides-rlj)', () => {
    // The GPU's arithmetic: every operation rounded to float32.
    const r = Math.fround
    const point: V = [r(1.2), r(2.1), r(-1.6)] // a vertex, fixed to the Earth
    const ray = (eye: V, split: boolean) =>
      point.map((p, i) => {
        if (!split) return r(p - r(eye[i])) // as from a float eye (modelViewMatrix's translation)
        const [hi, lo] = splitDouble(eye[i])
        return r(r(p - r(hi)) - r(lo))
      })
    const metres = EARTH_KM_PER_UNIT * 1000
    let worst = 0
    let naive = 0
    // The eye drifting a centimetre at a time, ~2 km over that point.
    for (let step = 0; step < 200; step++) {
      const eye: V = [1.2003 + step * 4.6e-9, 2.1002, -1.6001 + step * 2.3e-9]
      for (const split of [true, false]) {
        const at = ray(eye, split)
        const gap = Math.hypot(...[0, 1, 2].map((i) => eye[i] + at[i] - point[i])) * metres
        if (split) worst = Math.max(worst, gap)
        else naive = Math.max(naive, gap)
      }
    }
    expect(worst).toBeLessThan(0.002)
    expect(naive).toBeGreaterThan(0.1)
    for (const x of [2.95, -1.6000001234, 1e-9]) {
      const [hi, lo] = splitDouble(x)
      expect(Math.fround(hi)).toBe(hi)
      expect(hi + lo).toBe(x)
    }
    expect(WATER_GLOBE_VERTEX.body).toContain('(transformed - uWaterEyeHi) - uWaterEyeLo')
    expect(WATER_PRELUDE.globe.body).toContain('waterRay = vWaterRay;')
  })

  it('stands still under prefers-reduced-motion, and follows the frame\'s eye', () => {
    const haze = createGroundHaze({ value: new THREE.Vector3(1, 0, 0) }, 2.95, false)
    haze.frame.uGroundHazeEyeLocal.value.set(0.4, 2.9, 0.1)
    const water = createWater(haze.frame)
    water.update()
    const still = Array.from(water.uniforms.uWavePhase.value)
    water.advance(5, true)
    water.update()
    expect(Array.from(water.uniforms.uWavePhase.value)).toEqual(still)
    water.advance(5, false)
    water.update()
    expect(Array.from(water.uniforms.uWavePhase.value)).not.toEqual(still)
    const expected = new Float32Array(WATER_WAVES)
    waterPhases([0.4, 2.9, 0.1], 5, expected)
    for (let i = 0; i < WATER_WAVES; i++) expect(angleGap(water.uniforms.uWavePhase.value[i], expected[i])).toBeLessThan(1e-5)
    // The eye split for the globe's ray: the two halves add up to it.
    const hi = water.uniforms.uWaterEyeHi.value
    const lo = water.uniforms.uWaterEyeLo.value
    expect([hi.x + lo.x, hi.y + lo.y, hi.z + lo.z]).toEqual([0.4, 2.9, 0.1])
    // The climate is a still texture: the same one, unchanged, however the clock runs.
    const climate = water.uniforms.uWaterSea.value
    const version = climate.version
    water.advance(5, true)
    water.update()
    water.advance(5, false)
    water.update()
    expect(water.uniforms.uWaterSea.value).toBe(climate)
    expect(climate.version).toBe(version)
  })

  it('reads its noise off the Earth (the up alone), each octave seamless at the antimeridian and about its size', () => {
    const glsl = WATER_GLSL(WATER_WAVE_TABLE)
    expect(glsl.normal).toContain('vec2 waterLL = waterLonLat(waterUpGround);')
    expect(glsl.head).not.toContain('uWaterSwellEye')
    const kms = [...WATER_NOISE_KM, ...WATER_SWELL_KM]
    WATER_NOISE_CELLS.forEach((n, i) => {
      expect(n % NOISE_CELLS).toBe(0)
      expect((2 * Math.PI * EARTH_RADIUS_KM) / n / kms[i]).toBeGreaterThan(0.9)
      expect((2 * Math.PI * EARTH_RADIUS_KM) / n / kms[i]).toBeLessThan(1.15)
      // A tap per octave, at its own level.
      expect(glsl.normal).toContain(`waterLod + ${Math.log2(n).toFixed(6)})`)
    })
  })

  it('reads the skylight off one texel of the sky-view table, wherever the sea and the Sun are (tides-d9f.11)', () => {
    // haze.glsl skyViewTexel()'s coordinate, mirrored: the azimuth from the
    // Sun's over pi, the elevation squeezed toward the horizon.
    expect(hazeGlsl).toContain('vec2 uv = vec2(phi / 3.14159265, 0.5 + 0.5 * sign(e) * sqrt(abs(e) / SKY_VIEW_HALF_PI));')
    const uvOf = (rd: V, up: V, sun: V) => {
      const y = gDot(rd, up)
      const across = rd.map((x, i) => x - up[i] * y)
      const sunAcross = sun.map((x, i) => x - up[i] * gDot(sun, up))
      const phi = Math.acos(gDot(across, sunAcross) / Math.sqrt(gDot(across, across) * gDot(sunAcross, sunAcross)))
      const e = Math.asin(y)
      return [phi / Math.PI, 0.5 + 0.5 * Math.sign(e) * Math.sqrt(Math.abs(e) / (Math.PI / 2))]
    }
    const el = (WATER_SKY_LIGHT_ELEVATION * Math.PI) / 180
    for (const [up, sun] of [
      [norm([0.3, 0.9, -0.2]), norm([1, 0.2, 0.1])],
      [norm([-0.7, 0.1, 0.7]), norm([0.1, -0.3, 1])],
      [[0, 1, 0], norm([0.2, 0.05, -1])],
    ] as [V, V][]) {
      // The sky piece's direction: the side, cross(up, sun), lifted to the elevation.
      const side = norm([up[1] * sun[2] - up[2] * sun[1], up[2] * sun[0] - up[0] * sun[2], up[0] * sun[1] - up[1] * sun[0]])
      const rd = side.map((x, i) => x * Math.cos(el) + up[i] * Math.sin(el)) as V
      const uv = uvOf(rd, up, sun)
      expect(uv[0]).toBeCloseTo(WATER_SKY_LIGHT_UV[0], 9)
      expect(uv[1]).toBeCloseTo(WATER_SKY_LIGHT_UV[1], 9)
    }
    const glsl = WATER_GLSL(WATER_WAVE_TABLE)
    expect(glsl.sky).toContain(`${WATER_SKY_LIGHT_UV.map((x) => x.toFixed(6)).join(', ')})`)
    expect(glsl.sky).toContain(`waterSide * ${Math.cos(el).toFixed(6)} + waterUpGround * ${Math.sin(el).toFixed(6)}, vec2(`)
  })
})

describe('the body (tides-07z)', () => {
  it('leaves colour well lighter than the open sea, and the land, as it is', () => {
    for (const c of [[0.15, 0.2, 0.15], [0.2, 0.3, 0.1]] as V[]) {
      for (const depth of [0, 50, 500, 3000, 10000]) waterBody(c, 1, depth).forEach((x, i) => expect(x).toBeCloseTo(c[i], 12))
    }
    const dark: V = [0.001, 0.002, 0.004]
    for (const depth of [0, 3000]) expect(waterBody(dark, 0, depth)).toEqual(dark)
  })

  it('lifts darker water to deep water\'s floor, monotonically', () => {
    waterBody([0, 0, 0], 1).forEach((x, i) => expect(x).toBeCloseTo(WATER_DEEP[i], 12))
    const lum = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    let last = 0
    for (let g = 0; g <= WATER_KEEP[0]; g += 0.001) {
      const out = lum(waterBody([g, g, g], 1))
      expect(out).toBeGreaterThanOrEqual(last - 1e-12)
      expect(out).toBeGreaterThanOrEqual(WATER_DEEP_LUMA - 1e-12)
      last = out
    }
  })

  it('tints the map\'s sea for its depth (tides-d9f.6), in step with strength', () => {
    const sea: V = [0.012, 0.09, 0.16]
    for (const depth of [0, 50, 500, 3000, 10000]) {
      const tinted = waterTinted(sea, depth)
      waterBody(sea, 1, depth).forEach((x, i) => expect(x).toBeCloseTo(tinted[i], 12))
      waterBody(sea, 0.5, depth).forEach((x, i) => expect(x).toBeCloseTo((sea[i] + tinted[i]) / 2, 12))
    }
  })
})

/** three's own samplers the globe's Phong program uses (its maps and the
 * Sun's shadow), measured in the browser. */
const GLOBE_THREE_SAMPLERS = 5

describe('the water\'s GLSL on the globe (tides-07z)', () => {
  const sun = { value: new THREE.Vector3(1, 0, 0) }
  const haze = createGroundHaze(sun, 2.95, false)
  const depth = { value: new THREE.Texture() }

  it('replaces three\'s own direct light, the glint for its specular line only', () => {
    // A three upgrade that changes RE_Direct_BlinnPhong fails here, not on screen.
    expect(THREE.ShaderChunk.lights_phong_pars_fragment).toContain(BLINN_PHONG_DIRECT)
    const direct = WATER_GLSL(WATER_WAVE_TABLE).direct
    expect(direct).toContain(
      '\tif ( material.specularStrength > 0.0 ) reflectedLight.directSpecular += material.specularStrength * waterGlint( directLight.direction, geometryViewDir, geometryNormal ) * directLight.color;'
    )
    expect(direct).not.toContain('BRDF_BlinnPhong')
    const lines = direct.split('\n')
    const blinn = BLINN_PHONG_DIRECT.split('\n')
    expect(lines[0]).toBe(blinn[0].replace('RE_Direct_BlinnPhong(', 'RE_Direct_Water('))
    expect(lines.slice(1, 4)).toEqual(blinn.slice(1, 4))
    expect(direct).toContain('#undef RE_Direct\n#define RE_Direct RE_Direct_Water')
  })

  it('lands each piece where it belongs, and the sky before the shadows dim the specular', () => {
    const water = createWater(haze.frame)
    const eclipse = createEclipseShadow('earth')
    const clouds = createCloudLayer(eclipse, false)
    const patch = composePatches(
      eclipse.material,
      clouds.groundPatch,
      groundDetailPatch(false),
      groundShadowPatch(sun, earthHorizon('horizon.bin')),
      waterPatch(water, haze.frame, false, depth),
      haze.patch
    )
    const shader = phongShader()
    patch.onBeforeCompile(shader, {} as THREE.WebGLRenderer)
    const f = shader.fragmentShader
    const glsl = WATER_GLSL(WATER_WAVE_TABLE)
    const at = (text: string) => {
      const i = f.indexOf(text)
      expect(i, text.slice(0, 60)).toBeGreaterThan(-1)
      return i
    }
    expect(at('#include <common>')).toBeLessThan(at('uniform float uWavePhase[12];'))
    expect(at('uniform float uWavePhase[12];')).toBeLessThan(at('void main'))
    expect(at('#include <lights_phong_pars_fragment>')).toBeLessThan(at('#define RE_Direct RE_Direct_Water'))
    // The waves after every patch's normal_fragment_maps code (the ground
    // detail's groundUp stays the unbent normal), before the emissive.
    expect(at('vec3 groundUp = normal;')).toBeLessThan(at(WATER_PRELUDE.globe.body + glsl.normal))
    expect(at(glsl.normal)).toBeLessThan(at('#include <emissivemap_fragment>'))
    // The sky after the lights, before the terrain shadow, the cloud
    // shadow and the eclipse multiply directSpecular.
    const sky = at(glsl.sky)
    expect(at('#include <lights_fragment_end>')).toBeLessThan(sky)
    expect(sky).toBeLessThan(at('reflectedLight.directSpecular *= sunLit;'))
    expect(sky).toBeLessThan(at('reflectedLight.directSpecular *= cloudLit;'))
    expect(sky).toBeLessThan(at('reflectedLight.directSpecular *= eclipse.x;'))
    // The skylit body before the terrain's view of the sky dims it.
    expect(sky).toBeLessThan(at('reflectedLight.indirectDiffuse *= groundHorizonSky;'))
    // The sky is the ground haze's (its head before main), scene radiance,
    // not over the Sun's colour.
    expect(at('vec3 groundHazeSky(vec3 up, vec3 rd) {')).toBeLessThan(at('void main'))
    expect(glsl.sky.split('groundHazeSky(').length - 1).toBe(1)
    expect(glsl.sky.split('groundHazeSkyAt(').length - 1).toBe(1)
    expect(glsl.sky).not.toContain('skyRadiance')
    expect(glsl.sky).not.toContain('directionalLights[0].color')
    expect(glsl.sky).toContain('reflectedLight.directSpecular += material.specularStrength * waterDay * waterReflection;')
    expect(glsl.sky).toContain(`waterSkyBody = ${WATER_BODY_SKY.toFixed(6)} * material.specularStrength * waterDay * waterBodyLight;`)
    expect(glsl.sky).toContain('reflectedLight.indirectDiffuse += waterSkyBody;')
    // One Sun for the sky and the side it's read from.
    expect(glsl.sky).toContain('cross(waterUpGround, uGroundHazeSun)')
    // The eclipse dims the skylit body, after the terrain's view of the sky.
    expect(sky).toBeLessThan(at('reflectedLight.indirectDiffuse -= (1.0 - eclipse.x) * waterSkyBody;'))
    expect(at('reflectedLight.indirectDiffuse *= groundHorizonSky;')).toBeLessThan(at('waterSkyBody *= groundHorizonSky;'))
    expect(at('#define WATER_SKY_BODY')).toBeLessThan(at('void main'))
    // The ground's sky fill leaves the water to its own skylight.
    expect(at('float groundSkyFill = GROUND_SKY_FILL * (1.0 - specularStrength);')).toBeGreaterThan(at('void main'))
    expect(glsl.sky).toContain(`smoothstep(${SKY_DAY[0].toFixed(6)}, ${SKY_DAY[1].toFixed(6)}, dot(waterUpView, directionalLights[0].direction))`)
    // The body after the strength, before the lights take the colour, by
    // day only (the Sun over this sea's level).
    expect(at('#include <specularmap_fragment>')).toBeLessThan(at('waterBody(diffuseColor.rgb)'))
    expect(at('waterBody(diffuseColor.rgb)')).toBeLessThan(at('#include <lights_phong_fragment>'))
    expect(glsl.normal).toMatch(/waterBody\(diffuseColor\.rgb\),\s*specularStrength \* smoothstep\([^)]*dot\(waterUpView, directionalLights\[0\]\.direction\)\)/)
    // Its uniforms: the phases and the haze's frame, the same objects.
    expect(shader.uniforms.uWavePhase).toBe(water.uniforms.uWavePhase)
    expect(shader.uniforms.uWaterViewToGround).toBe(haze.frame.uGroundHazeViewToLocal)
    expect(shader.uniforms.uWaterEyeGround).toBe(haze.frame.uGroundHazeEyeLocal)
    expect(shader.uniforms.uWaterDepth).toBe(depth)
    // The depth's uniform with the globals, its sample at the prelude's end,
    // before the body reads it.
    expect(at('uniform sampler2D uWaterDepth;')).toBeLessThan(at('void main'))
    expect(at('vec3 waterTinted(vec3 c)')).toBeLessThan(at('vec3 waterBody(vec3 c)'))
    expect(WATER_PRELUDE.globe.body.endsWith(WATER_DEPTH_SAMPLE.globe)).toBe(true)
    expect(WATER_DEPTH_SAMPLE.globe).toContain('texture2D(uWaterDepth, vSpecularMapUv).r')
    expect(at(WATER_DEPTH_SAMPLE.globe)).toBeLessThan(at('waterBody(diffuseColor.rgb)'))
    // The wave climate and the sea's noise: one more sampler, the water's
    // own texture array.
    expect(shader.uniforms.uWaterSea).toBe(water.uniforms.uWaterSea)
    expect(f.split('uniform sampler2DArray uWaterSea;').length - 1).toBe(1)
    // Within the 16 texture units WebGL promises: the patches' own samplers
    // plus three's own Phong ones the globe uses (measured in the browser:
    // 15 active with the climate, of 16).
    const own = f.match(/uniform\s+sampler\w+\s+\w+/g) ?? []
    expect(own.length + GLOBE_THREE_SAMPLERS, own.join(', ')).toBeLessThanOrEqual(16)
    // One varying of its own, the ray (tides-rlj), set after the vertex is
    // displaced and projected.
    const base = phongShader()
    composePatches(eclipse.material, clouds.groundPatch, groundDetailPatch(false), groundShadowPatch(sun, earthHorizon('horizon.bin')), haze.patch)
      .onBeforeCompile(base, {} as THREE.WebGLRenderer)
    expect(f.split('varying ').length).toBe(base.fragmentShader.split('varying ').length + 1)
    expect(shader.vertexShader.split('varying ').length).toBe(base.vertexShader.split('varying ').length + 1)
    const v = shader.vertexShader
    expect(v.indexOf(WATER_GLOBE_VERTEX.body)).toBeGreaterThan(v.indexOf('#include <project_vertex>'))
    expect(v.indexOf('#include <displacementmap_vertex>')).toBeLessThan(v.indexOf('#include <project_vertex>'))
    expect(shader.uniforms.uWaterEyeHi).toBe(water.uniforms.uWaterEyeHi)
    expect(shader.uniforms.uWaterEyeLo).toBe(water.uniforms.uWaterEyeLo)
  })

  it('takes the tier\'s waves, keyed by their count', () => {
    const water = createWater(haze.frame)
    expect(waterPatch(water, haze.frame, false, depth).customProgramCacheKey()).toBe('water-12')
    expect(waterPatch(water, haze.frame, true, depth).customProgramCacheKey()).toBe('water-6')
    const full = WATER_GLSL(waterWaves(false)).normal
    const low = WATER_GLSL(waterWaves(true)).normal
    // The full tier draws its waves in three steps (the longest 4, 8, all).
    expect(full.split('waterGrad -=').length - 1).toBe(WATER_WAVES + 4 + 8)
    for (const w of waterWaves(false)) expect(full).toContain(`uWavePhase[${w.index}]`)
    expect(low.split('waterGrad -=').length - 1).toBe(WATER_WAVES_LOW)
    for (const w of waterWaves(true)) expect(low).toContain(`uWavePhase[${w.index}]`)
  })

  it('takes its derivatives before any branch, and skips the water where the strength is 0 and each wave where it has faded', () => {
    for (const low of [false, true]) {
      const glsl = WATER_GLSL(waterWaves(low))
      const normal = glsl.normal
      const firstBranch = Math.min(normal.indexOf('if ('), normal.indexOf('?'))
      expect(normal.indexOf('dFdx(waterRay)')).toBeGreaterThan(-1)
      expect(normal.indexOf('dFdy(waterRay)')).toBeLessThan(firstBranch)
      expect(normal.split('dFd').length - 1).toBe(2)
      // Nothing in the glint, the noise or the climate's lookup asks for derivatives.
      expect(glsl.head).not.toMatch(/dFd|fwidth|texture2D|texture\(/)
      expect(glsl.head).toContain('textureLod(uWaterSea')
      expect(normal).toContain('if (specularStrength > 0.0) {')
      // Each wave's sine only where it's drawn; its variance everywhere on water.
      const count = low ? WATER_WAVES_LOW : WATER_WAVES
      // Every wave in each step: where all have faded (a pixel wider than
      // the longest wave's fade) only their variance; on the full tier, where
      // the shorter ones have, the longer drawn (4, 8) and the rest faded;
      // else all drawn.
      const kept = low ? [] : [4, 8]
      expect(normal.split('if (waterW > 0.0) {').length - 1).toBe(count + kept.reduce((a, b) => a + b, 0))
      expect(normal.split('waterLost = ').length - 1).toBe((2 + kept.length) * count)
      expect(normal.indexOf('if (waterFadedNarrow > ')).toBeLessThan(normal.indexOf('if (waterW > 0.0) {'))
      expect(normal.split('} else')[0].split('if (waterFadedNarrow > ')[1]).not.toContain('sin(')
      for (const chunk of normal.split('if (waterW > 0.0) {').slice(1)) {
        expect(chunk.indexOf('sin(')).toBeLessThan(chunk.indexOf('}'))
      }
      // The old eye-spread footprint and its ring are gone.
      expect(normal).not.toContain('waterFootprint')
      expect(normal).not.toContain('isOrthographic')
    }
    expect(WATER_GLSL(WATER_WAVE_TABLE).sky).toContain('if (material.specularStrength > 0.0) {')
  })
})
