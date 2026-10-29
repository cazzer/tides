// The solar eclipse demo's orbit aid (tides-zec.1), main view only: the Moon's
// true path for a month around the present, the ecliptic as a flat circle of
// the same size, and the gold line where they cross, with a dot at each node.
// Near new moon it adds the Moon's true shadow axis (shadowAxis, at Earth's
// scale, so it shows the shadow hitting or missing Earth), and an arrow
// toward the Sun gives "above or below the Sun" a referent (tides-zec.12).
// Built relative to Earth and moved with it each frame; the orbit lines are
// rebuilt in place as the orbit guides are (ORBIT_GUIDE_REFRESH_DAYS), never
// per frame.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Line, Text } from '@react-three/drei'
import * as THREE from 'three'
import type { Line2 } from 'three-stdlib'
import { positionsFor } from '../flight-scale'
import { useStore } from '../store'
import {
  MOON_ORBIT_SEGMENTS,
  earthMoonOrbitPath,
  orbitGuideIsStale,
} from '../system-aids/orbit-guides'
import { LABEL_OUTLINE_COLOR, LABEL_OUTLINE_WIDTH } from '../system-aids/label-style'
import {
  NODE_LINE_REACH,
  eclipticCirclePoints,
  moonOrbitPlane,
  createShadowAxis,
  shadowAxis,
  shadowAxisOpacity,
  type MoonOrbitPlane,
} from './moon-orbit-tilt'

// Saturated enough to read lilac, not white, as a 1 px line on black. [TUNE]
const ORBIT_COLOR = '#B58CFF'
const ORBIT_OPACITY = 1
// Faint, so the lilac orbit reads over it where the two nearly coincide.
const ECLIPTIC_OPACITY = 0.25 // [TUNE]
const NODE_COLOR = '#E8C25A'
// Edge on, the node line lies along the ecliptic and the orbit: a 1 px line
// there vanished, so it is wider and drawn after them. Depth-tested, so Earth
// and the Moon hide what is behind them; the rings write no depth, so they
// don't cut it.
const NODE_LINE_PX = 2.5 // [TUNE]
const NODE_DOT_RADIUS = 0.3 // scene units [TUNE]
// Light, as a dark grey line vanishes on space.
const AXIS_COLOR = '#9AA3B5'
const AXIS_LINE_PX = 2 // [TUNE]
// Each way along the axis from its nearest point to Earth: well past Earth
// and the drawn Moon, so it reads as a line going by.
const AXIS_HALF_LENGTH = 15
// Pale, well apart from the nodes' gold, which the caption names: the arrow
// lies along the node line at the eclipse.
const SUN_COLOR = '#FFF1B8'
const SUN_ARROW_FROM = 4 // scene units from Earth's centre
const SUN_ARROW_TO = 9
// Below the ecliptic: at new moon the Sun is behind the drawn Moon, and an
// arrow through Earth's centre would end on it, reading as pointing at it.
const SUN_ARROW_DROP = 2.2
// A flat triangle turned about the shaft to face the eye, so seen nearly end
// on (the step's start, the eye ~28° from the Sun) it is still a pointed
// head, not a dot like the nodes'.
const SUN_HEAD_LENGTH = 1.4
const SUN_HEAD_HALF_WIDTH = 0.55
const SUN_LINE_PX = 2.5
// About 13 px on screen at step 5's distance (85), as the body names are.
const SUN_LABEL_SIZE = 1.1
// Under the shaft's middle, clear of a phone's edge.
const SUN_LABEL_ALONG = (SUN_ARROW_FROM + SUN_ARROW_TO) / 2
const SUN_LABEL_DROP = SUN_ARROW_DROP + 1.3

