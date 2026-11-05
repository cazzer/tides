import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const fragment = readFileSync(new URL('../shaders/aurora/fragment.frag', import.meta.url), 'utf8')

const num = (re: RegExp) => {
  const m = fragment.match(re)
  if (!m) throw new Error(`not in the aurora shader: ${re}`)
  return Number(m[1])
}

// The march's floor (tides-0oi.4): with no storm a step below
// min(diffuseLat - 1, eqLat - 4.2) - 0.3 is skipped, which is exact only
// while the terms it was derived from stay as they are.
describe('the aurora march floor', () => {
  it('keeps the SAR floor in a storm and the tighter one without', () => {
    expect(fragment).toContain(
      'if (mlat < (storm > 0.0 ? sarLat - 4.0 : min(diffuseLat - 1.0, eqLat - 4.2) - 0.3) || mlat > polLat + 1.5) continue;'
    )
  })

  it('lies below where the band starts', () => {
    const bandFrom = num(/float band = smoothstep\(diffuseLat - ([\d.]+), diffuseLat/)
    expect(bandFrom).toBeLessThanOrEqual(1.0)
  })

  it('lies below the lowest the arcs reach with no storm, at |noise| <= 1', () => {
    const arcsFrom = num(/if \(d > -([\d.]+) && d < offset\.z/)
    const meander = num(/float d = mlat - eqLat - \(([\d.]+) \+ [\d.]+ \* storm\) \* meander - foldAmp \* fold;/)
    const fold = fragment.match(/float foldAmp = ([\d.]+) \+ ([\d.]+) \* surge \+ [\d.]+ \* storm;/)
    expect(fold).not.toBeNull()
    const foldMax = Number(fold![1]) + Number(fold![2])
    expect(arcsFrom + meander + foldMax).toBeLessThanOrEqual(4.2 + 1e-9)
  })

  it('has no red but the storm\'s and the arcs\'', () => {
    expect(fragment).toContain('float red = sarH * storm * ')
    const arcsBlock = fragment.indexOf('if (d > -2.5')
    const redAdds = [...fragment.matchAll(/red \+= /g)].map((m) => m.index)
    expect(redAdds.length).toBeGreaterThan(0)
    for (const at of redAdds) expect(at).toBeGreaterThan(arcsBlock)
    // The arcs block closes before the red is added to the step.
    expect(fragment.indexOf('e += RED * red;')).toBeGreaterThan(Math.max(...redAdds))
  })
})
