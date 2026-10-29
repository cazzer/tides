// The solar eclipse demo's orbit aid (tides-zec.1), main view only: the Moon's
// true path for a month around the present, the ecliptic as a flat circle of
// the same size, and the gold line where they cross. Built relative to Earth
// and moved with it each frame; rebuilt in place as the orbit guides are
// (ORBIT_GUIDE_REFRESH_DAYS), never per frame.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { positionsFor } from '../flight-scale'
import { useStore } from '../store'
import {
  MOON_ORBIT_SEGMENTS,
  earthMoonOrbitPath,
  orbitGuideIsStale,
} from '../system-aids/orbit-guides'
import { eclipticCirclePoints, moonOrbitPlane, nodeLinePoints } from './moon-orbit-tilt'

const ORBIT_COLOR = '#BFBBDA'
const ORBIT_OPACITY = 0.85 // [TUNE]
const ECLIPTIC_OPACITY = 0.45 // [TUNE]
const NODE_COLOR = '#E8C25A'
const NODE_OPACITY = 1 // [TUNE]

function simTime(): number {
  return useStore.getState().timestamp ?? Date.now()
}

interface Lines {
  orbit: THREE.BufferGeometry
  ecliptic: THREE.BufferGeometry
  node: THREE.BufferGeometry
  materials: THREE.LineBasicMaterial[]
  /** Sim time the lines were last built for. */
  pathT: number
}

function lineGeometry(points: number) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points * 3), 3))
  return geometry
}

function lineMaterial(color: string, opacity: number) {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
}

function positionsOf(geometry: THREE.BufferGeometry): Float32Array {
  return (geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
}

function build(lines: Lines, t: number) {
  const plane = moonOrbitPlane(t)
  earthMoonOrbitPath(t, MOON_ORBIT_SEGMENTS, positionsOf(lines.orbit))
  eclipticCirclePoints(plane.radius, MOON_ORBIT_SEGMENTS, positionsOf(lines.ecliptic))
  nodeLinePoints(plane, positionsOf(lines.node))
  for (const geometry of [lines.orbit, lines.ecliptic, lines.node]) {
    geometry.getAttribute('position').needsUpdate = true
    geometry.computeBoundingSphere()
  }
  lines.pathT = t
}

function createLines(t: number): Lines {
  const lines: Lines = {
    orbit: lineGeometry(MOON_ORBIT_SEGMENTS),
    ecliptic: lineGeometry(MOON_ORBIT_SEGMENTS),
    node: lineGeometry(2),
    materials: [
      lineMaterial(ORBIT_COLOR, ORBIT_OPACITY),
      lineMaterial('#FFFFFF', ECLIPTIC_OPACITY),
      lineMaterial(NODE_COLOR, NODE_OPACITY),
    ],
    pathT: t,
  }
  build(lines, t)
  return lines
}

// Module level, so the memoised lines are mutated outside the hook.
function follow(lines: Lines, group: THREE.Group | null, t: number) {
  if (!group) return
  group.position.fromArray(positionsFor('system').positionAt.earth(t))
  if (orbitGuideIsStale('earth', lines.pathT, t)) build(lines, t)
}

function noRaycast() {}

export function MoonOrbitTilt() {
  const lines = useMemo(() => createLines(simTime()), [])
  const group = useRef<THREE.Group>(null)

  useEffect(
    () => () => {
      for (const geometry of [lines.orbit, lines.ecliptic, lines.node]) geometry.dispose()
      for (const material of lines.materials) material.dispose()
    },
    [lines]
  )

  useFrame(() => follow(lines, group.current, simTime()))

  const [orbitMaterial, eclipticMaterial, nodeMaterial] = lines.materials
  return (
    <group ref={group}>
      <lineLoop
        geometry={lines.orbit}
        material={orbitMaterial}
        raycast={noRaycast}
      />
      <lineLoop
        geometry={lines.ecliptic}
        material={eclipticMaterial}
        raycast={noRaycast}
      />
      {/* Last, so it shows over the ecliptic lines it lies along edge on. */}
      <lineSegments
        renderOrder={1}
        geometry={lines.node}
        material={nodeMaterial}
        raycast={noRaycast}
      />
    </group>
  )
}