const X_AXIS = new THREE.Vector3(1, 0, 0)
const UNIT_LINE: [number, number, number][] = [
  [-1, 0, 0],
  [1, 0, 0],
]
const AXIS_POINTS: [number, number, number][] = [
  [-AXIS_HALF_LENGTH, 0, 0],
  [AXIS_HALF_LENGTH, 0, 0],
]
const SUN_SHAFT_POINTS: [number, number, number][] = [
  [SUN_ARROW_FROM, 0, 0],
  [SUN_ARROW_TO - SUN_HEAD_LENGTH, 0, 0],
]
const SUN_HEAD = new THREE.Shape()
  .moveTo(0, -SUN_HEAD_HALF_WIDTH)
  .lineTo(SUN_HEAD_LENGTH, 0)
  .lineTo(0, SUN_HEAD_HALF_WIDTH)
  .closePath()

function simTime(): number {
  return useStore.getState().timestamp ?? Date.now()
}

interface Lines {
  orbit: THREE.BufferGeometry
  ecliptic: THREE.BufferGeometry
  materials: THREE.LineBasicMaterial[]
  plane: MoonOrbitPlane
  /** Sim time the lines were last built for. */
  pathT: number
}

interface Parts {
  group: THREE.Group | null
  /** Turned so +X is the ascending node. */
  nodes: THREE.Group | null
  nodeLine: Line2 | null
  ascending: THREE.Mesh | null
  descending: THREE.Mesh | null
  /** At the axis' nearest point to Earth, turned so +X points away from the Sun. */
  axis: THREE.Group | null
  axisLine: Line2 | null
  /** Below Earth, turned so +X points at the Sun. */
  sun: THREE.Group | null
  sunHead: THREE.Mesh | null
  sunLabel: THREE.Group | null
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
  lines.plane = moonOrbitPlane(t)
  earthMoonOrbitPath(t, MOON_ORBIT_SEGMENTS, positionsOf(lines.orbit))
  eclipticCirclePoints(lines.plane.radius, MOON_ORBIT_SEGMENTS, positionsOf(lines.ecliptic))
  for (const geometry of [lines.orbit, lines.ecliptic]) {
    geometry.getAttribute('position').needsUpdate = true
    geometry.computeBoundingSphere()
  }
  lines.pathT = t
}

function createLines(t: number): Lines {
  const lines: Lines = {
    orbit: lineGeometry(MOON_ORBIT_SEGMENTS),
    ecliptic: lineGeometry(MOON_ORBIT_SEGMENTS),
    materials: [lineMaterial(ORBIT_COLOR, ORBIT_OPACITY), lineMaterial('#FFFFFF', ECLIPTIC_OPACITY)],
    plane: moonOrbitPlane(t),
    pathT: t,
  }
  build(lines, t)
  return lines
}

const _earth = new THREE.Vector3()
const _toSun = new THREE.Vector3()
const _eye = new THREE.Vector3()
const _shadow = createShadowAxis()

// Module level, so the memoised lines are mutated outside the hook.
function follow(lines: Lines, parts: Parts, t: number, camera: THREE.Camera) {
  const { group, nodes, nodeLine, ascending, descending, axis, axisLine, sun, sunHead, sunLabel } = parts
  if (!group) return
  _earth.fromArray(positionsFor('system').positionAt.earth(t))
  group.position.copy(_earth)
  if (orbitGuideIsStale('earth', lines.pathT, t)) build(lines, t)

  const { plane } = lines
  if (nodes) nodes.quaternion.setFromUnitVectors(X_AXIS, plane.ascendingNode)
  if (nodeLine) nodeLine.scale.setScalar(NODE_LINE_REACH * plane.radius)
  ascending?.position.set(plane.radius, 0, 0)
  descending?.position.set(-plane.radius, 0, 0)

  if (axis && axisLine) {
    const shadow = shadowAxis(t, _shadow)
    const opacity = shadowAxisOpacity(shadow)
    axis.visible = opacity > 0
    if (axis.visible) {
      axis.position.copy(shadow.closest)
      axis.quaternion.setFromUnitVectors(X_AXIS, shadow.direction)
      axisLine.material.opacity = opacity
    }
  }

  // The Sun sits at the scene's origin.
  _toSun.copy(_earth).negate().normalize()
  if (sun) {
    sun.quaternion.setFromUnitVectors(X_AXIS, _toSun)
    if (sunHead) {
      // Turned about the shaft (+X) so its face's normal, +Z, leans to the eye.
      sun.updateWorldMatrix(true, false)
      sun.worldToLocal(_eye.copy(camera.position))
      sunHead.rotation.x = Math.atan2(-_eye.y, _eye.z)
    }
  }
  sunLabel?.position.copy(_toSun).multiplyScalar(SUN_LABEL_ALONG).setY(-SUN_LABEL_DROP)
}

