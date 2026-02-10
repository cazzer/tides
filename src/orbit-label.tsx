import * as THREE from 'three'
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Text, Text3D } from '@react-three/drei'
import { calculateOrbitPosition } from './utils'
import { useCamera } from './camera'
import { useStore } from './store'

function formatClockDate(date: Date): string {
  const weekday = date.toLocaleDateString(undefined, { weekday: 'long' })
  const datePart = date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
  const timePart = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })
  return `${weekday}, ${datePart} ${timePart}`
}

export function OrbitLabel({
  radius,
  segments,
  targetPosition,
  orbitalPeriod,
  firstSegmentPosition = 0,
  orbitOffset = 0,
}: {
  radius: number
  segments?: string[]
  targetPosition?: any
  orbitalPeriod: number
  firstSegmentPosition?: number
  orbitOffset?: number
}) {
  const dateRef = useRef<THREE.Object3D>(null)
  const clockRef = useRef<THREE.Object3D>(null)
  const { handleFocus } = useCamera()
  const { camera, controls } = useThree()
  const setPlanet = useStore((s) => s.setPlanet)

  useEffect(() => {
    setPlanet('clock', clockRef)
  }, [setPlanet])

  useFrame(() => {
    if (dateRef.current) {
      clockRef.current = dateRef.current
      dateRef.current.userData.focus = 'clock'
    }
  })

  useEffect(() => {
    if (dateRef.current) {
      handleFocus({
        object: dateRef.current,
        instanceId: undefined,
      })
    }
  }, [dateRef.current])

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

  const segmentRotation =
    -orbitOffset - (Math.PI * 2) / segmentDefinitions.length

  // @ts-ignore
  const { timestamp } = useThree()

  const coords = calculateOrbitPosition({
    radius: radius - 20,
    period: orbitalPeriod,
    time: timestamp,
    centerX: 0,
    centerY: 0,
    centerZ: 0,
    inclination: 0,
    orbitOffset,
  })

  const lineGeometry = new THREE.BufferGeometry().setFromPoints(eclipsePoints)

  return (
    <group>
      {/* @ts-ignore */}
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
          onClick={handleFocus}
          scale={[2, 2, 2]}
          color="white" // default
          anchorX="center" // default
          anchorY="middle" // default
          position={[coords.x, coords.y + 1.5, coords.z]}
          rotation={[-Math.PI / 2, 0, coords.angle]}
        >
          {formatClockDate(new Date(timestamp))}
        </Text>
      )}

      {segmentDefinitions.map((segment) => (
        <group
          key={segment.label}
          rotation={[0, segmentRotation, 0]}
        >
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

export function OrbitLabel3D({
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
  const dateRef = useRef(null)
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

  // @ts-ignore
  const { timestamp } = useThree()

  const coords = calculateOrbitPosition({
    radius: radius - 38,
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
      {/* @ts-ignore */}
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
        <Text3D
          ref={dateRef}
          scale={[1.1, 1.1, 0.1]}
          position={[coords.x, coords.y + 1.5, coords.z]}
          rotation={[-Math.PI / 2, 0, coords.angle]}
          curveSegments={24}
          bevelEnabled
          bevelSize={0.08}
          bevelThickness={0.03}
          height={1}
          lineHeight={0.9}
          letterSpacing={0.3}
          font={'/Roboto-light.json'}
        >
          {formatClockDate(new Date(timestamp))}
        </Text3D>
      )}

      {segmentDefinitions.map((segment) => (
        <group key={segment.label}>
          <Text3D
            scale={[4, 4, 0.1]}
            position={segment.labelPosition}
            rotation={[-Math.PI / 2, 0, segment.labelRotation]}
            curveSegments={24}
            bevelEnabled
            bevelSize={0.08}
            bevelThickness={0.03}
            height={1}
            lineHeight={0.9}
            letterSpacing={0.3}
            font={'/Roboto-light.json'}
          >
            {segment.label}
            <meshBasicMaterial
              attach="material"
              color="white"
              opacity={0.25}
              transparent
            />
          </Text3D>
        </group>
      ))}
    </group>
  )
}
