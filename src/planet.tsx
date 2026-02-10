import { useRef, forwardRef, useEffect } from 'react'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import { MeshWobbleMaterial, PerspectiveCamera } from '@react-three/drei'
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

export default forwardRef(function Planet(
  {
    texture,
    orbitalDistance,
    diameter,
    rotationPeriod,
    orbitalInclination,
    orbitalPeriod,
    axialTilt = 0,
    emitLight = false,
    surfaceCamera = false,
    moonCamera = false,
    interactive = false,
    storeLabel,
    showOrbit = false,
    orbitOffset = 0,
    rotationOffset = 0,
    parent,
  }: {
    diameter: number
    texture: string
    orbitalDistance?: number
    rotationPeriod: number
    orbitalInclination?: number
    orbitalPeriod?: number
    axialTilt?: number
    emitLight?: boolean
    surfaceCamera?: boolean
    moonCamera?: boolean
    interactive?: boolean
    storeLabel?: string
    showOrbit?: boolean
    orbitOffset?: number
    rotationOffset?: number
    parent?: { current: THREE.Mesh }
  },
  ref: { current: THREE.Mesh }
) {
  const { handleFocus } = useCamera()
  const surfaceCameraRef = useRef<any>(null)
  const moonCameraRef = useRef<any>(null)
  const surfaceCameraContainerRef = useRef<THREE.Mesh>(null)
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
    // calculate planet position
    const rotation = calculateRotation(
      rotationPeriod,
      // @ts-ignore
      state.timestamp || Date.now(),
      rotationOffset
    )

    ref.current.rotation.y = rotation

    if (orbitalDistance) {
      const coords = calculateOrbitPosition({
        radius: orbitalDistance,
        period: orbitalPeriod as number,
        // @ts-ignore
        time: state.timestamp || Date.now(),
        centerX: parent?.current.position.x || 0,
        centerZ: parent?.current.position.z || 0,
        centerY: 0,
        inclination: orbitalInclination as number,
        orbitOffset,
      })

      if (ref.current) {
        ref.current.position.x = coords.x
        ref.current.position.z = coords.z
        ref.current.position.y = coords.y
      }
    }

    // look at the moon
    if (moonCamera && moon?.current) {
      // @ts-ignore
      moonCameraRef.current.lookAt(moon.current.position)
    }

    // calculate surface camera position
    if (surfaceCameraContainerRef.current) {
      const { position, rotation } = calculateLocationAndRotationForLatLng(
        -30, //40.7225378,
        0, //-73.954713,
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
  const threeTexture = useLoader(THREE.TextureLoader, texture)

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
        {storeLabel == 'earth' && (
          <mesh
            position={[0, 0, -diameter]}
            rotation={[0, 0, Math.PI]}
            ref={surfaceCameraContainerRef}
            onPointerDown={onCameraClick}
          >
            {/* Camera position marker - red pyramid */}
            <mesh
              position={[0, 0, 0]}
              rotation={[-Math.PI / 2, 0, 0]} // Point the pyramid tip outward from Earth's surface
            >
              <coneGeometry args={[0.2, 0.4, 4]} />
              <meshBasicMaterial color="red" />
            </mesh>
            <PerspectiveCamera
              position={[0, 0, 0]}
              rotation={[0, 0, 0]}
              zoom={0.75}
              ref={surfaceCameraRef}
            />
          </mesh>
        )}
        <PerspectiveCamera
          position={[0, 0, 0]}
          zoom={1}
          ref={moonCameraRef}
        />
        <sphereGeometry args={[diameter, 128, 128]} />

        {emitLight ? (
          <>
            <pointLight
              position={[0, 0, 0]}
              decay={1.1}
              intensity={1400}
            />
            <MeshWobbleMaterial
              attach="material"
              map={threeTexture}
              factor={0.01}
              speed={1}
            />
          </>
        ) : (
          <meshPhongMaterial
            attach="material"
            map={threeTexture}
            shininess={5}
          />
        )}
      </mesh>
      {showOrbit && (
        <OrbitLabel
          radius={orbitalDistance}
          orbitalPeriod={orbitalPeriod}
          orbitOffset={orbitOffset}
          targetPosition={ref?.current?.position}
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
