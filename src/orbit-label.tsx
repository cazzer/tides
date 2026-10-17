import * as THREE from 'three'
import { useEffect, useMemo, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { Text } from '@react-three/drei'
import { useCamera } from './camera'
import { useStore } from './store'
import { earthAngle, monthStartAngles } from './ephemeris'

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

// Roughly half the clock text's width, so the camera centres on the text
// rather than its right-anchored outer end.
const CLOCK_CENTRE_INSET = 8
const FADE_START = (6 * Math.PI) / 180
const FADE_END = (12 * Math.PI) / 180

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
})
const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
})

function formatClockDate(date: Date): string {
  return `${weekdayFormat.format(date)}, ${dateFormat.format(date)}\n${timeFormat.format(date)}`
}

function wrapToPi(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI))
}

function smoothstep(x: number, edge0: number, edge1: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

export function OrbitLabel({ radius }: { radius: number }) {
  const clockRef = useRef<THREE.Object3D>(null)
  const { handleFocus } = useCamera()
  const setPlanet = useStore((s) => s.setPlanet)

  useEffect(() => {
    setPlanet('clock', clockRef)
  }, [setPlanet])

  useEffect(() => {
    if (clockRef.current) {
      handleFocus({
        object: clockRef.current,
        instanceId: undefined,
      })
    }
  }, [clockRef.current])

  const lineGeometry = useMemo(() => {
    const eclipsePoints = []
    for (let index = 0; index < 256; index++) {
      const angle = (index / 256) * 2 * Math.PI
      const x = radius * Math.cos(angle)
      const z = radius * Math.sin(angle)
      eclipsePoints.push(new THREE.Vector3(x, 0, z))
    }
    eclipsePoints.push(eclipsePoints[0])
    return new THREE.BufferGeometry().setFromPoints(eclipsePoints)
  }, [radius])

  useEffect(() => () => lineGeometry.dispose(), [lineGeometry])

  const sceneTimestamp = useThree(
    (s) => (s as typeof s & { timestamp?: number }).timestamp
  )
  // Unset until SolarSystem's first frame, which starts from Date.now().
  const timestamp: number = sceneTimestamp ?? Date.now()
  const year = new Date(timestamp).getFullYear()
  const angles = useMemo(() => monthStartAngles(year), [year])

  const clockAngle = earthAngle(timestamp)
  const clockCentre = 0.75 * radius - CLOCK_CENTRE_INSET

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
      <object3D
        ref={clockRef}
        userData-focus="clock"
        position={[
          clockCentre * Math.cos(clockAngle),
          0.5,
          -clockCentre * Math.sin(clockAngle),
        ]}
      />
      <Text
        userData-focus="clock"
        onClick={handleFocus}
        scale={[2, 2, 2]}
        color="white" // default
        anchorX="right"
        anchorY="middle" // default
        textAlign="right"
        position={[
          0.75 * radius * Math.cos(clockAngle),
          0.5,
          -0.75 * radius * Math.sin(clockAngle),
        ]}
        rotation={[-Math.PI / 2, 0, clockAngle]}
      >
        {formatClockDate(new Date(timestamp))}
      </Text>

      {MONTHS.map((month, m) => (
        <Text
          key={month}
          scale={[4, 4, 4]}
          color="white" // default
          anchorX="right"
          anchorY="middle" // default
          position={[
            0.75 * radius * Math.cos(angles[m]),
            0,
            -0.75 * radius * Math.sin(angles[m]),
          ]}
          rotation={[-Math.PI / 2, 0, angles[m]]}
          fillOpacity={
            0.25 *
            smoothstep(
              Math.abs(wrapToPi(angles[m] - clockAngle)),
              FADE_START,
              FADE_END
            )
          }
        >
          {month}
        </Text>
      ))}
    </group>
  )
}
