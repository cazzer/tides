import { useLoader } from '@react-three/fiber'
import { meshBounds, useTexture } from '@react-three/drei'
import * as THREE from 'three'

interface MoonRendererProps {
  diameter: number
  texture: string
}

export default function MoonRenderer({ diameter, texture }: MoonRendererProps) {
  useTexture.preload(texture)
  const threeTexture = useLoader(THREE.TextureLoader, texture)

  return (
    <mesh raycast={meshBounds}>
      <sphereGeometry args={[diameter, 128, 128]} />
      <meshPhongMaterial
        attach="material"
        map={threeTexture}
        shininess={5}
      />
    </mesh>
  )
}
