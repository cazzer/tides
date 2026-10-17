import * as THREE from 'three'
import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import { useCamera } from './camera'
import { useStore } from './store'
import { earthPosition, monthStartAngles } from './ephemeris'

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

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

export function OrbitLabel({ radius }: { radius: number }) {
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
    const angle = (index / 256) * 2 * Math.PI
    const x = radius * Math.cos(angle)
    const z = radius * Math.sin(angle)
    eclipsePoints.push(new THREE.Vector3(x, 0, z))
  }
  eclipsePoints.push(eclipsePoints[0])

  // @ts-ignore
  const { timestamp: sceneTimestamp } = useThree()
  // Unset until SolarSystem's first frame, which starts from Date.now().
  const timestamp: number = sceneTimestamp ?? Date.now()
  const year = new Date(timestamp).getFullYear()
  const angles = useMemo(() => monthStartAngles(year), [year])

  const [markerX, markerY, markerZ] = earthPosition(timestamp)
  const markerAngle = Math.atan2(-markerZ, markerX)

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
      <Text
        ref={dateRef}
        onClick={handleFocus}
        scale={[2, 2, 2]}
        color="white" // default
        anchorX="center" // default
        anchorY="middle" // default
        position={[markerX, markerY + 1.5, markerZ]}
        rotation={[-Math.PI / 2, 0, markerAngle]}
      >
        {formatClockDate(new Date(timestamp))}
      </Text>

      {MONTHS.map((month, m) => (
        <Text
          key={month}
          scale={[4, 4, 4]}
          color="white" // default
          anchorX="right" // default
          anchorY="middle" // default
          position={[
            0.75 * radius * Math.cos(angles[m]),
            0,
            -0.75 * radius * Math.sin(angles[m]),
          ]}
          rotation={[-Math.PI / 2, 0, angles[m]]}
          fillOpacity={0.25}
        >
          {month}
        </Text>
      ))}
    </group>
  )
}
