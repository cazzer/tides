import { MathUtils } from 'three'
import { MAIN_DISTANCE, zoomDistance } from '../main-view'

/*
 * A representative depth for the main view's starfield, not a real one: at
 * true scale every star is ~1e7 scene units away and shows no parallax from
 * anywhere the camera goes (tides-kzj.3.2). Instead each star's distance is
 * log-compressed into a shell around the usual star sphere, faded in as the
 * eye backs away from its target, so orbiting the zoomed-out view shows the
 * stars as a cloud with depth. The shell's centre slides from the eye to the
 * target as it fades in (centreStarfieldOn): centred on a perspective eye
 * every radius projects to the same pixel, so only an off-centre eye sees
 * near stars sweep faster than far ones. shellScale grows the shell with the
 * eye's distance so the eye stays inside its nearest stars. With no fade
 * (closer than MAIN_DISTANCE, and the Earth and Moon panels) it is the plain
 * star sphere centred on the eye, every star in its true direction.
 */

/** Distances (pc) mapped to the inside and outside of the shell. */
export const SHELL_NEAR_PC = 2
export const SHELL_FAR_PC = 2000

/** Shell radii as multiples of the star sphere's radius, once fully faded in. */
export const SHELL_NEAR_RADIUS = 0.6
export const SHELL_FAR_RADIUS = 1.6

/** How much bigger the nearest stars draw, once fully faded in. */
export const NEAR_SIZE_BOOST = 1.2

/** Closer in than MAIN_DISTANCE the stars are a sphere; by this distance, a full shell. */
export const FULL_DEPTH_DISTANCE = zoomDistance(2)

/** Where a star at `distancePc` sits in the shell: 0 nearest, 1 farthest. */
export function shellDepth(distancePc: number): number {
  const t =
    Math.log(distancePc / SHELL_NEAR_PC) / Math.log(SHELL_FAR_PC / SHELL_NEAR_PC)
  return MathUtils.clamp(Number.isFinite(t) ? t : 1, 0, 1)
}

/** How far the shell has faded in with the eye `distance` from its target: 0 to 1. */
export function depthAmount(distance: number): number {
  const t =
    Math.log(distance / MAIN_DISTANCE) / Math.log(FULL_DEPTH_DISTANCE / MAIN_DISTANCE)
  return MathUtils.smoothstep(t, 0, 1)
}

/**
 * The eye stays inside the shell's nearest stars by this factor: its distance
 * from the shell's centre is at most 1 / EYE_MARGIN of their radius.
 */
export const EYE_MARGIN = 1.5

/**
 * The star sphere's radius for an eye `distance` from its target and a shell
 * faded in to `amount`: `radius`, or bigger where the eye, `amount` of the
 * way to the target from the shell's centre, would come within EYE_MARGIN of
 * the nearest stars. Unchanged with no fade.
 */
export function shellScale(radius: number, distance: number, amount: number): number {
  return Math.max(radius, (EYE_MARGIN * amount * distance) / shellRadius(0, amount))
}

/** A star's distance from the shell's centre, in star-sphere radii. */
export function shellRadius(depth: number, amount: number): number {
  return MathUtils.lerp(
    1,
    MathUtils.lerp(SHELL_NEAR_RADIUS, SHELL_FAR_RADIUS, depth),
    amount
  )
}

/**
 * Star positions for the shell, as shellVertex computes them on the GPU: each
 * unit direction stretched to its shell radius, so only its distance
 * changes. With amount 0 they are the directions themselves.
 */
export function shellPositions(
  directions: Float32Array,
  depths: Float32Array,
  amount: number,
  out: Float32Array = new Float32Array(directions.length)
): Float32Array {
  for (let i = 0; i < depths.length; i += 1) {
    const r = shellRadius(depths[i], amount)
    out[i * 3] = directions[i * 3] * r
    out[i * 3 + 1] = directions[i * 3 + 1] * r
    out[i * 3 + 2] = directions[i * 3 + 2] * r
  }
  return out
}

// Replaces begin_vertex: the stars' unit directions stretched to shellRadius
// (the same lerps), so a dolly only moves uDepth.
export const shellVertex = /* glsl */ `
vec3 transformed = position * mix(1.0, mix(${SHELL_NEAR_RADIUS.toFixed(3)}, ${SHELL_FAR_RADIUS.toFixed(3)}, starDepth), uDepth);
`

// Replaces points' `gl_PointSize = size;`. Nearer stars draw bigger, and the
// stars stay behind every body and clipped behind the eye at any shell radius
// (the far side of the shell is past the camera's far plane). Under reversed-Z
// (tides-zmw.9.3) clip z runs w at the near plane to 0 at the far one and is
// the window depth itself, so the stars sit at the same window depth as on
// the standard buffer, 0.999995 of the way out: 1 − (0.5 + 0.5 · 0.99999).
// 2w clips in both.
export const shellPointVertex = /* glsl */ `
gl_PointSize = size * (1.0 + uDepth * ${NEAR_SIZE_BOOST.toFixed(3)} * (1.0 - starDepth));
if (uDepth > 0.0) {
  #ifdef USE_REVERSED_DEPTH_BUFFER
  gl_Position.z = mvPosition.z < 0.0 ? 0.000005 * gl_Position.w : 2.0 * gl_Position.w;
  #else
  gl_Position.z = mvPosition.z < 0.0 ? 0.99999 * gl_Position.w : 2.0 * gl_Position.w;
  #endif
}
`
