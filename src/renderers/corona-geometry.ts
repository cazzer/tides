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
 * panels' perspective cameras show the Sun ~43x real size in the solar
 * eclipse demo (8x elsewhere, eclipse-sky.ts' SKY_SCALE), where a 3R corona
 * would fill the sky; 1.6 is tuned for the demo. The main view, which looks at
 * it at true scale, keeps 3.
 */
export const CORONA_OUTER_PERSPECTIVE = 1.6
export const CORONA_OUTER_MAIN = 3

/**
 * How far the main view's corona is drawn, in limb radii: short of its outer
 * edge, where the fade has already taken the glow under a display step.
 * After tone mapping and sRGB the brightest the corona gets, over every
 * streamer, ray and latitude the bake can make, is 2.7 LSB at 2.0R, 0.44 at
 * 2.2R and 0 from 2.3R (tides-0oi.2, sun-1); 2.4 leaves room for the night
 * flight's exposure. The draw is scissored to it (coronaClipRect), which
 * skips ~36% of the quad's pixels; the quad and its fade still reach
 * CORONA_OUTER_MAIN. Shrinking the quad itself instead moves its vertices,
 * which rounds the varyings differently and shifts the limb by 1 LSB.
 */
export const CORONA_QUAD_MAIN = 2.4

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
  const quad: CoronaQuad = { centre: [0, 0], limb: 0, push: 1 }
  return coronaQuadInto(c[0], c[1], c[2], radius, quad) ? quad : null
}

// perspectiveCoronaQuad into `out`, allocating nothing (it runs every
// frame for coronaClipRect); false where the shader collapses the quad.
function coronaQuadInto(cx: number, cy: number, cz: number, radius: number, out: CoronaQuad): boolean {
  const lateral = Math.hypot(cx, cy)
  // Off axis by theta (past π/2 behind the camera), View from Earth squashes
  // the Sun by cos(theta) to keep its disc round (RoundSkyDiscs); elsewhere
  // the Sun sits near the axis, where the squash is ~1. The silhouette then
  // spans tan(theta -+ beta) out from the centre of view, with
  // tan(beta) = cos(theta) tan(alpha) and alpha the Sun's angular radius.
  const theta = Math.atan2(lateral, -cz)
  const tanAlpha = radius / Math.sqrt(Math.max(cx ** 2 + cy ** 2 + cz ** 2 - radius ** 2, 1e-8))
  const beta = Math.atan(Math.cos(theta) * tanAlpha)
  const nearAngle = theta - beta
  // Behind the camera nearAngle > theta > π/2. Written so NaN collapses too.
  if (!(Math.abs(nearAngle) < CORONA_MAX_ANGLE)) return false
  // From here theta < π/2, so beta ≥ 0 and the Sun is in front of the camera:
  // both tangents are finite, with near ≤ far.
  const depth = -cz
  const far = Math.tan(Math.min(theta + beta, CORONA_MAX_ANGLE))
  const near = Math.tan(nearAngle)
  const off = lateral > 1e-6 * depth
  const mid = 0.5 * (far + near) * depth
  out.centre[0] = (off ? cx / lateral : 1) * mid
  out.centre[1] = (off ? cy / lateral : 0) * mid
  out.limb = 0.5 * (far - near) * depth
  out.push = (depth + radius) / depth
  return true
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

/** A device-px rectangle: x, y (up, as gl.scissor takes it), width, height. Fits a THREE.Vector4. */
export interface PixelRect {
  x: number
  y: number
  z: number
  w: number
}

const clipQuad: CoronaQuad = { centre: [0, 0], limb: 0, push: 1 }

/**
 * The device-px rectangle, into `out`, holding every pixel of the
 * perspective corona quad within `extent` limb radii of its centre, for a
 * Sun of `radius` centred at view-space (cx, cy, cz); false when the shader
 * collapses the quad. `projection` is the camera's column-major projection
 * matrix and `viewport` the draw's device-px viewport. The quad lies in a
 * plane parallel to the screen, so its square of half-width `extent`
 * projects to an axis-aligned box: outside it every pixel is at least
 * `extent` limb radii out. Rounded outward with a pixel to spare for the
 * shader's float maths. Allocates nothing: it runs every frame.
 */
export function coronaClipRect(
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  extent: number,
  projection: ArrayLike<number>,
  viewport: Readonly<PixelRect>,
  out: PixelRect
): boolean {
  if (!coronaQuadInto(cx, cy, cz, radius, clipQuad)) return false
  const p = projection
  const z = cz * clipQuad.push
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let corner = 0; corner < 4; corner++) {
    const x = (clipQuad.centre[0] + (corner & 1 ? extent : -extent) * clipQuad.limb) * clipQuad.push
    const y = (clipQuad.centre[1] + (corner & 2 ? extent : -extent) * clipQuad.limb) * clipQuad.push
    const w = p[3] * x + p[7] * y + p[11] * z + p[15]
    const px = viewport.x + (0.5 + (0.5 * (p[0] * x + p[4] * y + p[8] * z + p[12])) / w) * viewport.z
    const py = viewport.y + (0.5 + (0.5 * (p[1] * x + p[5] * y + p[9] * z + p[13])) / w) * viewport.w
    x0 = Math.min(x0, px)
    y0 = Math.min(y0, py)
    x1 = Math.max(x1, px)
    y1 = Math.max(y1, py)
  }
  out.x = Math.floor(x0) - 1
  out.y = Math.floor(y0) - 1
  out.z = Math.ceil(x1) + 1 - out.x
  out.w = Math.ceil(y1) + 1 - out.y
  return true
}
