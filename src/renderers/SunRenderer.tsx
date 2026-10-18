import { useRef, useMemo, useEffect } from 'react'
import { useFrame, useLoader } from '@react-three/fiber'
import * as THREE from 'three'
import noiseVertex from '../shaders/sun-noise/vertex.glsl'
import noiseFragment from '../shaders/sun-noise/fragment.frag'
import sunVertex from '../shaders/sun/vertex.glsl'
import sunFragment from '../shaders/sun/fragment.frag'
import haloVertex from '../shaders/sun-halo/vertex.glsl'
import haloFragment from '../shaders/sun-halo/fragment.frag'
import { CubeCamera, meshBounds } from '@react-three/drei'

// https://www.youtube.com/watch?v=3krH52AhPqk
// ended at 1:04:24

const REFLECTION_LAYER = 1

interface SunRendererProps {
  diameter: number
}

export default function SunRenderer({ diameter }: SunRendererProps) {
  const noiseRef = useRef<THREE.Mesh>(null)
  const sunRef = useRef<THREE.Mesh>(null)
  const noiseMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      vertexShader: noiseVertex,
      fragmentShader: noiseFragment,
      side: THREE.DoubleSide,
      uniforms: {
        time: { value: 0 },
      },
    })
  }, [])
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
  const sunHaloMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      vertexShader: haloVertex,
      fragmentShader: haloFragment,
      side: THREE.BackSide,
      transparent: true,
      // A glow, not a surface: writing depth would hide labels behind it.
      depthWrite: false,
      uniforms: {
        time: { value: 0 },
        uPerlin: { value: null },
      },
    })
  }, [])

  useEffect(() => {
    return () => {
      noiseMaterial.dispose()
      sunMaterial.dispose()
      sunHaloMaterial.dispose()
    }
  }, [noiseMaterial, sunMaterial, sunHaloMaterial])

  // Update the shader time uniform for animation
  useFrame((state) => {
    noiseMaterial.uniforms.time.value = state.clock.elapsedTime
    sunMaterial.uniforms.time.value = state.clock.elapsedTime
    sunMaterial.uniforms.cameraPosition.value.copy(state.camera.position)
    if (sunRef.current) {
      sunMaterial.uniforms.objectCenter.value.copy(sunRef.current.position)
    }
  })

  return (
    <>
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
                position={[0, 0, 0]}
                raycast={meshBounds}
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
                raycast={meshBounds}
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
