import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CURTAIN_ROWS, CURTAIN_WIDTH } from './auroraCurtain'

const fragment = readFileSync(new URL('../shaders/aurora/fragment.frag', import.meta.url), 'utf8')

const GATE =
  'if (mlat < (storm > 0.0 ? sarLat - 4.0 : min(diffuseLat - 1.0, eqLat - 4.2) - 0.3) || mlat > polLat + 1.5) continue;'
const gate = GATE.match(/min\(diffuseLat - ([\d.]+), eqLat - ([\d.]+)\) - ([\d.]+)/)!
const gateBelowDiffuse = Number(gate[1])
const gateBelowEq = Number(gate[2])

const match = (re: RegExp) => {
  const m = fragment.match(re)
  if (!m) throw new Error(`not in the aurora shader: ${re}`)
  return m
}

// The arcs block: from its test to the brace that closes it.
const arcsBlock = (() => {
  const start = fragment.indexOf('if (d > -2.5 && d < offset.z + 3.0) {')
  if (start < 0) throw new Error('no arcs block in the aurora shader')
  let depth = 0
  for (let i = fragment.indexOf('{', start); i < fragment.length; i++) {
    if (fragment[i] === '{') depth++
    else if (fragment[i] === '}' && --depth === 0) return { start, end: i + 1 }
  }
  throw new Error('the arcs block never closes')
})()

