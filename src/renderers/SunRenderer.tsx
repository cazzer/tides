import { useRef, useMemo } from 'react'
import { useFrame, useLoader } from '@react-three/fiber'
import * as THREE from 'three'
import noiseVertex from '../shaders/sun-noise/vertex.glsl'
import noiseFragment from '../shaders/sun-noise/fragment.frag'
import sunVertex from '../shaders/sun/vertex.glsl'
import sunFragment from '../shaders/sun/fragment.frag'
import haloVertex from '../shaders/sun-halo/vertex.glsl'
import haloFragment from '../shaders/sun-halo/fragment.frag'
import { CubeCamera, useCubeCamera } from '@react-three/drei'

// https://www.youtube.com/watch?v=3krH52AhPqk
// ended at 1:04:24

const REFLECTION_LAYER = 1

interface SunRendererProps {
  diameter: number
  intensity?: number
  decay?: number
}

export default function SunRenderer({
  diameter,
  intensity = 1400,
  decay = 1.1,
}: SunRendererProps) {
  const noiseRef = useRef<THREE.Mesh>(null)
  const sunRef = useRef<THREE.Mesh>(null)
  const noiseMaterial = new THREE.ShaderMaterial({
    vertexShader: noiseVertex,
    fragmentShader: noiseFragment,
    side: THREE.DoubleSide,
    uniforms: {
      time: { value: 0 },
    },
  })
  const sunMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        uPerlin: { value: null },
        cameraPosition: { value: new THREE.Vector3() },
        objectCenter: { value: new THREE.Vector3() }, // Sun's world position
      },
      vertexShader: sunVertex,
      fragmentShader: sunFragment,
    })
  }, [])
  const sunHaloMaterial = new THREE.ShaderMaterial({
    vertexShader: haloVertex,
    fragmentShader: haloFragment,
    side: THREE.BackSide,
    transparent: true,
    uniforms: {
      time: { value: 0 },
      uPerlin: { value: null },
    },
  })

  // Update the shader time uniform for animation
  useFrame((state) => {
    if (noiseMaterial) {
      noiseMaterial.uniforms.time.value = state.clock.elapsedTime
    }
    if (sunMaterial) {
      sunMaterial.uniforms.time.value = state.clock.elapsedTime
      sunMaterial.uniforms.cameraPosition.value.copy(state.camera.position)
      sunMaterial.uniforms.objectCenter.value.copy(sunRef.current.position)
    }
  })

  return (
    <>
      {/* Point light for illuminating other objects */}
      <pointLight
        position={[0, 0, 0]}
        decay={decay}
        intensity={intensity}
      />
      <CubeCamera
        position={[0, 0, 0]}
        resolution={256}
        frames={Infinity}
        near={0.5}
        far={1000}
        onUpdate={(cubeCamera) => {
          cubeCamera.children.forEach((child) =>
            child.layers.set(REFLECTION_LAYER)
          )
        }}
      >
        {(texture) => {
          sunMaterial.uniforms.uPerlin.value = texture
          return (
            <>
              <mesh
                ref={sunRef}
                position={[0, 0, 0]}
              >
                <sphereGeometry args={[diameter + 4, 128, 128]} />
                <primitive
                  object={sunHaloMaterial}
                  attach="material"
                />
              </mesh>
              <mesh
                ref={sunRef}
                position={[0, 0, 0]}
              >
                <sphereGeometry args={[diameter, 128, 128]} />
                <primitive
                  object={sunMaterial}
                  attach="material"
                />
              </mesh>
            </>
          )
        }}
      </CubeCamera>
      {/* Noise sphere - only visible to CubeCamera */}
      <mesh
        ref={noiseRef}
        position={[0, 0, 0]}
        layers={REFLECTION_LAYER}
      >
        <sphereGeometry args={[diameter + 10, 128, 128]} />
        <primitive
          object={noiseMaterial}
          attach="material"
        />
      </mesh>
    </>
  )
}
