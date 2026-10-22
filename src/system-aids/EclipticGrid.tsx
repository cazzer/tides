// The ecliptic grid and AU rings (tides-2hv.9), mounted by SystemAids.tsx
// while systemAids.grid is on: a faint polar grid in the ecliptic plane with
// dashed rings at 1, 2, 5, 10, 20 and 30 AU, each labelled with its true
// distance (geometry and the reasons for its shape in ecliptic-grid.ts).
//
// In the system view the rings follow its compressed spacing, so the labels
// are what carry scale: 10 AU is drawn not quite twice as far out as 5.
// Ship mode shows them too, at flight spacing, where they are linear: there
// the rings are the one thing that says how far apart the planets really are
// while you fly between them, and how far you've come. The labels keep a
// fixed size on screen in both, facing the camera, so they stay readable
// zoomed all the way out and from across the system.
import { useEffect, useMemo, useRef, type FC } from 'react'
import { useFrame } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import * as THREE from 'three'
import { positionsFor } from '../flight-scale'
import {
  AU_RINGS,
  ringArrays,
  ringLabel,
  ringLabelPosition,
  spokePositions,
} from './ecliptic-grid'
import { worldUnitsPerPixel } from './pixel-scale'
import type { SystemAidProps } from './types'

// Cooler and greyer than the orbits' lilac, so a ring never reads as an orbit.
const GRID_COLOR = '#9AA3C2'
/** [TUNE] The rings' opacity. Their dashes leave half the ring dark. */
export const RING_OPACITY = 0.22 // [TUNE]
/** [TUNE] The spokes': barely there, a hint of the plane's tilt. */
export const SPOKE_OPACITY = 0.07 // [TUNE]
/** [TUNE] The labels' text opacity. */
export const RING_LABEL_OPACITY = 0.7 // [TUNE]
/**
 * Label em height, CSS pixels. [TUNE] About 9 px capitals: legible on a
 * phone, and small beside the planet labels.
 */
export const RING_LABEL_PX = 13 // [TUNE]
// The label starts just off its ring, up and to the right on screen, in ems.
const LABEL_NUDGE: [number, number, number] = [0.35, 0.15, 0]

interface Grid {
  rings: THREE.BufferGeometry
  spokes: THREE.BufferGeometry
}

function createGrid(distance: (au: number) => number): Grid {
  const { positions, lineDistances, indices } = ringArrays(distance)
  const rings = new THREE.BufferGeometry()
  rings.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  rings.setAttribute('lineDistance', new THREE.BufferAttribute(lineDistances, 1))
  rings.setIndex(new THREE.BufferAttribute(indices, 1))
  const spokes = new THREE.BufferGeometry()
  spokes.setAttribute('position', new THREE.BufferAttribute(spokePositions(distance), 3))
  return { rings, spokes }
}

interface Materials {
  ring: THREE.LineDashedMaterial
  spoke: THREE.LineBasicMaterial
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
    spoke: new THREE.LineBasicMaterial({
      color: GRID_COLOR,
      transparent: true,
      opacity: SPOKE_OPACITY,
      depthWrite: false,
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

export const EclipticGrid: FC<SystemAidProps> = ({ distanceScale }) => {
  const { distance } = positionsFor(distanceScale)
  const grid = useMemo(() => createGrid(distance), [distance])
  const materials = useMemo(() => createMaterials(), [])
  const labels = useRef<(THREE.Group | null)[]>([])

  useEffect(
    () => () => {
      grid.rings.dispose()
      grid.spokes.dispose()
    },
    [grid]
  )
  useEffect(
    () => () => {
      materials.ring.dispose()
      materials.spoke.dispose()
      materials.label.dispose()
    },
    [materials]
  )

  useFrame(({ camera, size }) => faceLabels(labels.current, camera, size.height))

  return (
    <>
      <lineSegments
        geometry={grid.rings}
        material={materials.ring}
        raycast={noRaycast}
      />
      <lineSegments
        geometry={grid.spokes}
        material={materials.spoke}
        raycast={noRaycast}
      />
      {AU_RINGS.map((au, i) => (
        <group
          key={au}
          ref={(group) => {
            labels.current[i] = group
          }}
          position={ringLabelPosition(distance, au)}
        >
          <Text
            material={materials.label}
            color={GRID_COLOR}
            fillOpacity={RING_LABEL_OPACITY}
            fontSize={1}
            position={LABEL_NUDGE}
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
