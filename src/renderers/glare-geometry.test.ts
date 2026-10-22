import { describe, expect, it } from 'vitest'
import {
  GLARE_CORE_MIN_PX,
  GLARE_HALO_MAX_PX,
  GLARE_MIN_VIEW_PX,
  GLARE_PEAK,
  GLARE_STRENGTH,
  glareQuad,
  type Vec3,
} from './glare-geometry'

const DEG = Math.PI / 180
const R = 10
// Ship mode's 60° vertical FOV on a phone held upright.
const WIDTH = 390
const HEIGHT = 844
const P11 = 1 / Math.tan(30 * DEG)
const P00 = P11 / (WIDTH / HEIGHT)

/** The Sun's centre in view space, `distance` away and `deg` off the view axis. */
const sunAt = (deg: number, distance: number): Vec3 => [
  distance * Math.sin(deg * DEG),
  0,
  -distance * Math.cos(deg * DEG),
]

/** Whether any of the quad's pixels can land on the screen. */
function reachesScreen(q: NonNullable<ReturnType<typeof glareQuad>>): boolean {
  const dx = q.haloPx / (WIDTH / 2)
  const dy = q.haloPx / (HEIGHT / 2)
  return Math.abs(q.ndc[0]) - dx <= 1 && Math.abs(q.ndc[1]) - dy <= 1
}

describe('glareQuad', () => {
  it.each([1000, 5200, 30_000])('draws a small bright point on axis at %s units', (d) => {
    const q = glareQuad(sunAt(0, d), R, P00, P11, HEIGHT)!
    expect(q).not.toBeNull()
    expect(q.ndc[0]).toBeCloseTo(0)
    expect(q.ndc[1]).toBeCloseTo(0)
    expect(q.corePx).toBeGreaterThanOrEqual(GLARE_CORE_MIN_PX)
    expect(q.haloPx).toBeLessThanOrEqual(GLARE_HALO_MAX_PX)
    expect(q.alpha).toBeGreaterThanOrEqual(GLARE_STRENGTH[0])
    expect(q.alpha).toBeLessThanOrEqual(1)
    expect(GLARE_PEAK).toBeLessThan(1)
  })

  it('at Neptune the disc is sub-pixel but the glare is still there', () => {
    const q = glareQuad(sunAt(0, 30_000), R, P00, P11, HEIGHT)!
    expect(q.discPx).toBeLessThan(0.5)
    expect(q.alpha).toBe(GLARE_STRENGTH[0])
  })

  it('sits in front of the Sun, on the ray to its centre', () => {
    const c = sunAt(20, 1000)
    const q = glareQuad(c, R, P00, P11, HEIGHT)!
    const d = Math.hypot(...q.point)
    expect(d).toBeLessThan(1000 - R)
    expect(d).toBeGreaterThan(0)
    const cross = Math.hypot(
      q.point[1] * c[2] - q.point[2] * c[1],
      q.point[2] * c[0] - q.point[0] * c[2],
      q.point[0] * c[1] - q.point[1] * c[0]
    )
    expect(cross / (d * 1000)).toBeLessThan(1e-9)
  })

  it('fades out once the disc is big, so close up the corona alone draws the Sun', () => {
    expect(glareQuad(sunAt(0, 50), R, P00, P11, HEIGHT)).toBeNull()
  })

  // The tides-2hv.1 cases: none may wash the screen.
  describe.each([0, 60, 89.9, 90, 90.1, 179.9])('Sun %s° off the view axis', (deg) => {
    it.each([50, 1000, 30_000])('at %s units, is collapsed, or on screen only where the Sun is', (d) => {
      const q = glareQuad(sunAt(deg, d), R, P00, P11, HEIGHT)
      if (deg >= 90) expect(q).toBeNull()
      if (!q) return
      expect([q.ndc[0], q.ndc[1], q.haloPx, q.alpha].every(Number.isFinite)).toBe(true)
      // The Sun's own direction decides: off screen, so is all of the glare.
      const onScreen = Math.abs(Math.tan(deg * DEG) * P00) <= 1
      expect(reachesScreen(q)).toBe(onScreen)
    })
  })

  it('at 89.9° the quad is hundreds of screens off to the side', () => {
    const q = glareQuad(sunAt(89.9, 1000), R, P00, P11, HEIGHT)!
    expect(Math.abs(q.ndc[0])).toBeGreaterThan(500)
    expect(reachesScreen(q)).toBe(false)
  })

  it('collapses inside the Sun, in an orthographic view and on NaN', () => {
    expect(glareQuad([0, 0, -5], R, P00, P11, HEIGHT)).toBeNull()
    expect(glareQuad([0, 0, 0], R, P00, P11, HEIGHT)).toBeNull()
    expect(glareQuad(sunAt(0, 1000), R, P00, P11, HEIGHT, true)).toBeNull()
    expect(glareQuad([NaN, 0, -1000], R, P00, P11, HEIGHT)).toBeNull()
  })

  it('collapses before the view has a size, rather than spanning the screen', () => {
    expect(glareQuad(sunAt(0, 1000), R, P00, P11, 1)).toBeNull()
    expect(glareQuad(sunAt(0, 1000), R, P00, P11, 0)).toBeNull()
    expect(glareQuad(sunAt(0, 1000), R, P00, P11, NaN)).toBeNull()
    expect(glareQuad(sunAt(0, 1000), R, P00, P11, GLARE_MIN_VIEW_PX)).not.toBeNull()
  })
})