// The march's floor (tides-0oi.4): with no storm a step below
// min(diffuseLat - 1, eqLat - 4.2) - 0.3 is skipped, which is exact only
// while the terms it was derived from stay as they are.
describe('the aurora march floor', () => {
  it('keeps the SAR floor in a storm and the tighter one without', () => {
    expect(fragment).toContain(GATE)
  })

  it('lies below where the band, and so the glow, starts', () => {
    const bandFrom = Number(match(/float band = smoothstep\(diffuseLat - ([\d.]+), diffuseLat/)[1])
    expect(bandFrom).toBeLessThanOrEqual(gateBelowDiffuse)
    expect(fragment).toContain('float glow = band * ')
  })

  it('lies below the lowest the arcs reach with no storm, at |noise| <= 1', () => {
    const arcsFrom = Number(match(/if \(d > -([\d.]+) && d < offset\.z/)[1])
    const meander = Number(match(/float d = mlat - eqLat - \(([\d.]+) \+ [\d.]+ \* storm\) \* meander - foldAmp \* fold;/)[1])
    // surge is in [0, 1], so with no storm foldAmp is at most c0 + c1.
    expect(fragment).toContain('float surge = 0.5 + 0.5 * cos(')
    const fold = match(/float foldAmp = ([\d.]+) \+ ([\d.]+) \* surge \+ [\d.]+ \* storm;/)
    const foldMax = Number(fold[1]) + Number(fold[2])
    expect(arcsFrom + meander + foldMax).toBeLessThanOrEqual(gateBelowEq + 1e-9)
  })

  it('has no emission but the glow, the storm\'s red and what the arcs block adds', () => {
    const outside = ['red = sarH * storm * ', 'e = GREEN * glowH * glow;', 'e += RED * red;']
    for (const o of outside) expect(fragment).toContain(o)
    const writes = [...fragment.matchAll(/(?<![\w.])(?:e|red) \+?= [^;]*;/g)]
    expect(writes.length).toBeGreaterThan(outside.length)
    for (const w of writes) {
      if (outside.some((o) => w[0].startsWith(o))) continue
      expect(w.index > arcsBlock.start && w.index < arcsBlock.end, w[0]).toBe(true)
    }
  })
})

// The curtains' baked noise (tides-0oi.5): the bake and the live fallback
// evaluate the same four expressions, over ranges that cover every place the
// march reads them, and the march reads them only past its floor.
describe('the aurora curtain table', () => {
  const curtain = readFileSync(new URL('../shaders/aurora/curtain.glsl', import.meta.url), 'utf8')
  const bake = readFileSync(new URL('../shaders/aurora/curtainBake.frag', import.meta.url), 'utf8')
  const renderer = readFileSync(new URL('./AuroraRenderer.tsx', import.meta.url), 'utf8')
  const num = (src: string, re: RegExp) => {
    const m = src.match(re)
    if (!m) throw new Error(`not found: ${re}`)
    return Number(m[1])
  }
  const MLAT_MIN = num(curtain, /const float CURTAIN_MLAT_MIN = (-?[\d.]+);/)
  const MLAT_MAX = num(curtain, /const float CURTAIN_MLAT_MAX = (-?[\d.]+);/)
  const D_MIN = num(curtain, /const float CURTAIN_D_MIN = (-?[\d.]+);/)
  const D_MAX = num(curtain, /const float CURTAIN_D_MAX = (-?[\d.]+);/)

  it('keeps the four noise expressions as the march had them', () => {
    // As in fragment.frag at 2b6fa89, word for word.
    for (const e of [
      'return snoise3(vec3(around * 1.7 + hemi, t * 0.012));',
      'return snoise3(vec3(around * 4.5 + vec2(t * 0.02, -hemi), mlat * 0.4 - t * 0.015));',
      'return snoise3(vec3(around * 3.4 - hemi, t * 0.01 + 5.0));',
      'return snoise3(vec3(around * 5.2 + hemi, d * 0.15 + t * 0.012 + 11.0));',
    ]) expect(curtain).toContain(e)
    expect(fragment).not.toContain('snoise3(vec3(around')
    // The same hemispheres, the same around, in the march and the bake.
    expect(fragment).toContain('float hemi = m > 0.0 ? 0.0 : 37.0;')
    expect(fragment).toContain('vec2 around = vec2(cos(ang), sin(ang));')
    expect(bake).toContain('float hemi = south ? 37.0 : 0.0;')
    expect(bake).toContain('vec2 around = vec2(cos(ang), sin(ang));')
    expect(fragment).toContain('float ang = atan(dot(q, dawn), dot(q, midnight));')
  })

  it('covers the march from its 35° cut to the pole', () => {
    const cut = Number(match(/if \(mlat < ([\d.]+)\) continue;/)[1])
    expect(MLAT_MIN).toBeLessThanOrEqual(cut)
    expect(MLAT_MAX).toBe(90)
  })

  it('covers every d the arcs block reads breaks2 at', () => {
    const arcsFrom = -Number(match(/if \(d > -([\d.]+) && d < offset\.z/)[1])
    const arcsPast = Number(match(/d < offset\.z \+ ([\d.]+)\) \{/)[1])
    const arcAt = match(/const vec3 ARC_AT = vec3\(([\d.]+), ([\d.]+), ([\d.]+)\);/)
    const off = match(/vec3 offset = ARC_AT \* \(([\d.]+) \+ ([\d.]+) \* storm\) \+ vec3\([\d.]+, [\d.]+, ([\d.]+)\) \* fold;/)
    // storm and |fold| are at most 1.
    const offsetZMax = Number(arcAt[3]) * (Number(off[1]) + Number(off[2])) + Number(off[3])
    expect(D_MIN).toBeLessThanOrEqual(arcsFrom)
    expect(D_MAX).toBeGreaterThanOrEqual(offsetZMax + arcsPast)
  })

  it('decodes what the bake encodes, row for row', () => {
    // The strip (meander, breaks per angle and hemisphere), copied texel for
    // texel into the table's r and b beside fold and breaks2.
    expect(bake).toContain(
      'gl_FragColor = vec4(curtainMeander(around, hemi, uTime), curtainBreaks(around, hemi, uTime), 0.0, 0.0) * 0.5 + 0.5;'
    )
    expect(bake).toContain('float hemi = row >= 1.0 ? 37.0 : 0.0;')
    expect(bake).toContain('vec2 mb = texelFetch(uStrip, ivec2(gl_FragCoord.x, south ? 1 : 0), 0).rg;')
    expect(bake).toMatch(/gl_FragColor = vec4\(\s*mb\.x,\s*curtainFold\(around, hemi, mlat, uTime\) \* 0\.5 \+ 0\.5,\s*mb\.y,\s*curtainBreaks2\(around, hemi, d, uTime\) \* 0\.5 \+ 0\.5\s*\);/)
    expect(bake).toContain('float mlat = CURTAIN_MLAT_MIN + (CURTAIN_MLAT_MAX - CURTAIN_MLAT_MIN) * r / (rows - 1.0);')
    expect(bake).toContain('float d = CURTAIN_D_MIN + (CURTAIN_D_MAX - CURTAIN_D_MIN) * r / (rows - 1.0);')
    expect(bake).toContain('float ang = (gl_FragCoord.x / float(CURTAIN_WIDTH) - 0.5) * TAU;')
    expect(curtain).toContain('float row = clamp((x - x0) / (x1 - x0), 0.0, 1.0) * (rows - 1.0) + 0.5 + hemiRow;')
    expect(curtain).toContain('return vec2(ang / TAU + 0.5, row / (2.0 * rows));')
    expect(fragment).toContain(
      'vec3 mfb = textureLod(uCurtain, curtainUv(ang, mlat, CURTAIN_MLAT_MIN, CURTAIN_MLAT_MAX, hemiRow), 0.0).rgb * 2.0 - 1.0;'
    )
    expect(fragment).toContain(
      'float breaks2 = textureLod(uCurtain, curtainUv(ang, d, CURTAIN_D_MIN, CURTAIN_D_MAX, hemiRow), 0.0).a * 2.0 - 1.0;'
    )
    expect(fragment).toContain('float hemiRow = m > 0.0 ? 0.0 : float(CURTAIN_ROWS);')
    // The tap, mirrored: x = x0 + (x1 - x0) * r / (N - 1) lands on texel r's
    // centre in its hemisphere's half, and the bake's row (floor of
    // gl_FragCoord.y there) gives back the same r.
    const N = CURTAIN_ROWS, W = CURTAIN_WIDTH
    for (const hemiRow of [0, N]) {
      for (const r of [0, 1, 127, N - 2, N - 1]) {
        const x = D_MIN + ((D_MAX - D_MIN) * r) / (N - 1)
        const row = Math.min(Math.max((x - D_MIN) / (D_MAX - D_MIN), 0), 1) * (N - 1) + 0.5 + hemiRow
        const fragY = (row / (2 * N)) * 2 * N
        expect(fragY).toBeCloseTo(r + hemiRow + 0.5, 9)
      }
    }
    for (const i of [0, W / 2 - 1, W - 1]) {
      const ang = ((i + 0.5) / W - 0.5) * 2 * Math.PI
      expect((ang / (2 * Math.PI) + 0.5) * W).toBeCloseTo(i + 0.5, 9)
    }
  })

  it('reads the table only past the floor, and breaks2 only in the arcs block', () => {
    const gate = fragment.indexOf(GATE)
    // Level 0 explicitly: they sit in non-uniform control flow.
    expect(fragment).not.toMatch(/texture2D\(uCurtain/)
    const taps = [...fragment.matchAll(/textureLod\(uCurtain/g)].map((m) => m.index)
    expect(taps.length).toBe(2)
    for (const at of taps) expect(at).toBeGreaterThan(gate)
    expect(taps[1] > arcsBlock.start && taps[1] < arcsBlock.end).toBe(true)
    const live = fragment.indexOf('float breaks2 = curtainBreaks2(around, hemi, d, t);')
    expect(live > arcsBlock.start && live < arcsBlock.end).toBe(true)
  })

  it('gives the glow the same table, on its own short march', () => {
    expect(renderer).toContain('defines: { ...material.defines, STEPS: AURORA_GLOW_STEPS },')
  })

  it('keeps the old 10-step march where the table cannot be made', () => {
    expect(renderer).toContain('STEPS: low ? (curtain ? 14 : 10) : 24,')
    expect(renderer).toContain('...(curtain && { CURTAIN_BAKE: 1, CURTAIN_WIDTH, CURTAIN_ROWS }),')
  })

  it('bakes from the priority-0 frame callback, before any View draws', () => {
    // Once, in the one useFrame (default priority 0; drei's Views draw at 1),
    // at this frame's uTime: never from a draw, where its target switch
    // would split a View's pass.
    expect([...renderer.matchAll(/curtain\?\.bake\(/g)]).toHaveLength(1)
    expect([...renderer.matchAll(/useFrame\(/g)]).toHaveLength(1)
    expect(renderer).toMatch(/useFrame\(\(state, delta\) => \{/)
    const frame = renderer.slice(renderer.indexOf('useFrame((state, delta) => {'))
    const body = frame.slice(0, frame.indexOf('\n  })\n'))
    expect(body).toMatch(/u\.uTime\.value = state\.clock\.elapsedTime\n(?:\s*\/\/.*\n)*\s*curtain\?\.bake\(u\.uTime\.value\)/)
    expect(renderer).not.toContain('onBeforeRender = (_renderer, _scene, camera, _geometry, shader) => {\n    bake')
  })
})
