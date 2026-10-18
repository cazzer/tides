import { forwardRef, useRef, useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { PerspectiveCamera } from '@react-three/drei'
import * as THREE from 'three'
import {
  degreesToRadians,
  calculateLocationAndRotationForLatLng,
} from './utils'
import type { Vec3 } from './ephemeris'
import { useCamera } from './camera'
import { useStore } from './store'
import { LocationPin } from './LocationPin'
import { applyBodyTransform } from './body-transform'

interface OrbitingBodyProps {
  positionAt?: (t: number) => Vec3
  spinAt?: (t: number) => number
  orientationAt?: (t: number) => THREE.Quaternion
  axialTilt?: number

  // Physical properties
  diameter?: number // Needed for surface camera positioning

  // Camera properties
  surfaceCamera?: boolean
  moonCamera?: boolean

  // Interaction properties
  interactive?: boolean
  storeLabel?: string
  focusKey?: 'clock' | 'earth' | 'sun' | 'moon'

  // Visual renderer
  children: React.ReactNode
}
export default forwardRef<THREE.Mesh, OrbitingBodyProps>(function OrbitingBody(
  {
    positionAt,
    spinAt,
    orientationAt,
    axialTilt = 0,
    diameter = 5, // Default diameter
    surfaceCamera = false,
    moonCamera = false,
    interactive = false,
    storeLabel,
    focusKey,
    children,
  },
  ref
) {
  const { handleFocus } = useCamera()
  const surfaceCameraRef = useRef<any>(null)
  const moonCameraRef = useRef<any>(null)
  const surfaceCameraContainerRef = useRef<THREE.Mesh>(null)
  const flagRef = useRef<THREE.Group>(null)
  const set = useThree((s) => s.set)
  const moon = useStore((s) => s.moon)
  const location = useStore((s) => s.location)
  const setPlanet = useStore((s) => s.setPlanet)
  const setEarthRadius = useStore((s) => s.setEarthRadius)

  useEffect(() => {
    setPlanet('locationPin', location ? flagRef : undefined)
  }, [location, setPlanet])

  useEffect(() => {
    if (storeLabel === 'earth') {
      setEarthRadius(diameter)
      return () => setEarthRadius(undefined)
    }
  }, [storeLabel, diameter, setEarthRadius])

  useEffect(() => {
    if (surfaceCamera) {
      set({ camera: surfaceCameraRef.current })
    }

    if (moonCamera && moon?.current) {
      // @ts-ignore
      moonCameraRef.current.lookAt(moon.current.position)
      set({ camera: moonCameraRef.current })
    }
  }, [moon])

  useFrame((state) => {
    const simulationState = state as typeof state & {
      timestamp?: number
    }
    const simulationTime =
      typeof simulationState.timestamp === 'number'
        ? simulationState.timestamp
        : null
    if (simulationTime == null) {
      return
    }

    if (ref && 'current' in ref && ref.current) {
      applyBodyTransform(
        ref.current,
        { axialTilt, spinAt, orientationAt, positionAt },
        simulationTime
      )
      if (focusKey) ref.current.userData.focus = focusKey
    }

    // look at the moon
    if (moonCamera && moon?.current) {
      // @ts-ignore
      moonCameraRef.current.lookAt(moon.current.position)
    }

    // calculate surface camera position (use location from store if set)
    if (surfaceCameraContainerRef.current) {
      const lat = location?.lat ?? -30
      const lng = location?.lon ?? 0
      const { position, rotation } = calculateLocationAndRotationForLatLng(
        lat,
        lng,
        diameter
      )

      if (surfaceCameraContainerRef.current) {
        surfaceCameraContainerRef.current.position.x = position.x
        surfaceCameraContainerRef.current.position.y = position.y
        surfaceCameraContainerRef.current.position.z = position.z
        surfaceCameraContainerRef.current.rotation.x = rotation.x
        surfaceCameraContainerRef.current.rotation.y = rotation.y
        surfaceCameraContainerRef.current.rotation.z = rotation.z
      }
    }
  })

  const onClick = (event) => {
    event.stopPropagation()
    if (interactive) {
      handleFocus(event)
    }
  }

  const onCameraClick = (event) => {
    event.stopPropagation()
    if (interactive) {
      handleFocus(event)
    }
  }

  return (
    <group>
      <mesh
        castShadow
        receiveShadow
        position={[0, 0, 0]}
        rotation={[degreesToRadians(axialTilt), 0, 0]}
        onPointerDown={onClick}
        // @ts-ignore
        ref={ref}
      >
        {/* Surface camera for Earth */}
        {storeLabel === 'earth' && (
          <mesh
            position={[0, 0, -diameter]}
            rotation={[0, 0, Math.PI]}
            ref={surfaceCameraContainerRef}
            onPointerDown={onCameraClick}
          >
            <PerspectiveCamera
              position={[0, 0, 0]}
              rotation={[0, 0, 0]}
              zoom={0.75}
              ref={surfaceCameraRef}
            />
          </mesh>
        )}

        {/* Moon camera */}
        <PerspectiveCamera
          position={[0, 0, 0]}
          zoom={1}
          ref={moonCameraRef}
        />

        {/* Render the visual representation */}
        {children}

        {/* Location pin on earth when geolocation is set (only in main view, not in "View from Earth" camera) */}
        {storeLabel === 'earth' && location && !surfaceCamera && (
          <LocationPin
            ref={flagRef}
            lat={location.lat}
            lon={location.lon}
            diameter={diameter}
          />
        )}
      </mesh>
    </group>
  )
})
