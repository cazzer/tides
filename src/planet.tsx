import { useRef, forwardRef, useEffect } from 'react'
import { useFrame, useLoader, useThree } from '@react-three/fiber'
import { MeshWobbleMaterial, PerspectiveCamera } from '@react-three/drei'
import * as THREE from 'three'
import {
  calculateOrbitPosition,
  calculateRotation,
  degreesToRadians,
} from './utils'
import { useCamera } from './camera'
import { useStore } from './store'
import { OrbitLabel } from './orbit-label'

export default forwardRef(function Planet(
  {
    initialPosition,
    texture,
    orbitalDistance,
    diameter,
    rotationPeriod,
    rotationSpeed,
    orbitalInclination,
    orbitalPeriod,
    axialTilt = 0,
    emitLight = false,
    surfaceCamera = false,
    moonCamera = false,
    interactive = false,
    storeLabel,
    showOrbit = false,
    parent,
  }: {
    initialPosition: any
    diameter: number
    texture: string
    orbitalDistance?: number
    rotationPeriod: number
    rotationSpeed?: number
    orbitalInclination?: number
    orbitalPeriod?: number
    axialTilt: number
    emitLight?: boolean
    surfaceCamera?: boolean
    moonCamera?: boolean
    interactive?: boolean
    storeLabel?: string
    showOrbit?: boolean
    parent?: any
  },
  ref
) {
  const { handleFocus } = useCamera()
  const surfaceCameraRef = useRef()
  const moonCameraRef = useRef()
  const { get, set } = useThree(({ get, set }) => ({ get, set }))
  const { moon, time } = useStore()
  useEffect(() => {
    if (surfaceCamera) {
      set({ camera: surfaceCameraRef.current })
    }

    if (moonCamera && moon?.current) {
      moonCameraRef.current.lookAt(moon.current.position)
      set({ camera: moonCameraRef.current })
    }
  }, [moon])
  useFrame((state) => {
    const rotation = calculateRotation(
      rotationPeriod,
      state.timestamp || Date.now(),
      0
    )

    ref.current.rotation.y = rotation

    if (orbitalDistance) {
      const coords = calculateOrbitPosition({
        radius: orbitalDistance,
        period: orbitalPeriod as number,
        time: state.timestamp || Date.now(),
        centerX: parent?.current?.position.x || 0,
        centerZ: parent?.current?.position.z || 0,
        centerY: 0,
        inclination: orbitalInclination as number,
      })
      ref.current.position.x = coords.x
      ref.current.position.z = coords.z
      ref.current.position.y = coords.y
    }

    if (moonCamera && moon?.current) {
      moonCameraRef.current.lookAt(moon.current.position)
    }
  })
  const threeTexture = useLoader(THREE.TextureLoader, texture)

  const onClick = (event) => {
    if (interactive) {
      handleFocus(event)
    }
  }

  return (
    <group>
      <mesh
        castShadow
        receiveShadow
        position={initialPosition}
        rotation={[degreesToRadians(axialTilt), 0, 0]}
        onClick={onClick}
        ref={ref}
      >
        <PerspectiveCamera
          position={[0, 0, 0]}
          rotation={[0, Math.PI / 2, Math.PI]}
          zoom={1}
          ref={surfaceCameraRef}
        />
        <PerspectiveCamera position={[0, 0, 0]} zoom={1} ref={moonCameraRef} />
        <sphereGeometry args={[diameter, 128, 128]} />

        {emitLight ? (
          <>
            <pointLight
              position={initialPosition}
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
          rotationalPeriod={rotationPeriod}
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
