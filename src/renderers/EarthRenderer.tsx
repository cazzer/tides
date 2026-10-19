import { useLoader, useFrame } from '@react-three/fiber'
import { meshBounds, useTexture } from '@react-three/drei'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import { realClouds, useRealClouds } from './realCloudTextures'
import { composePatches, useEclipseShadowState } from './eclipseShadow'
import { createCloudLayer } from './cloudShaders'
import {
  driftOffset,
  maxTopKm,
  STATIC_DRIFT_PER_FRAME,
  TERRAIN_DISPLACEMENT,
} from '../cloud-layer'

// Import assets directly
import earthNormalMapHigh from '../assets/earth-normal.jpg'
import earthNormalMapLow from '../assets/earth-normal-2k.jpg'
import earthSpecularMapHigh from '../assets/earth-specular.jpg'
import earthSpecularMapLow from '../assets/earth-specular-2k.jpg'
import earthCloudsTextureHigh from '../assets/earth-clouds.jpg'
import earthCloudsTextureLow from '../assets/earth-clouds-2k.jpg'
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
  useTexture.preload(textureSet.night)
  useTexture.preload(textureSet.bump)

  const cloudRef = useRef<THREE.Mesh>(null)
  const drift = useRef(0)

  // Load textures using imported paths
  const earthTexture = useLoader(THREE.TextureLoader, texture)
  const normalMap = useLoader(THREE.TextureLoader, textureSet.normal)
  const specularMap = useLoader(THREE.TextureLoader, textureSet.specular)
  const cloudsTexture = useLoader(THREE.TextureLoader, textureSet.clouds)
  const nightTexture = useLoader(THREE.TextureLoader, textureSet.night)
  const bumpTexture = useLoader(THREE.TextureLoader, textureSet.bump)
  const real = useStore((s) => s.weatherSource) === 'real'
  const { texture: realCloudsTexture } = useRealClouds(real)
  // The Moon's shadow during solar eclipses, on the ground and the clouds.
  const eclipseShadow = useEclipseShadowState('earth')
  // Clouds with relief, and their shadows on the ground (tides-y2e).
  const clouds = useMemo(
    () => createCloudLayer(eclipseShadow, textureSet.low),
    [eclipseShadow, textureSet.low]
  )
  useEffect(() => () => clouds.dispose(), [clouds])
  const groundPatch = useMemo(
    () => composePatches(eclipseShadow.material, clouds.groundPatch),
    [eclipseShadow, clouds]
  )
  // The ground's program holds the patch's uniforms; a new patch (Fast
  // Refresh re-runs the memos) needs a new program.
  const groundMaterial = useRef<THREE.MeshPhongMaterial>(null)
  useLayoutEffect(() => {
    if (groundMaterial.current) groundMaterial.current.needsUpdate = true
  }, [groundPatch])
  const cloudMap = real && realCloudsTexture ? realCloudsTexture : cloudsTexture
  clouds.uniforms.uCloudMap.value = cloudMap
  // Only geostationary textures carry cloud-top heights (R) and their
  // confidence (B); the static and daily textures are grey.
  const measured = Boolean(cloudMap.userData.geo)
  clouds.uniforms.uCloudMeasured.value = measured ? 1 : 0
  clouds.uniforms.uCloudMaxKm.value = maxTopKm(measured)
  clouds.uniforms.uTerrainMap.value = bumpTexture
  clouds.uniforms.uSeaLevel.value = diameter

  // TODO: Add GeoTIFF loader for displacement mapping
  // const displacementMap = useLoader(GeoTIFFLoader, '/assets/earth-elevation.tif')

  // The static clouds drift east, slower than the Earth turns; the shader
  // offsets the texture rather than turning the mesh, so the ground's shadows
  // drift with them.
  useFrame(() => {
    if (!real) {
      drift.current += STATIC_DRIFT_PER_FRAME
      clouds.uniforms.uCloudShift.value = driftOffset(drift.current)
      return
    }
    // Real clouds sit on the geography they were photographed over.
    clouds.uniforms.uCloudShift.value = 0
    const { timestamp, jumpDate } = useStore.getState()
    if (timestamp == null) return
    realClouds.tick(
      timestamp,
      jumpDate?.getTime() ?? null,
      performance.now(),
      Date.now(),
      textureSet.clouds
    )
  })

  return (
    <group>
      {/* Land with topology - main Earth surface */}
      <mesh
        raycast={meshBounds}
        onBeforeRender={() => {
          // The Sun in the Earth's frame, from this frame's final transform
          // (the ground renders before the transparent clouds). The Sun is
          // the scene's origin, as for the directional light (sunlight.ts).
          const mesh = cloudRef.current?.parent
          if (!mesh) return
          mesh.matrixWorld.decompose(_position, _quaternion, _scale)
          clouds.uniforms.uSunDir.value
            .copy(_position)
            .negate()
            .normalize()
            .applyQuaternion(_quaternion.invert())
        }}
      >
        <sphereGeometry args={[diameter, 128, 128]} />
        <meshPhongMaterial
          ref={groundMaterial}
          {...groundPatch}
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
          displacementScale={TERRAIN_DISPLACEMENT}
        />
      </mesh>

      {/* Clouds: a shell over the highest ground and cloud tops. The cloud
          texture is a uniform, never a material map: R3F would tag it sRGB. */}
      <mesh
        ref={cloudRef}
        raycast={meshBounds}
        material={clouds.material}
      >
        <sphereGeometry args={[diameter + clouds.shellAltitude, 96, 64]} />
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

const _position = new THREE.Vector3()
const _quaternion = new THREE.Quaternion()
const _scale = new THREE.Vector3()

function getEarthTextureSet(baseTexture: string) {
  if (typeof window === 'undefined') {
    return {
      day: baseTexture,
      normal: earthNormalMapHigh,
      specular: earthSpecularMapHigh,
      clouds: earthCloudsTextureHigh,
      night: earthNightTextureHigh,
      bump: earthBumpMapHigh,
      low: false,
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
      night: earthNightTextureHigh,
      bump: earthBumpMapHigh,
      low: false,
    }
  }

  return {
    day: baseTexture,
    normal: earthNormalMapLow,
    specular: earthSpecularMapLow,
    clouds: earthCloudsTextureLow,
    night: earthNightTextureLow,
    bump: earthBumpMapLow,
    low: true,
  }
}

function getQualityOverride() {
  if (typeof window === 'undefined') return null
  const value = new URLSearchParams(window.location.search).get('quality')
  if (value === 'low' || value === 'high') return value
  return null
}
