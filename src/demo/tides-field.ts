// What TidesField.tsx draws (tides-zec.4), as plain sums on scene vectors so
// they can be tested without a renderer: the tide shell's vertices and the
// ring of arrows in the Moon's orbit plane. Sizes are × Earth's scene radius.

import * as THREE from 'three'
import { moonOrbitPlane } from './moon-orbit-tilt'
import { EARTH_RADIUS_KM, TIDE_EXAGGERATION, equilibriumHeight, tidalAccel, type TidePulls } from './tides'

/** Just clear of the ground, so the mean sea doesn't fight it for depth; the
 * low-tide belt sinks under the ground and its depth hides it. */
export const SHELL_LIFT = 0.003 // [TUNE]
/** Over this height above the ground the shell fades in, so its edge where
 * it dips under the ground is soft. */
export const SHELL_FADE = 0.012 // [TUNE]
export const ARROW_POINTS = 12
/** An arrow's length per unit of the Moon's mean pull: the Moon's own arrow
 * under it (2 units at mean distance) is 0.3 R. */
export const ARROW_UNIT = 0.3 / 2 // [TUNE]

const METRES_PER_RADIUS = EARTH_RADIUS_KM * 1000

function smoothstep(edge: number, x: number): number {
  const t = Math.min(1, Math.max(0, x / edge))
  return t * t * (3 - 2 * t)
}

/**
 * The shell over unit vertex directions `directions` (xyz triples): the
 * positions at the exaggerated equilibrium tide into `positions` (xyz) and
 * the fade into `colors` (rgba, white), for the scene's unit directions to
 * the Moon and the Sun.
 */
export function shellVertices(
  directions: Float32Array,
  moon: THREE.Vector3,
  sun: THREE.Vector3,
  pulls: Pick<TidePulls, 'moon' | 'sun'>,
  radius: number,
  positions: Float32Array,
  colors: Float32Array
): void {
  for (let v = 0, i = 0; i < directions.length; v++, i += 3) {
    const x = directions[i]
    const y = directions[i + 1]
    const z = directions[i + 2]
    const h = equilibriumHeight(x * moon.x + y * moon.y + z * moon.z, x * sun.x + y * sun.y + z * sun.z, pulls)
    const lift = SHELL_LIFT + (TIDE_EXAGGERATION * h) / METRES_PER_RADIUS
    const r = radius * (1 + lift)
    positions[i] = x * r
    positions[i + 1] = y * r
    positions[i + 2] = z * r
    const c = v * 4
    colors[c] = 1
    colors[c + 1] = 1
    colors[c + 2] = 1
    colors[c + 3] = smoothstep(SHELL_FADE, lift)
  }
}

/** The ring's unit normal (the Moon's orbit plane's) and the in-plane unit
 * direction a quarter turn on from the Moon's. */
export function ringFrame(t: number, moon: THREE.Vector3, outNormal: THREE.Vector3, outSide: THREE.Vector3): void {
  outNormal.copy(moonOrbitPlane(t).normal)
  outSide.crossVectors(outNormal, moon).normalize()
}

/** The ring's `j`th arrow's unit base direction, `j` twelfths of a turn on
 * from the Moon's. */
export function ringPoint(j: number, moon: THREE.Vector3, side: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const alpha = (j / ARROW_POINTS) * 2 * Math.PI
  return out.copy(moon).multiplyScalar(Math.cos(alpha)).addScaledVector(side, Math.sin(alpha))
}

/** The Moon's, the Sun's and the summed tidal pull at the unit point `p`. */
export function ringArrows(
  p: THREE.Vector3,
  moon: THREE.Vector3,
  sun: THREE.Vector3,
  pulls: Pick<TidePulls, 'moon' | 'sun'>,
  outMoon: THREE.Vector3,
  outSun: THREE.Vector3,
  outSum: THREE.Vector3
): void {
  tidalAccel(p, moon, pulls.moon, outMoon)
  tidalAccel(p, sun, pulls.sun, outSun)
  outSum.addVectors(outMoon, outSun)
}

/** An arrow's drawn length for a pull `vector`, on a globe of `radius`. */
export function arrowLength(vector: THREE.Vector3, radius: number): number {
  return ARROW_UNIT * radius * vector.length()
}
