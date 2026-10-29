// Why eclipses are rare (tides-zec.1, the solar eclipse demo's last step): the
// Moon's orbit is tilted ~5° to the ecliptic, so a new moon only shadows Earth
// near a node, where the two planes cross. All relative to Earth, in
// moonOffset's units and scene axes (+Y ecliptic north).

import * as THREE from 'three'
import { moonOffset } from '../ephemeris'
import { EARTH_EQUATORIAL_RADIUS_KM, eclipseBodies, type EclipseBodies } from '../eclipse'
import { positionsFor } from '../flight-scale'

const DAY_MS = 86_400_000
const NORTH = new THREE.Vector3(0, 1, 0)

export interface MoonOrbitPlane {
  /** Unit normal, on the north side (the Moon goes round counter-clockwise). */
  normal: THREE.Vector3
  /** Unit direction to the ascending node, where the Moon crosses northward. */
  ascendingNode: THREE.Vector3
  /** The plane's tilt to the ecliptic, degrees (osculating: ~5.0–5.3). */
  tiltDeg: number
  /** The Moon's distance at t. */
  radius: number
}

/** The plane through the Moon at t and a day on, both from Earth's centre. */
export function moonOrbitPlane(t: number): MoonOrbitPlane {
  const now = new THREE.Vector3(...moonOffset(t))
  const next = new THREE.Vector3(...moonOffset(t + DAY_MS))
  const normal = new THREE.Vector3().crossVectors(now, next).normalize()
  // At NORTH × normal the Moon moves along normal × node, whose y is sin²(tilt):
  // northward, so that end is the ascending node.
  const ascendingNode = new THREE.Vector3().crossVectors(NORTH, normal).normalize()
  return {
    normal,
    ascendingNode,
    tiltDeg: (Math.acos(Math.min(1, normal.y)) * 180) / Math.PI,
    radius: now.length(),
  }
}

/** How far past the orbit the node line reaches, each way. */
export const NODE_LINE_REACH = 1.2

/** The node line's two ends (xyz, xyz), through Earth and past the orbit. */
export function nodeLinePoints(plane: MoonOrbitPlane, out: Float32Array = new Float32Array(6)): Float32Array {
  const { x, y, z } = plane.ascendingNode
  const r = NODE_LINE_REACH * plane.radius
  out.set([x * r, y * r, z * r, -x * r, -y * r, -z * r])
  return out
}

/** A circle of `radius` in the ecliptic plane, `segments` xyz triples. */
export function eclipticCirclePoints(
  radius: number,
  segments: number,
  out: Float32Array = new Float32Array(segments * 3)
): Float32Array {
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * 2 * Math.PI
    out[i * 3] = radius * Math.cos(a)
    out[i * 3 + 1] = 0
    out[i * 3 + 2] = -radius * Math.sin(a)
  }
  return out
}

export interface ShadowAxis {
  /** How far the axis passes from Earth's centre, in Earth radii. */
  missR: number
  /** The axis' nearest point to Earth's centre, scene units from it. */
  closest: THREE.Vector3
  /** Unit direction along the axis, away from the Sun. */
  direction: THREE.Vector3
  /** The Moon is on the Sun's side of Earth (near new moon, not full). */
  sunward: boolean
}

const axisBodies: EclipseBodies = { sun: new THREE.Vector3(), moon: new THREE.Vector3() }

/**
 * The true Sun→Moon line, the axis of the Moon's shadow, from the km
 * geometry (eclipseBodies). Its nearest point to Earth is put at Earth's own
 * scale, the drawn Earth's radius per true Earth radius, so whether it hits
 * Earth and by how far it misses read true. It does not pass the drawn Moon:
 * that sits ~10 units out, ~6x too close for Earth's drawn size (flight-scale.ts),
 * so a line from it to the Sun would cross Earth at nearly every new moon.
 */
export function shadowAxis(t: number): ShadowAxis {
  const { sun, moon } = eclipseBodies(t, axisBodies)
  const direction = new THREE.Vector3().subVectors(moon, sun).normalize()
  const closest = moon.clone().addScaledVector(direction, -moon.dot(direction))
  const missR = closest.length() / EARTH_EQUATORIAL_RADIUS_KM
  closest.multiplyScalar(positionsFor('system').radius.earth / EARTH_EQUATORIAL_RADIUS_KM)
  return { missR, closest, direction, sunward: moon.dot(sun) > 0 }
}

/** The axis shows within this many Earth radii, fading out over the last 2. */
export const SHADOW_AXIS_SHOW_R = 10
const SHADOW_AXIS_FADE_R = 2

/** Only near new moon, when the axis comes near Earth: 1 within 8 R, 0 past 10. */
export function shadowAxisOpacity(axis: ShadowAxis): number {
  if (!axis.sunward) return 0
  return Math.min(1, Math.max(0, (SHADOW_AXIS_SHOW_R - axis.missR) / SHADOW_AXIS_FADE_R))
}
