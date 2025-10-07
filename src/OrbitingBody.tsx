import { forwardRef, useRef, useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { PerspectiveCamera } from '@react-three/drei'
import * as THREE from 'three'
import {
  calculateOrbitPosition,
  calculateRotation,
  degreesToRadians,
  calculateLocationAndRotationForLatLng,
} from './utils'
import { useCamera } from './camera'
import { useStore } from './store'
import { OrbitLabel } from './orbit-label'

interface OrbitingBodyProps {
  // Orbital properties
  orbitalDistance?: number
  orbitalPeriod?: number
  orbitalInclination?: number
  orbitOffset?: number
  parent?: { current: THREE.Mesh }

  // Rotation properties
  rotationPeriod: number
  rotationOffset?: number
  axialTilt?: number

  // Physical properties
  diameter?: number // Needed for surface camera positioning

  // Camera properties
  surfaceCamera?: boolean
  moonCamera?: boolean

  // Interaction properties
  interactive?: boolean
  storeLabel?: string
  showOrbit?: boolean

  // Visual renderer
  children: React.ReactNode
}
export default forwardRef<THREE.Mesh, OrbitingBodyProps>(function OrbitingBody(
  {
    orbitalDistance,
    orbitalPeriod,
    orbitalInclination = 0,
    orbitOffset = 0,
    parent,
    rotationPeriod,
    rotationOffset = 0,
    axialTilt = 0,
    diameter = 5, // Default diameter
    surfaceCamera = false,
    moonCamera = false,
    interactive = false,
    storeLabel,
    showOrbit = false,
    children,
  },
  ref
) {
  const { handleFocus } = useCamera()
  const surfaceCameraRef = useRef<any>()
  const moonCameraRef = useRef<any>()
  const surfaceCameraContainerRef = useRef<THREE.Mesh>()
  const { get, set } = useThree(({ get, set }) => ({ get, set }))
  const { moon } = useStore()

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
    // calculate rotation
    const rotation = calculateRotation(
      rotationPeriod,
      // @ts-ignore
      state.timestamp || Date.now(),
      rotationOffset
    )

    if (ref && 'current' in ref && ref.current) {
      ref.current.rotation.y = rotation
    }

    // calculate orbital position if this body orbits something
    if (
      orbitalDistance &&
      orbitalPeriod &&
      ref &&
      'current' in ref &&
      ref.current
    ) {
      const coords = calculateOrbitPosition({
        radius: orbitalDistance,
        period: orbitalPeriod,
        // @ts-ignore
        time: state.timestamp || Date.now(),
        centerX: parent?.current.position.x || 0,
        centerZ: parent?.current.position.z || 0,
        centerY: 0,
        inclination: orbitalInclination,
        orbitOffset,
      })

      ref.current.position.x = coords.x
      ref.current.position.z = coords.z
      ref.current.position.y = coords.y
    }

    // look at the moon
    if (moonCamera && moon?.current) {
      // @ts-ignore
      moonCameraRef.current.lookAt(moon.current.position)
    }

    // calculate surface camera position
    if (surfaceCameraContainerRef.current) {
      const lat = -30
      const lng = 0
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
      </mesh>

      {/* Orbit visualization */}
      {showOrbit && orbitalDistance && orbitalPeriod && (
        <OrbitLabel
          radius={orbitalDistance}
          orbitalPeriod={orbitalPeriod}
          orbitOffset={orbitOffset}
          targetPosition={
            ref && 'current' in ref ? ref.current?.position : undefined
          }
          segments={[
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
          ].reverse()}
        />
      )}
    </group>
  )
})
