import { useLoader } from '@react-three/fiber'
import * as THREE from 'three'

interface MoonRendererProps {
  diameter: number
  texture: string
}

export default function MoonRenderer({ diameter, texture }: MoonRendererProps) {
  const threeTexture = useLoader(THREE.TextureLoader, texture)

  return (
    <>
      <sphereGeometry args={[diameter, 128, 128]} />
      <meshPhongMaterial
        attach="material"
        map={threeTexture}
        shininess={5}
      />
    </>
  )
}
