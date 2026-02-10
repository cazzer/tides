import { useLoader, useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import * as THREE from 'three'

// Import assets directly
import earthNormalMap from '../assets/earth-normal.jpg'
import earthSpecularMap from '../assets/earth-specular.jpg'
import earthCloudsTexture from '../assets/earth-clouds.jpg'
import earthCloudsAlpha from '../assets/earth-clouds-alpha.jpg'
import earthNightTexture from '../assets/earth-night.jpg'
import earthBumpMap from '../assets/earth-bump.jpg'

interface EarthRendererProps {
  diameter: number
  texture: string
}

export default function EarthRenderer({
  diameter,
  texture,
}: EarthRendererProps) {
  const cloudRef = useRef<THREE.Mesh>(null)
  const atmosphereRef = useRef<THREE.Mesh>(null)

  // Load textures using imported paths
  const earthTexture = useLoader(THREE.TextureLoader, texture)
  const normalMap = useLoader(THREE.TextureLoader, earthNormalMap)
  const specularMap = useLoader(THREE.TextureLoader, earthSpecularMap)
  const cloudsTexture = useLoader(THREE.TextureLoader, earthCloudsTexture)
  const alphaMap = useLoader(THREE.TextureLoader, earthCloudsAlpha)
  const nightTexture = useLoader(THREE.TextureLoader, earthNightTexture)
  const bumpTexture = useLoader(THREE.TextureLoader, earthBumpMap)

  // TODO: Add GeoTIFF loader for displacement mapping
  // const displacementMap = useLoader(GeoTIFFLoader, '/assets/earth-elevation.tif')

  // Animate clouds rotation
  useFrame((state) => {
    if (cloudRef.current) {
      cloudRef.current.rotation.y += 0.0001 // Slower than Earth rotation
    }
  })

  const radius = diameter / 2
  const normalScale = new THREE.Vector2(1.5, 1.5)

  return (
    <group>
      {/* Land with topology - main Earth surface */}
      <mesh>
        <sphereGeometry args={[diameter, 128, 128]} />
        <meshPhongMaterial
          map={earthTexture}
          // normalMap={normalMap}
          // normalMapType={0}
          // normalScale={normalScale}
          specularMap={specularMap}
          // specular="#aaddff"
          emissiveMap={nightTexture}
          emissive="#ffff88"
          emissiveIntensity={0.5}
          shininess={100}
          displacementMap={bumpTexture}
          displacementScale={0.075}
        />
      </mesh>

      {/* Clouds layer */}
      <mesh ref={cloudRef}>
        <sphereGeometry args={[diameter * 1.02, 64, 64]} />
        <meshLambertMaterial
          map={cloudsTexture}
          alphaMap={alphaMap}
          transparent
          opacity={0.4}
          alphaTest={0.1}
        />
      </mesh>

      {/* Atmosphere glow */}
      {/* <mesh ref={atmosphereRef}>
        <sphereGeometry args={[diameter * 1.08, 32, 32]} />
        <meshBasicMaterial
          color="#88ccff"
          transparent
          opacity={0.1}
          side={THREE.BackSide}
        />
      </mesh> */}
    </group>
  )
}
