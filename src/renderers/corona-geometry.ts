/*
 * The Sun corona billboard's perspective sizing, in TypeScript so it can be
 * tested. This mirrors the !isOrthographic branch of
 * src/shaders/sun-corona/vertex.glsl line for line: change one, change the
 * other. SunRenderer feeds the constants below to the shader as uniforms, so
 * only the maths has to be kept in step by hand.
 */

/**
 * [TUNE] Off-axis angle (radians, ~88.8°) of the Sun's far limb at which the
 * corona is gone. The quad spans tan() of its limb angles, which runs off to
 * infinity at the camera plane (π/2); before this fix only the far limb was
 * clamped here, and near the plane the near limb overtook it, turning the quad
 * inside out and ~1e5 screens wide, with the bright inner glow across the view
 * (tides-2hv.1).
 */
export const CORONA_MAX_ANGLE = 1.55

/**
 * [TUNE] Off-axis angle (radians, ~80°) of the far limb at which the corona
 * starts fading toward CORONA_MAX_ANGLE. Past here the flat quad stretches
 * its glow far beyond the limb; a distant Sun this far out is off screen in
 * every view anyway, and only a Sun close enough to fill much of the ship's
 * view loses its corona.
 */
export const CORONA_FADE_START = 1.4

/** The perspective corona's outer edge, in limb radii (vertex.glsl's `outer`). */
export const CORONA_OUTER_PERSPECTIVE = 1.6

export interface CoronaQuad {
  /** Quad centre, view-space x and y at the Sun's depth (before `push`). */
  centre: [number, number]
  /** Limb radius at the Sun's depth: the quad spans ±outer limbs from the centre. */
  limb: number
  /** Scale that slides the quad back along the eye's rays behind the Sun. */
  push: number
  /** Brightness factor, in (0, 1]. */
  fade: number
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1)
  return t * t * (3 - 2 * t)
}

/**
 * The perspective corona quad for a Sun of `radius` whose centre is at
 * view-space `c` (camera at the origin looking down −z), or null when the
 * shader collapses it: the far limb is at or past CORONA_MAX_ANGLE, the Sun is
 * at or behind the camera plane, or the maths went non-finite.
 */
export function perspectiveCoronaQuad(
  c: readonly [number, number, number],
  radius: number
): CoronaQuad | null {
  const lateral = Math.hypot(c[0], c[1])
  // Off axis by theta (past π/2 behind the camera), View from Earth squashes
  // the Sun by cos(theta) to keep its disc round (RoundSkyDiscs); elsewhere
  // the Sun sits near the axis, where the squash is ~1. The silhouette then
  // spans tan(theta -+ beta) out from the centre of view, with
  // tan(beta) = cos(theta) tan(alpha) and alpha the Sun's angular radius.
  const theta = Math.atan2(lateral, -c[2])
  const tanAlpha = radius / Math.sqrt(Math.max(c[0] ** 2 + c[1] ** 2 + c[2] ** 2 - radius ** 2, 1e-8))
  const beta = Math.atan(Math.cos(theta) * tanAlpha)
  // |beta|: behind the camera cos(theta) < 0 would pull the edge back in.
  const fade = 1 - smoothstep(CORONA_FADE_START, CORONA_MAX_ANGLE, theta + Math.abs(beta))
  // Written so NaN collapses too.
  if (!(fade > 0)) return null
  // From here theta + beta < CORONA_MAX_ANGLE < π/2, so the Sun is in front
  // of the camera and both tangents are finite with near < far.
  const depth = -c[2]
  const far = Math.tan(theta + beta)
  const near = Math.tan(theta - beta)
  const outward: [number, number] = lateral > 1e-6 * depth ? [c[0] / lateral, c[1] / lateral] : [1, 0]
  const mid = 0.5 * (far + near) * depth
  return {
    centre: [outward[0] * mid, outward[1] * mid],
    limb: 0.5 * (far - near) * depth,
    push: (depth + radius) / depth,
    fade,
  }
}
