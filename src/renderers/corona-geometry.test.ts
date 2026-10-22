import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  CORONA_MAX_ANGLE,
  CORONA_OUTER_PERSPECTIVE as OUTER,
  perspectiveCoronaQuad,
  type CoronaQuad,
} from './corona-geometry'

const DEG = Math.PI / 180
const R = 10

/** The Sun's centre in view space, `distance` away and `deg` off the view axis. */
const sunAt = (deg: number, distance: number, roll = 0): [number, number, number] => [
  distance * Math.sin(deg * DEG) * Math.cos(roll),
  distance * Math.sin(deg * DEG) * Math.sin(roll),
  -distance * Math.cos(deg * DEG),
]

/**
 * The quad's corners where they land on screen, as tangents of the angle off
 * the view axis (x/−z, y/−z), projected as vertex.glsl's gl_Position does.
 */
function screenCorners(quad: CoronaQuad, c: readonly number[]): [number, number][] {
  const corners: [number, number][] = []
  for (const u of [-OUTER, OUTER]) {
    for (const v of [-OUTER, OUTER]) {
      const x = (quad.centre[0] + u * quad.limb) * quad.push
      const y = (quad.centre[1] + v * quad.limb) * quad.push
      const z = c[2] * quad.push
      corners.push([x / -z, y / -z])
    }
  }
  return corners
}

/** The fragment shader's r (limb radii from the quad centre) at screen tangent `p`. */
const rAt = (quad: CoronaQuad, c: readonly number[], p: [number, number]) =>
  Math.hypot(p[0] * -c[2] - quad.centre[0], p[1] * -c[2] - quad.centre[1]) / quad.limb

/** vertex.glsl before tides-2hv.1, which clamped only the far limb. */
function unfixedQuad(c: [number, number, number], radius: number) {
  const depth = Math.max(-c[2], 1e-4)
  const off = Math.hypot(c[0], c[1]) / depth
  const theta = Math.atan(off)
  const tanAlpha = radius / Math.sqrt(Math.max(c[0] ** 2 + c[1] ** 2 + c[2] ** 2 - radius ** 2, 1e-8))
  const beta = Math.atan(Math.cos(theta) * tanAlpha)
  const far = Math.tan(Math.min(theta + beta, 1.55))
  const near = Math.tan(theta - beta)
  const outward = off > 1e-6 ? [c[0] / (off * depth), c[1] / (off * depth)] : [1, 0]
  const mid = 0.5 * (far + near) * depth
  return { centre: [outward[0] * mid, outward[1] * mid], limb: 0.5 * (far - near) * depth }
}

