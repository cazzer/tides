import { forwardRef, useRef, useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { PerspectiveCamera } from '@react-three/drei'
import * as THREE from 'three'
import { degreesToRadians } from './utils'
import { moonPosition, type Vec3 } from './ephemeris'
import { useCamera } from './camera'
import { useStore, type CameraFocus } from './store'
import { LocationPin } from './LocationPin'
import { applyBodyTransform } from './body-transform'
import {
  DEFAULT_SURFACE_LOCATION,
  GROUND_RADIUS,
  SURFACE_FOV,
  horizonGlowGeometry,
  placeSurfaceCamera,
} from './sky'

const moonTarget = new THREE.Vector3()

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
  focusKey?: Exclude<CameraFocus, 'location'>

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
  const horizonGlow = useMemo(
    () => (surfaceCamera ? horizonGlowGeometry(GROUND_RADIUS) : undefined),
    [surfaceCamera]
  )
  useEffect(() => () => horizonGlow?.dispose(), [horizonGlow])
  const flagRef = useRef<THREE.Group>(null)
  const set = useThree((s) => s.set)
  const location = useStore((s) => s.location)
  const setPlanet = useStore((s) => s.setPlanet)
  const setEarthRadius = useStore((s) => s.setEarthRadius)

  // Only the main panel's Earth mounts a LocationPin that the camera can focus.
  const ownsLocationPin = storeLabel === 'earth' && interactive
  useEffect(() => {
    if (!ownsLocationPin) return
    setPlanet('locationPin', location ? flagRef : undefined)
  }, [ownsLocationPin, location, setPlanet])

  // Same owner as the pin: the single layout unmounts the other panels, and
  // their cleanup must not clear the radius the main camera still reads.
  useEffect(() => {
    if (storeLabel === 'earth' && interactive) {
      setEarthRadius(diameter)
      return () => setEarthRadius(undefined)
    }
  }, [storeLabel, interactive, diameter, setEarthRadius])

  useEffect(() => {
    if (surfaceCamera) {
      set({ camera: surfaceCameraRef.current })
    }

    if (moonCamera) {
      set({ camera: moonCameraRef.current })
    }
  }, [])

  useFrame(() => {
    const simulationTime = useStore.getState().timestamp
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
    if (moonCamera) {
      moonCameraRef.current.lookAt(
        moonTarget.fromArray(moonPosition(simulationTime))
      )
    }

    // calculate surface camera position (use location from store if set)
    if (surfaceCameraContainerRef.current && surfaceCameraRef.current) {
      const { lat, lon } = location ?? DEFAULT_SURFACE_LOCATION
      placeSurfaceCamera(
        surfaceCameraContainerRef.current,
        surfaceCameraRef.current,
        lat,
        lon,
        diameter
      )
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
            ref={surfaceCameraContainerRef}
            onPointerDown={onCameraClick}
          >
            <PerspectiveCamera
              fov={SURFACE_FOV}
              ref={surfaceCameraRef}
            />
            {surfaceCamera && (
              <mesh>
                <sphereGeometry
                  args={[GROUND_RADIUS, 64, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2]}
                />
                <meshBasicMaterial
                  color="#161a14"
                  side={THREE.BackSide}
                />
              </mesh>
            )}
            {horizonGlow && (
              <mesh geometry={horizonGlow}>
                <meshBasicMaterial
                  vertexColors
                  side={THREE.BackSide}
                  transparent
                  blending={THREE.AdditiveBlending}
                  depthWrite={false}
                />
              </mesh>
            )}
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
