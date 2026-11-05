import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

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
