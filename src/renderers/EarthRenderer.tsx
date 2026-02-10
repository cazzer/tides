import { useLoader, useFrame } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import { useRef } from 'react'
import * as THREE from 'three'

// Import assets directly
import earthNormalMapHigh from '../assets/earth-normal.jpg'
import earthNormalMapLow from '../assets/earth-normal-2k.jpg'
import earthSpecularMapHigh from '../assets/earth-specular.jpg'
import earthSpecularMapLow from '../assets/earth-specular-2k.jpg'
import earthCloudsTextureHigh from '../assets/earth-clouds.jpg'
import earthCloudsTextureLow from '../assets/earth-clouds-2k.jpg'
import earthCloudsAlphaHigh from '../assets/earth-clouds-alpha.jpg'
import earthCloudsAlphaLow from '../assets/earth-clouds-alpha-2k.jpg'
import earthNightTextureHigh from '../assets/earth-night.jpg'
import earthNightTextureLow from '../assets/earth-night-2k.jpg'
import earthBumpMapHigh from '../assets/earth-bump.jpg'
import earthBumpMapLow from '../assets/earth-bump-2k.jpg'

interface EarthRendererProps {
  diameter: number
  texture: string
}

export default function EarthRenderer({
  diameter,
  texture,
}: EarthRendererProps) {
  const textureSet = getEarthTextureSet(texture)

  useTexture.preload(textureSet.normal)
  useTexture.preload(textureSet.specular)
  useTexture.preload(textureSet.clouds)
  useTexture.preload(textureSet.cloudsAlpha)
  useTexture.preload(textureSet.night)
  useTexture.preload(textureSet.bump)

  const cloudRef = useRef<THREE.Mesh>(null)
  const atmosphereRef = useRef<THREE.Mesh>(null)

  // Load textures using imported paths
  const earthTexture = useLoader(THREE.TextureLoader, texture)
  const normalMap = useLoader(THREE.TextureLoader, textureSet.normal)
  const specularMap = useLoader(THREE.TextureLoader, textureSet.specular)
  const cloudsTexture = useLoader(THREE.TextureLoader, textureSet.clouds)
  const alphaMap = useLoader(THREE.TextureLoader, textureSet.cloudsAlpha)
  const nightTexture = useLoader(THREE.TextureLoader, textureSet.night)
  const bumpTexture = useLoader(THREE.TextureLoader, textureSet.bump)

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

function getEarthTextureSet(baseTexture: string) {
  if (typeof window === 'undefined') {
    return {
      day: baseTexture,
      normal: earthNormalMapHigh,
      specular: earthSpecularMapHigh,
      clouds: earthCloudsTextureHigh,
      cloudsAlpha: earthCloudsAlphaHigh,
      night: earthNightTextureHigh,
      bump: earthBumpMapHigh,
    }
  }

  const quality = getQualityOverride()
  const isMobile = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent)
  const useLow = quality === 'low' || (quality !== 'high' && isMobile)

  if (!useLow) {
    return {
      day: baseTexture,
      normal: earthNormalMapHigh,
      specular: earthSpecularMapHigh,
      clouds: earthCloudsTextureHigh,
      cloudsAlpha: earthCloudsAlphaHigh,
      night: earthNightTextureHigh,
      bump: earthBumpMapHigh,
    }
  }

  return {
    day: baseTexture,
    normal: earthNormalMapLow,
    specular: earthSpecularMapLow,
    clouds: earthCloudsTextureLow,
    cloudsAlpha: earthCloudsAlphaLow,
    night: earthNightTextureLow,
    bump: earthBumpMapLow,
  }
}

function getQualityOverride() {
  if (typeof window === 'undefined') return null
  const value = new URLSearchParams(window.location.search).get('quality')
  if (value === 'low' || value === 'high') return value
  return null
}
