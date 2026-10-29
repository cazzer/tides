// What TidesField.tsx draws (tides-zec.4), as plain sums on scene vectors so
// they can be tested without a renderer: the tide shell's vertices, its
// outline in the Moon's orbit plane and the ring of arrows in that plane;
// and the arrows' colours, which the readout keys. Sizes are × Earth's scene radius.

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

/** The Moon's and the Sun's arrows and discs, and their names in the
 * readout. */
export const TIDES_MOON_COLOR = '#C9A6FF'
export const TIDES_SUN_COLOR = '#FFC23D'

/** Points round the sea's outline. */
export const OUTLINE_POINTS = 160

const METRES_PER_RADIUS = EARTH_RADIUS_KM * 1000

/** The drawn sea's height over the ground, × Earth's radius, where the
 * Moon's and the Sun's zenith angles have cosines `cosMoon`, `cosSun`. */
function seaLift(cosMoon: number, cosSun: number, pulls: Pick<TidePulls, 'moon' | 'sun'>): number {
  return SHELL_LIFT + (TIDE_EXAGGERATION * equilibriumHeight(cosMoon, cosSun, pulls)) / METRES_PER_RADIUS
}

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
    const lift = seaLift(x * moon.x + y * moon.y + z * moon.z, x * sun.x + y * sun.y + z * sun.z, pulls)
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

/**
 * The sea's outline in the ring's plane as a ribbon `width` wide, its outer
 * edge on the drawn sea: OUTLINE_POINTS pairs (inner, outer) of xyz into
 * `positions`, from the Moon's direction round toward `side`.
 */
export function outlineVertices(
  moon: THREE.Vector3,
  side: THREE.Vector3,
  sun: THREE.Vector3,
  pulls: Pick<TidePulls, 'moon' | 'sun'>,
  radius: number,
  width: number,
  positions: Float32Array
): void {
  const sunMoon = sun.dot(moon)
  const sunSide = sun.dot(side)
  for (let j = 0; j < OUTLINE_POINTS; j++) {
    const alpha = (j / OUTLINE_POINTS) * 2 * Math.PI
    const c = Math.cos(alpha)
    const s = Math.sin(alpha)
    const r = radius * (1 + seaLift(c, c * sunMoon + s * sunSide, pulls))
    for (let k = 0; k < 2; k++) {
      const rk = k === 0 ? r - width : r
      const i = (2 * j + k) * 3
      positions[i] = (moon.x * c + side.x * s) * rk
      positions[i + 1] = (moon.y * c + side.y * s) * rk
      positions[i + 2] = (moon.z * c + side.z * s) * rk
    }
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
