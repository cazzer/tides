/*
 * The Sun corona billboard's perspective sizing, in TypeScript so it can be
 * tested. This mirrors the !isOrthographic branch of
 * src/shaders/sun-corona/vertex.glsl line for line: change one, change the
 * other. SunRenderer feeds the constant below to the shader as a uniform, so
 * only the maths has to be kept in step by hand.
 */

/**
 * [TUNE] The largest limb angle off the view axis (radians, ~80°) the corona
 * quad reaches. The quad spans tan() of the Sun's near and far limb angles,
 * which runs off to infinity at the camera plane (π/2). The far limb is
 * clamped here; as the near limb comes up to it the quad shrinks to nothing,
 * and past it the quad is collapsed. Before tides-2hv.1 only the far limb
 * was clamped (at 1.55): near the plane the near limb overtook it, turning
 * the quad inside out and ~1e5 screens wide, with the bright inner glow
 * across the view. Lower trims the glow of a close Sun whose far limb is off
 * screen; the near limb past ~50° is off screen in every view anyway.
 */
export const CORONA_MAX_ANGLE = 1.4

/**
 * The corona's outer edge, in limb radii (vertex.glsl's uOuter). The
 * panels' perspective cameras show the Sun ~43x real size, where a 3R corona
 * would fill the sky; the main view, which looks at it at true scale, keeps 3.
 */
export const CORONA_OUTER_PERSPECTIVE = 1.6
export const CORONA_OUTER_MAIN = 3

export interface CoronaQuad {
  /** Quad centre, view-space x and y at the Sun's depth (before `push`). */
  centre: [number, number]
  /** Limb radius at the Sun's depth: the quad spans ±outer limbs from the centre. */
  limb: number
  /** Scale that slides the quad back along the eye's rays behind the Sun. */
  push: number
}

/**
 * The perspective corona quad for a Sun of `radius` whose centre is at
 * view-space `c` (camera at the origin looking down −z), or null when the
 * shader collapses it: the near limb is CORONA_MAX_ANGLE or more off axis,
 * the Sun is behind the camera plane, or the maths went non-finite.
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
  const nearAngle = theta - beta
  // Behind the camera nearAngle > theta > π/2. Written so NaN collapses too.
  if (!(Math.abs(nearAngle) < CORONA_MAX_ANGLE)) return null
  // From here theta < π/2, so beta ≥ 0 and the Sun is in front of the camera:
  // both tangents are finite, with near ≤ far.
  const depth = -c[2]
  const far = Math.tan(Math.min(theta + beta, CORONA_MAX_ANGLE))
  const near = Math.tan(nearAngle)
  const outward: [number, number] = lateral > 1e-6 * depth ? [c[0] / lateral, c[1] / lateral] : [1, 0]
  const mid = 0.5 * (far + near) * depth
  return {
    centre: [outward[0] * mid, outward[1] * mid],
    limb: 0.5 * (far - near) * depth,
    push: (depth + radius) / depth,
  }
}

/**
 * The outward limb normal, in view space, under the corona quad's image
 * plane direction `u` (a unit vector from the quad centre): the direction
 * the corona's pattern is read from, before vertex.glsl turns it into the
 * Sun's frame. Mirrors the shader's `slope` terms: change one, change the
 * other. A perspective eye ray to the limb leans off the view axis, and the
 * normal must be perpendicular to it; dropping the z term would pin the
 * pattern to the screen, sliding it over the Sun as the eye turns. `quad`
 * is null for the ortho main view, where the normal lies in the image plane.
 */
export function coronaLimbNormal(
  quad: CoronaQuad | null,
  depth: number,
  u: readonly [number, number]
): [number, number, number] {
  if (!quad) return [u[0], u[1], 0]
  const z = (u[0] * quad.centre[0] + u[1] * quad.centre[1] + quad.limb) / depth
  const length = Math.hypot(u[0], u[1], z)
  return [u[0] / length, u[1] / length, z / length]
}
