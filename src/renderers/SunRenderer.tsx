import { useRef } from 'react'
import { useFrame, useLoader } from '@react-three/fiber'
import * as THREE from 'three'
import noiseVertex from '../shaders/sun-noise/vertex.glsl'
import noiseFragment from '../shaders/sun-noise/fragment.frag'
import sunVertex from '../shaders/sun/vertex.glsl'
import sunFragment from '../shaders/sun/fragment.frag'
import { CubeCamera } from '@react-three/drei'

// https://www.youtube.com/watch?v=3krH52AhPqk

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
  const sunRef = useRef<THREE.Mesh>(null)
  // const materialRef = useRef<SunMaterial>(null)
  // const threeTexture = useLoader(THREE.TextureLoader, texture)
  const noiseMaterial = new THREE.ShaderMaterial({
    vertexShader: noiseVertex,
    fragmentShader: noiseFragment,
    uniforms: {
      time: { value: 0 },
    },
  })

  // Update the shader time uniform for animation
  useFrame((state) => {
    if (noiseMaterial) {
      noiseMaterial.uniforms.time.value = state.clock.elapsedTime
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

      {/* Sun sphere with custom shader material */}
      <mesh ref={sunRef}>
        <sphereGeometry args={[diameter, 128, 128]} />
        <primitive
          object={noiseMaterial}
          attach="material"
        />
      </mesh>
    </>
  )
}
