import { useRef } from 'react'
import { useFrame, useLoader } from '@react-three/fiber'
import * as THREE from 'three'
import noiseVertex from '../shaders/sun-noise/vertex.glsl'
import noiseFragment from '../shaders/sun-noise/fragment.frag'
import sunVertex from '../shaders/sun/vertex.glsl'
import sunFragment from '../shaders/sun/fragment.frag'
import { CubeCamera, useCubeCamera } from '@react-three/drei'

// https://www.youtube.com/watch?v=3krH52AhPqk

const REFLECTION_LAYER = 1

interface SunRendererProps {
  diameter: number
  texture: string
  intensity?: number
  decay?: number
}

export default function SunRenderer({
  diameter,
  texture,
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
  const sunMaterial = new THREE.ShaderMaterial({
    vertexShader: sunVertex,
    fragmentShader: sunFragment,
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
