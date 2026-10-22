// The ecliptic grid's AU rings (tides-2hv.9), mounted by SystemAids.tsx while
// systemAids.grid is on: dashed rings in the ecliptic plane at 1, 2, 5, 10,
// 20 and 30 AU, each labelled with its true distance (geometry and the
// reasons for its shape in ecliptic-grid.ts). The 1 AU ring is Earth's month
// ring, so it gets a label but no second line.
//
// The rings follow the system view's compressed spacing, so the labels are
// what carry scale: 10 AU is drawn not quite twice as far out as 5. They
// keep a fixed size on screen, facing the camera, so they stay readable
// zoomed all the way out.
//
// Hidden in ship mode (decided in review): the ship flies within a few units
// of the ecliptic plane, where the rings are seen edge-on and bunch into a
// band of lines along the horizon that says nothing about distance. The moon
// orbit lines (OrbitGuides) and planet orbits stay there.
import { useEffect, useMemo, useRef, type FC } from 'react'
import { useFrame } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import * as THREE from 'three'
import type { DistanceScale } from '../distance-scale'
import type { Vec3 } from '../ephemeris'
import { positionsFor } from '../flight-scale'
import { PLANET_KEYS } from '../planets'
import { useStore } from '../store'
import {
  AU_RINGS,
  drawnRings,
  ringArrays,
  ringLabel,
  ringLabelAngles,
  ringLabelPosition,
} from './ecliptic-grid'
import { worldUnitsPerPixel } from './pixel-scale'
import type { SystemAidProps } from './types'

// Cooler and greyer than the orbits' lilac, so a ring never reads as an orbit.
const GRID_COLOR = '#9AA3C2'
/** [TUNE] The rings' opacity. Their dashes leave half the ring dark. */
export const RING_OPACITY = 0.22 // [TUNE]
/** [TUNE] The labels' text opacity. */
export const RING_LABEL_OPACITY = 0.7 // [TUNE]
/**
 * Label em height, CSS pixels. [TUNE] About 9 px capitals: legible on a
 * phone, and small beside the planet labels.
 */
export const RING_LABEL_PX = 13 // [TUNE]
// The label starts just off its ring, up and to the right on screen, in ems.
const TEXT_OFFSET: [number, number, number] = [0.35, 0.15, 0]

const LABEL_BODIES = ['earth', ...PLANET_KEYS] as const

function createRings(distance: (au: number) => number): THREE.BufferGeometry {
  const { positions, lineDistances, indices } = ringArrays(distance, drawnRings(distance))
  const rings = new THREE.BufferGeometry()
  rings.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  rings.setAttribute('lineDistance', new THREE.BufferAttribute(lineDistances, 1))
  rings.setIndex(new THREE.BufferAttribute(indices, 1))
  return rings
}

// Where the labels go, clear of the planets where they are at mount (they
// move a few degrees a year at most, outside a fast clock).
function labelPositions(scale: DistanceScale): [number, number, number][] {
  const { distance, positionAt } = positionsFor(scale)
  const t = useStore.getState().timestamp ?? Date.now()
  // Copies: positionAt hands back shared arrays.
  const bodies = LABEL_BODIES.map((key): Vec3 => {
    const [x, y, z] = positionAt[key](t)
    return [x, y, z]
  })
  const angles = ringLabelAngles(distance, bodies)
  return AU_RINGS.map((au, i) => ringLabelPosition(distance, au, angles[i]))
}

interface Materials {
  ring: THREE.LineDashedMaterial
  label: THREE.MeshBasicMaterial
}

function createMaterials(): Materials {
  return {
    // A dash period of 1, in the lineDistance units ringArrays writes.
    ring: new THREE.LineDashedMaterial({
      color: GRID_COLOR,
      transparent: true,
      opacity: RING_OPACITY,
      depthWrite: false,
      dashSize: 0.5,
      gapSize: 0.5,
    }),
    // Depth-tested so a planet in front hides a label, never written.
    label: new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
  }
}

// Module level, so the labels behind the refs are mutated outside the hook:
// each faces the camera and is scaled to RING_LABEL_PX at its depth.
function faceLabels(
  labels: readonly (THREE.Object3D | null)[],
  camera: THREE.Camera,
  heightPx: number
) {
  for (const label of labels) {
    if (!label) continue
    label.quaternion.copy(camera.quaternion)
    label.scale.setScalar(RING_LABEL_PX * worldUnitsPerPixel(camera, label.position, heightPx))
  }
}

function noRaycast() {}

export const EclipticGrid: FC<SystemAidProps> = ({ distanceScale, ship }) => {
  if (ship) return null
  return <Rings distanceScale={distanceScale} />
}

function Rings({ distanceScale }: { distanceScale: DistanceScale }) {
  const { distance } = positionsFor(distanceScale)
  const rings = useMemo(() => createRings(distance), [distance])
  const positions = useMemo(() => labelPositions(distanceScale), [distanceScale])
  const materials = useMemo(() => createMaterials(), [])
  const labels = useRef<(THREE.Group | null)[]>([])

  useEffect(() => () => rings.dispose(), [rings])
  useEffect(
    () => () => {
      materials.ring.dispose()
      materials.label.dispose()
    },
    [materials]
  )

  useFrame(({ camera, size }) => faceLabels(labels.current, camera, size.height))

  return (
    <>
      <lineSegments
        geometry={rings}
        material={materials.ring}
        raycast={noRaycast}
      />
      {AU_RINGS.map((au, i) => (
        <group
          key={au}
          ref={(group) => {
            labels.current[i] = group
          }}
          position={positions[i]}
        >
          <Text
            material={materials.label}
            color={GRID_COLOR}
            fillOpacity={RING_LABEL_OPACITY}
            fontSize={1}
            position={TEXT_OFFSET}
            anchorX="left"
            anchorY="bottom"
            raycast={noRaycast}
          >
            {ringLabel(au)}
          </Text>
        </group>
      ))}
    </>
  )
}