function noRaycast() {}

export function MoonOrbitTilt() {
  const lines = useMemo(() => createLines(simTime()), [])
  const parts = useRef<Parts>({
    group: null,
    nodes: null,
    nodeLine: null,
    ascending: null,
    descending: null,
    axis: null,
    axisLine: null,
    sun: null,
    sunHead: null,
    sunLabel: null,
  })

  useEffect(
    () => () => {
      for (const geometry of [lines.orbit, lines.ecliptic]) geometry.dispose()
      for (const material of lines.materials) material.dispose()
    },
    [lines]
  )

  useFrame(({ camera }) => follow(lines, parts.current, simTime(), camera))

  const [orbitMaterial, eclipticMaterial] = lines.materials
  const p = parts.current
  return (
    <group
      ref={(g) => {
        p.group = g
      }}
    >
      <lineLoop geometry={lines.orbit} material={orbitMaterial} raycast={noRaycast} />
      <lineLoop geometry={lines.ecliptic} material={eclipticMaterial} raycast={noRaycast} />
      {/* After the rings, so it shows where they lie along it edge on. */}
      <group
        ref={(g) => {
          p.nodes = g
        }}
      >
        <Line
          ref={(l) => {
            p.nodeLine = l as Line2 | null
          }}
          points={UNIT_LINE}
          color={NODE_COLOR}
          lineWidth={NODE_LINE_PX}
          depthWrite={false}
          transparent
          renderOrder={2}
          raycast={noRaycast}
        />
        {[0, 1].map((i) => (
          <mesh
            key={i}
            ref={(m) => {
              if (i === 0) p.ascending = m
              else p.descending = m
            }}
            renderOrder={2}
            raycast={noRaycast}
          >
            <sphereGeometry args={[NODE_DOT_RADIUS, 16, 12]} />
            <meshBasicMaterial color={NODE_COLOR} depthWrite={false} transparent />
          </mesh>
        ))}
      </group>
      <group
        ref={(g) => {
          p.axis = g
        }}
        visible={false}
      >
        <Line
          ref={(l) => {
            p.axisLine = l as Line2 | null
          }}
          points={AXIS_POINTS}
          color={AXIS_COLOR}
          lineWidth={AXIS_LINE_PX}
          depthWrite={false}
          transparent
          raycast={noRaycast}
        />
      </group>
      <group
        ref={(g) => {
          p.sun = g
        }}
        position={[0, -SUN_ARROW_DROP, 0]}
      >
        <Line points={SUN_SHAFT_POINTS} color={SUN_COLOR} lineWidth={SUN_LINE_PX} raycast={noRaycast} />
        <mesh
          ref={(m) => {
            p.sunHead = m
          }}
          position={[SUN_ARROW_TO - SUN_HEAD_LENGTH, 0, 0]}
          raycast={noRaycast}
        >
          <shapeGeometry args={[SUN_HEAD]} />
          <meshBasicMaterial color={SUN_COLOR} side={THREE.DoubleSide} />
        </mesh>
      </group>
      <Billboard
        ref={(g) => {
          p.sunLabel = g
        }}
      >
        <Text
          fontSize={SUN_LABEL_SIZE}
          color={SUN_COLOR}
          outlineWidth={LABEL_OUTLINE_WIDTH}
          outlineColor={LABEL_OUTLINE_COLOR}
          anchorX="center"
          anchorY="middle"
          raycast={noRaycast}
        >
          Sun
        </Text>
      </Billboard>
    </group>
  )
}
