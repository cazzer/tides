// How much of the Sun's glow shows (tides-64u.2): none while SunGlare's far
// glare carries a disc of a few px, all of it once the disc has grown past
// the glare's fade, the same smoothstep reversed, so glare + glow is one
// source at every distance.

export interface SunGlowView {
  /** Eye to the Sun's centre. */
  distance: number
  radius: number
  /** projectionMatrix[1][1] (elements[5]): 1 / tan(half the vertical FOV). */
  projectionYY: number
  isPerspective: boolean
  /** The View's height, CSS px. */
  viewHeightPx: number
  /** SunGlare's fade, disc radius px (GLARE_FADE_PX). */
  fadePx: readonly [number, number]
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

/** The disc's radius on screen, CSS px, as SunGlare's vertex shader sums it. */
export function sunDiscPx(view: Omit<SunGlowView, 'fadePx'>): number {
  const { distance, radius, projectionYY, viewHeightPx } = view
  if (!(distance > radius)) return Infinity
  const tanAlpha = radius / Math.sqrt(distance * distance - radius * radius)
  return tanAlpha * projectionYY * 0.5 * viewHeightPx
}

/** 0..1: the glow's share, the glare's complement. Full in an orthographic view and from inside the Sun. */
export function sunGlowWeight(view: SunGlowView): number {
  if (!view.isPerspective) return 1
  const disc = sunDiscPx(view)
  if (!Number.isFinite(disc)) return 1
  return smoothstep(view.fadePx[0], view.fadePx[1], disc)
}