describe('perspectiveCoronaQuad', () => {
  // The headless repro: camera 50 units from a radius-10 Sun (the View from
  // Earth panel's ~11.5° angular radius), turned so the Sun is `deg` off axis.
  describe.each([60, 89.5, 89.9, 90, 90.5, 179])('Sun %s° off the view axis', (deg) => {
    const c = sunAt(deg, 50)
    const quad = perspectiveCoronaQuad(c, R)

    it('is collapsed, or a finite quad no more than a few screens across', () => {
      if (!quad) return
      const corners = screenCorners(quad, c)
      expect(corners.flat().every(Number.isFinite)).toBe(true)
      for (const [x, y] of corners) {
        expect(Math.abs(x)).toBeLessThanOrEqual(OUTER * Math.tan(CORONA_MAX_ANGLE))
        expect(Math.abs(y)).toBeLessThanOrEqual(OUTER * Math.tan(CORONA_MAX_ANGLE))
      }
    })

    it('draws no glow at the centre of view', () => {
      if (!quad) return
      expect(rAt(quad, c, [0, 0])).toBeGreaterThanOrEqual(OUTER)
    })
  })

  it('collapses the corona from 89.5° out, where the old quad turned inside out', () => {
    expect(perspectiveCoronaQuad(sunAt(60, 50), R)).not.toBeNull()
    for (const deg of [89.5, 89.9, 90, 90.5, 179]) {
      expect(perspectiveCoronaQuad(sunAt(deg, 50), R)).toBeNull()
    }
    // The bug, for the record: the near limb past the far one, and the quad
    // (in tangents) tens of thousands of screens wide.
    const old = unfixedQuad(sunAt(89.9, 50), R)
    expect(old.limb).toBeLessThan(0)
    expect(Math.abs(old.limb) / (50 * Math.cos(89.9 * DEG))).toBeGreaterThan(1e2)
  })

  it('collapses a Sun at or behind the camera plane, or centred on the camera', () => {
    expect(perspectiveCoronaQuad([0, 0, 50], R)).toBeNull()
    expect(perspectiveCoronaQuad([50, 0, 0], R)).toBeNull()
    expect(perspectiveCoronaQuad([0, 0, 0], R)).toBeNull()
  })

  it('shrinks to nothing as the near limb comes up to CORONA_MAX_ANGLE', () => {
    // A distant Sun, so beta is negligible and theta is the near limb.
    const limbAt = (theta: number) => {
      const c = sunAt(theta / DEG, 1e6)
      const quad = perspectiveCoronaQuad(c, R)
      return quad && quad.limb / -c[2]
    }
    expect(limbAt(CORONA_MAX_ANGLE - 0.1)).toBeGreaterThan(0)
    expect(limbAt(CORONA_MAX_ANGLE - 1e-4)).toBeLessThan(1e-3)
    expect(limbAt(CORONA_MAX_ANGLE + 1e-4)).toBeNull()
  })

  // Ship flight approaches bodies closely: the corona must stay wherever the
  // Sun's near limb is on screen. 50° covers the ship view's corners (60°
  // vertical fov plus the speed kick, landscape phone).
  it.each([1.1, 1.2, 1.3, 1.5])('keeps the corona of a Sun %s radii away while its limb is on screen', (k) => {
    const alpha = Math.asin(1 / k)
    for (let deg = 0; deg <= 180; deg += 0.1) {
      const theta = deg * DEG
      const beta = Math.atan(Math.cos(theta) * Math.tan(alpha))
      if (Math.abs(theta - beta) > 50 * DEG) continue
      const c = sunAt(deg, k * R)
      const quad = perspectiveCoronaQuad(c, R)
      expect(quad, `${deg}°`).not.toBeNull()
      expect(quad!.limb).toBeGreaterThan(0)
      // ...hugging the near limb.
      expect(rAt(quad!, c, [Math.tan(theta - beta), 0])).toBeCloseTo(1, 6)
    }
  })

  // Every angle 0–180° at distances from just above the surface outward,
  // in two roll planes.
  const distances = [1.001, 1.05, 1.2, 2, 5, 50, 1e4].map((k) => k * R)
  it('never yields NaN, an inverted quad or one bigger than the clamp allows', () => {
    for (const distance of distances) {
      for (const roll of [0, 0.7]) {
        for (let deg = 0; deg <= 180; deg += 0.05) {
          const c = sunAt(deg, distance, roll)
          const quad = perspectiveCoronaQuad(c, R)
          if (!quad) continue
          expect(Number.isFinite(quad.limb) && quad.limb > 0).toBe(true)
          expect(Number.isFinite(quad.push) && quad.push > 1).toBe(true)
          expect(quad.centre.every(Number.isFinite)).toBe(true)
          for (const [x, y] of screenCorners(quad, c)) {
            expect(Math.hypot(x, y)).toBeLessThanOrEqual(
              Math.SQRT2 * OUTER * Math.tan(CORONA_MAX_ANGLE)
            )
          }
        }
      }
    }
  })

  it('hugs the silhouette: the near limb, and the far one short of the clamp, sit at r = 1', () => {
    for (const distance of distances) {
      for (let deg = 0; deg <= 80; deg += 5) {
        const c = sunAt(deg, distance)
        const quad = perspectiveCoronaQuad(c, R)
        if (!quad) continue
        const theta = deg * DEG
        const alpha = Math.asin(R / distance)
        const beta = Math.atan(Math.cos(theta) * Math.tan(alpha))
        for (const limb of [theta - beta, theta + beta]) {
          if (limb >= CORONA_MAX_ANGLE) continue
          expect(rAt(quad, c, [Math.tan(limb), 0])).toBeCloseTo(1, 6)
        }
      }
    }
  })

  it('matches the pre-fix quad wherever a distant Sun can be on screen', () => {
    // View from Earth's widest view (90° vertical) on a 2.4:1 panel reaches
    // ~69° in the corners; the ship view's fov is narrower.
    for (const distance of [50, 1e4 * R]) {
      for (let deg = 0; deg <= 70; deg += 0.5) {
        const c = sunAt(deg, distance, 0.3)
        const quad = perspectiveCoronaQuad(c, R)!
        const old = unfixedQuad(c, R)
        expect(quad.limb).toBeCloseTo(old.limb, 9)
        expect(quad.centre[0]).toBeCloseTo(old.centre[0], 9)
        expect(quad.centre[1]).toBeCloseTo(old.centre[1], 9)
      }
    }
  })
})

describe('sun-corona vertex.glsl', () => {
  const glsl = readFileSync(new URL('../shaders/sun-corona/vertex.glsl', import.meta.url), 'utf8')

  it('takes its cut-off angle as a uniform from corona-geometry.ts', () => {
    expect(glsl).toMatch(/uniform float uMaxAngle;/)
    expect(glsl).toContain('if (!(abs(nearAngle) < uMaxAngle))')
    expect(glsl).toContain('tan(min(theta + beta, uMaxAngle))')
    expect(glsl).toContain('corona-geometry.ts')
  })
})
