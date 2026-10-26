import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { activeRegions, allSunspots } from './sun-activity'
import { SUN_SPOT_CAPACITY, surfaceBakeUniforms } from './sun-surface'
import {
  createProminenceGeometry,
  PROMINENCE_BUDGET,
  PROMINENCE_KIND,
  PROMINENCE_TOP,
  strandPoints,
} from './sun-prominences'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const DEG = 180 / Math.PI

describe('the Sun\'s activity layout', () => {
  it('is the same on every call, so scrubbing the date shows the same Sun', () => {
    expect(activeRegions()).toEqual(activeRegions())
  })

  it('keeps every spot group in the activity belts', () => {
    for (const region of activeRegions()) {
      const lat = Math.abs(region.lat * DEG)
      expect(lat).toBeGreaterThanOrEqual(5)
      expect(lat).toBeLessThanOrEqual(35)
      for (const spot of region.spots) {
        expect(Math.hypot(...spot.dir)).toBeCloseTo(1, 9)
        expect(Math.abs(Math.asin(spot.dir[1]) * DEG)).toBeLessThan(40)
      }
    }
  })

  it('fits the bake\'s spot array', () => {
    expect(allSunspots().length).toBeLessThanOrEqual(SUN_SPOT_CAPACITY)
    const uniforms = surfaceBakeUniforms()
    expect(uniforms.uSpots.value).toHaveLength(SUN_SPOT_CAPACITY)
    expect(uniforms.regionCount).toBe(activeRegions().length)
  })
})

describe('the photosphere', () => {
  const renderer = read('./SunRenderer.tsx')
  const fragment = read('../shaders/sun/fragment.frag')

  it('no longer renders a cube map every frame (tides-d9x)', () => {
    expect(renderer).not.toMatch(/CubeCamera/)
    expect(renderer).not.toMatch(/frames=\{Infinity\}/)
  })

  it('costs three texture lookups and no noise per pixel', () => {
    expect(fragment.match(/textureCube\(/g)).toHaveLength(3)
    expect(fragment).not.toMatch(/snoise|worley/)
  })

  it('bakes its churn with the rest, not per frame', () => {
    expect(read('./sun-surface.ts')).toMatch(/plasmaBakeFragment/)
    expect(renderer).toMatch(/uPlasma: \{ value: surface\.plasma \}/)
  })
})

describe('the corona', () => {
  const fragment = read('../shaders/sun-corona/fragment.frag')

  it('reads its streamers from the baked pattern, once, with no noise per pixel', () => {
    expect(fragment.match(/textureCube\(/g)).toHaveLength(1)
    expect(fragment).not.toMatch(/snoise|noise3/)
  })

  it('reads the pattern in the Sun\'s frame, not the screen\'s', () => {
    expect(fragment).toContain('normalize(vSolarPlane / max(r, 1e-4) + vSolarLimb)')
  })
})

describe('the prominences and loops', () => {
  it('fit their per-tier budgets, the phone tier well under the desktop one', () => {
    const high = createProminenceGeometry(false)
    const low = createProminenceGeometry(true)
    const highVerts = high.getAttribute('position').count
    const lowVerts = low.getAttribute('position').count
    expect(lowVerts).toBeLessThan(highVerts / 2)
    // Two vertices per spine sample.
    expect(lowVerts % ((PROMINENCE_BUDGET.low.segments + 1) * 2)).toBe(0)
    expect(highVerts).toBeLessThan(20000)
    for (const name of ['aTangent', 'aStrand', 'aKind']) {
      expect(high.getAttribute(name).count).toBe(highVerts)
    }
    high.dispose()
    low.dispose()
  })

  it('stand on the surface and stay under PROMINENCE_TOP', () => {
    for (const low of [false, true]) {
      for (const { points } of strandPoints(low)) {
        const radii = points.map((p) => Math.hypot(...p))
        // Feet sink just under the limb, where the Sun hides them.
        expect(radii[0]).toBeLessThan(1)
        expect(radii[0]).toBeGreaterThan(0.98)
        for (const r of radii) expect(r).toBeLessThan(PROMINENCE_TOP)
      }
    }
  })

  it('include arches, hedgerows and loops, and are deterministic', () => {
    const kinds = new Set(strandPoints(false).map((s) => s.kind))
    expect(kinds).toEqual(new Set(Object.values(PROMINENCE_KIND)))
    expect(strandPoints(true)).toEqual(strandPoints(true))
  })

  it('test the Sun along the ray, as the depth test can tie at ship range', () => {
    const fragment = read('../shaders/sun-prominence/fragment.frag')
    expect(fragment).toMatch(/if \(b > 0\.0 && across > 0\.99\) discard;/)
  })
})
