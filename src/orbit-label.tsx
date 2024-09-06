import * as THREE from 'three'
import { useRef } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import { calculateOrbitPosition } from './utils'

export function OrbitLabel({
  radius,
  segments,
  targetPosition,
  orbitalPeriod,
  rotationPeriod,
  firstSegmentPosition = 0,
}: {
  radius: number
  segments?: string[]
  targetPosition?: any
  orbitalPeriod: number
  rotationPeriod: number
  firstSegmentPosition?: number
}) {
  const dateRef = useRef()
  const eclipsePoints = []
  for (let index = 0; index < 256; index++) {
    const angle = (index / 256) * 2 * Math.PI + firstSegmentPosition
    const x = radius * Math.cos(angle)
    const z = radius * Math.sin(angle)
    eclipsePoints.push(new THREE.Vector3(x, 0, z))
  }
  eclipsePoints.push(eclipsePoints[0])

  const segmentDefinitions = []
  if (segments) {
    const segmentCount = segments.length

    for (let index = 0; index < segmentCount; index++) {
      const angle = (index / segmentCount) * 2 * Math.PI
      const x = radius * Math.cos(angle)
      const z = radius * Math.sin(angle)
      segmentDefinitions.push({
        label: segments[index],
        geometry: new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(1, 1, 1),
          new THREE.Vector3(x, 0, z),
        ]),
        labelRotation: -((2 * Math.PI) / segmentCount) * index,
        labelPosition: new THREE.Vector3(
          radius * 0.75 * Math.cos(angle),
          0,
          radius * 0.75 * Math.sin(angle)
        ),
      })
    }
  }

  const { timestamp } = useThree()

  const coords = calculateOrbitPosition({
    radius: radius - 6,
    period: orbitalPeriod,
    time: timestamp,
    centerX: 0,
    centerY: 0,
    centerZ: 0,
    inclination: 0,
  })

  const lineGeometry = new THREE.BufferGeometry().setFromPoints(eclipsePoints)

  return (
    <group>
      <line geometry={lineGeometry}>
        <lineBasicMaterial
          attach="material"
          color="#BFBBDA"
          linewidth={10}
          transparent
          opacity={0.2}
        />
      </line>
      {targetPosition?.x && (
        <Text
          ref={dateRef}
          scale={[2, 2, 2]}
          color="white" // default
          anchorX="right" // default
          anchorY="middle" // default
          position={[coords.x, coords.y + 1.5, coords.z]}
          rotation={[-Math.PI / 2, 0, coords.angle]}
        >
          {new Date(timestamp).toUTCString()}
        </Text>
      )}

      {segmentDefinitions.map((segment) => (
        <group key={segment.label}>
          <Text
            scale={[4, 4, 4]}
            color="white" // default
            anchorX="right" // default
            anchorY="middle" // default
            position={segment.labelPosition}
            rotation={[-Math.PI / 2, 0, segment.labelRotation]}
            fillOpacity={0.25}
          >
            {segment.label}
          </Text>
        </group>
      ))}
    </group>
  )
}
