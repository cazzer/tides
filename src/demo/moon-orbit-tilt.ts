// Why eclipses are rare (tides-zec.1, the solar eclipse demo's last step): the
// Moon's orbit is tilted ~5° to the ecliptic, so a new moon only shadows Earth
// near a node, where the two planes cross. All relative to Earth, in
// moonOffset's units and scene axes (+Y ecliptic north).

import * as THREE from 'three'
import { moonOffset } from '../ephemeris'

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
