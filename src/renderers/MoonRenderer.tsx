import { useLoader } from '@react-three/fiber'
import { meshBounds, useTexture } from '@react-three/drei'
import * as THREE from 'three'
import { useEclipseShadow } from './eclipseShadow'
import { MOON_ALBEDO } from '../lighting'
import { useBodySphere } from '../ship/limb-detail'

const MOON_COLOR = new THREE.Color().setScalar(MOON_ALBEDO)

interface MoonRendererProps {
  diameter: number
  texture: string
}

export default function MoonRenderer({ diameter, texture }: MoonRendererProps) {
  useTexture.preload(texture)
  const threeTexture = useLoader(THREE.TextureLoader, texture)
  // Earth's shadow during lunar eclipses.
  const eclipseShadow = useEclipseShadow('moon')
  const geometry = useBodySphere('moon', diameter, [128, 128])

  return (
    <mesh
      geometry={geometry}
      raycast={meshBounds}
    >
      <meshPhongMaterial
        {...eclipseShadow}
        attach="material"
        map={threeTexture}
        color={MOON_COLOR}
        shininess={5}
      />
    </mesh>
  )
}
