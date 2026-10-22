/*
 * The far Sun glare (tides-2hv.12): a small screen-space quad that keeps the
 * Sun findable as a bright point when its disc is a pixel or less, out to
 * Neptune and beyond. It has nothing to do with the corona billboard
 * (corona-geometry.ts): it never sizes itself from tan() of a limb angle, so
 * nothing in it runs off to infinity near the camera plane (tides-2hv.1).
 * Its size is in pixels, offset around one projected point; a Sun 89.9° off
 * axis projects hundreds of screens away and a 48 px offset can't bring it
 * back.
 *
 * This mirrors SunGlare.tsx's vertex shader line for line, which takes the
 * constants below: change one, change the other.
 */

export type Vec3 = readonly [number, number, number]

/**
 * [TUNE] Disc radius, px, over which the glare fades out: by 24 px the disc
 * and corona carry the Sun on their own.
 */
export const GLARE_FADE_PX: readonly [number, number] = [8, 24]
/** The glare's core is the disc, but never under this radius, px. */
export const GLARE_CORE_MIN_PX = 2
/** [TUNE] Halo radius as a multiple of the core's, and its cap, px. */
export const GLARE_HALO_SCALE = 6
export const GLARE_HALO_MAX_PX = 48
/**
 * [TUNE] Strength falls as (GLARE_REFERENCE_DISTANCE / d)^0.5 past 1 AU
 * (1000 units at the flight scale), clamped to GLARE_STRENGTH: dimmer at
 * Neptune than at Earth, still plain to see.
 */
export const GLARE_REFERENCE_DISTANCE = 1000
export const GLARE_STRENGTH: readonly [number, number] = [0.35, 1]
/**
 * The glare's peak brightness, additive. Under 1, so even stacked on the
 * disc it can't white out the view.
 */
export const GLARE_PEAK = 0.9
/**
 * The glare is drawn on the ray to the Sun's centre at this share of the way
 * to its near surface, so planets in front still hide it but the Sun's own
 * sphere never does. On the surface itself depth precision can't separate
 * the two: at Neptune the depth error (z² / (near · 2²⁴)) is ~500 units.
 */
export const GLARE_DEPTH_SHARE = 0.5

export interface GlareQuad {
  /** The view-space point the quad is centred on. */
  point: [number, number, number]
  /** That point in NDC. */
  ndc: [number, number]
  /** The Sun's disc radius on screen, px. */
  discPx: number
  corePx: number
  haloPx: number
  /** Overall strength, 0..1; the quad is collapsed at 0. */
  alpha: number
}

/**
 * The glare quad for a Sun of `radius` centred at view-space `c` (camera at
 * the origin looking down −z), under a projection whose x and y scales are
 * `p00` and `p11` (projectionMatrix elements [0][0] and [1][1]), on a view
 * `heightPx` CSS px tall; or null when the shader collapses it: an
 * orthographic view (the system view has its own Sun), the Sun's centre at
 * or behind the camera plane, the camera inside the Sun, or no strength
 * left because the disc is big.
 */
export function glareQuad(
  c: Vec3,
  radius: number,
  p00: number,
  p11: number,
  heightPx: number,
  orthographic = false
): GlareQuad | null {
  const d = Math.hypot(c[0], c[1], c[2])
  // Written so NaN collapses too.
  if (orthographic || !(c[2] < -1e-6 * d) || !(d > radius)) return null
  const tanAlpha = radius / Math.sqrt(d * d - radius * radius)
  const discPx = tanAlpha * p11 * 0.5 * heightPx
  const alpha =
    (1 - smoothstep(GLARE_FADE_PX[0], GLARE_FADE_PX[1], discPx)) *
    clamp(Math.sqrt(GLARE_REFERENCE_DISTANCE / d), GLARE_STRENGTH[0], GLARE_STRENGTH[1])
  if (!(alpha > 0)) return null
  const corePx = Math.max(discPx, GLARE_CORE_MIN_PX)
  const haloPx = Math.min(corePx * GLARE_HALO_SCALE, GLARE_HALO_MAX_PX)
  const k = GLARE_DEPTH_SHARE * (1 - radius / d)
  const point: [number, number, number] = [c[0] * k, c[1] * k, c[2] * k]
  return {
    point,
    ndc: [(p00 * point[0]) / -point[2], (p11 * point[1]) / -point[2]],
    discPx,
    corePx,
    haloPx,
    alpha,
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
