import { useLoader } from '@react-three/fiber'
import { meshBounds, useTexture } from '@react-three/drei'
import * as THREE from 'three'
import { useEclipseShadow } from './eclipseShadow'

interface MoonRendererProps {
  diameter: number
  texture: string
}

export default function MoonRenderer({ diameter, texture }: MoonRendererProps) {
  useTexture.preload(texture)
  const threeTexture = useLoader(THREE.TextureLoader, texture)
  // Earth's shadow during lunar eclipses.
  const eclipseShadow = useEclipseShadow('moon')

  return (
    <mesh raycast={meshBounds}>
      <sphereGeometry args={[diameter, 128, 128]} />
      <meshPhongMaterial
        {...eclipseShadow}
        attach="material"
        map={threeTexture}
        shininess={5}
      />
    </mesh>
  )
}
