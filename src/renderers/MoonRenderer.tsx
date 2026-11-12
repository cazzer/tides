import { useMemo, useRef } from 'react'
import { useLoader } from '@react-three/fiber'
import { meshBounds, useTexture } from '@react-three/drei'
import * as THREE from 'three'
import { composePatches, useEclipseShadow } from './eclipseShadow'
import { moonDetailPatch } from './moonDetail'
import { isLowQuality } from '../quality'
import { MOON_ALBEDO } from '../lighting'
import { useSizedBodySphere } from '../ship/limb-detail'
import { GlowOccluder } from './glow/GlowOccluder'

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
  // Rock detail finer than the map, at close range (tides-ufyr.3).
  const patch = useMemo(
    () => composePatches(eclipseShadow, moonDetailPatch(isLowQuality())),
    [eclipseShadow]
  )
  // Sized to the Moon on this View's screen (tides-0oi.16).
  const meshRef = useRef<THREE.Mesh>(null)
  const geometry = useSizedBodySphere('moon', diameter, [128, 128], 0, meshRef)

  return (
    <>
      <mesh
        ref={meshRef}
        geometry={geometry}
        raycast={meshBounds}
      >
        <meshPhongMaterial
          {...patch}
          attach="material"
          map={threeTexture}
          color={MOON_COLOR}
          shininess={5}
        />
      </mesh>
      {/* Hides the glow behind it, Earth's lights or the Sun (tides-64u.3). */}
      <GlowOccluder geometry={geometry} />
    </>
  )
}
