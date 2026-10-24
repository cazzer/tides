import { useLoader, useFrame, useThree } from '@react-three/fiber'
import { meshBounds, useTexture } from '@react-three/drei'
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import { realCloudBlend, realClouds, useRealCloudsActive } from './realCloudTextures'
import { pickBlend } from '../cloud-frames'
import { composePatches, useEclipseShadowState } from './eclipseShadow'
import { createCloudLayer, type CloudLayer } from './cloudShaders'
import { groundDetailPatch } from './groundDetail'
import { groundShadowPatch } from './groundShadow'
import { useGibsPatch } from './gibsPatch'
import { nightLightsPatch } from './nightLights'
import { poleSmoothingPatch } from './poleSmoothing'
import { CITY_LIGHTS_COLOR, CITY_LIGHTS_INTENSITY } from '../lighting'
import {
  driftOffset,
  maxTopKm,
  STATIC_DRIFT_PER_FRAME,
  TERRAIN_DISPLACEMENT,
} from '../cloud-layer'
import { isLowQuality } from '../quality'
import { useBodySphere } from '../ship/limb-detail'
import { EarthDemLoader } from './earthDemTexture'
import { earthHorizon } from './earthHorizonTexture'

// Import assets directly
import earthSpecularMapHigh from '../assets/earth-specular.jpg'
import earthSpecularMapLow from '../assets/earth-specular-2k.jpg'
import earthCloudsTextureHigh from '../assets/earth-clouds.jpg'
import earthCloudsTextureLow from '../assets/earth-clouds-2k.jpg'
import earthNightTextureHigh from '../assets/earth-night.jpg'
import earthNightTextureLow from '../assets/earth-night-2k.jpg'
import earthDemHigh from '../assets/earth-dem-4k.bin?url'
import earthDemLow from '../assets/earth-dem-2k.bin?url'
import earthHorizonUrl from '../assets/earth-horizon-1k.bin?url'

interface EarthRendererProps {
  diameter: number
  texture: string
}

export default function EarthRenderer({
  diameter,
  texture,
}: EarthRendererProps) {
  const textureSet = getEarthTextureSet(texture)

  useTexture.preload(textureSet.specular)
  useTexture.preload(textureSet.clouds)
  useTexture.preload(textureSet.night)
  useLoader.preload(EarthDemLoader, textureSet.dem)

  const cloudRef = useRef<THREE.Mesh>(null)
  const groundRef = useRef<THREE.Mesh>(null)
  const drift = useRef(0)

  // Load textures using imported paths
  const earthTexture = useLoader(THREE.TextureLoader, texture)
  const specularMap = useLoader(THREE.TextureLoader, textureSet.specular)
  const cloudsTexture = useLoader(THREE.TextureLoader, textureSet.clouds)
  const nightTexture = useLoader(THREE.TextureLoader, textureSet.night)
  const demTexture = useLoader(EarthDemLoader, textureSet.dem)
  const gl = useThree((s) => s.gl)
  prepareMaps(
    gl.capabilities.getMaxAnisotropy(),
    [earthTexture, nightTexture, cloudsTexture],
    [specularMap, demTexture]
  )
  const real = useStore((s) => s.weatherSource) === 'real'
  useRealCloudsActive(real)
  // A lost context comes back with blank render targets, and nothing redraws
  // them while paused.
  useEffect(() => {
    const canvas = gl.domElement
    const restart = () => realCloudBlend.release()
    canvas.addEventListener('webglcontextrestored', restart)
    return () => canvas.removeEventListener('webglcontextrestored', restart)
  }, [gl])
  // The Moon's shadow during solar eclipses, on the ground and the clouds.
  const eclipseShadow = useEclipseShadowState('earth')
  // Clouds with relief, and their shadows on the ground (tides-y2e).
  const clouds = useMemo(
    () => createCloudLayer(eclipseShadow, textureSet.low),
    [eclipseShadow, textureSet.low]
  )
  useEffect(() => () => clouds.dispose(), [clouds])
  const scene = useThree((s) => s.scene)
  useEffect(() => cloudsFaceEachCamera(scene, clouds, cloudRef), [scene, clouds])
  // Both limbs show from the ship's stop, the cloud shell's the nearer.
  const groundSphere = useBodySphere('earth', diameter, [128, 128])
  const cloudSphere = useBodySphere('earth', diameter + clouds.shellAltitude, [96, 64])
  // Real imagery under the ship (tides-01v.7).
  const gibsPatch = useGibsPatch(groundRef, diameter)
  const groundPatch = useMemo(
    () =>
      composePatches(
        eclipseShadow.material,
        clouds.groundPatch,
        nightLightsPatch(clouds.uniforms.uSunDir),
        poleSmoothingPatch(),
        groundDetailPatch(textureSet.low),
        groundShadowPatch(clouds.uniforms.uSunDir, earthHorizon(earthHorizonUrl)),
        gibsPatch
      ),
    [eclipseShadow, clouds, textureSet.low, gibsPatch]
  )
  // The ground's program holds the patch's uniforms; a new patch (Fast
  // Refresh re-runs the memos) needs a new program.
  const groundMaterial = useRef<THREE.MeshPhongMaterial>(null)
  useLayoutEffect(() => {
    if (groundMaterial.current) groundMaterial.current.needsUpdate = true
  }, [groundPatch])
  // The static clouds, and with Real weather until the frame loop has a blend
  // to show, so the first frame isn't missing its map.
  if (!real || !clouds.uniforms.uCloudMap.value) setCloudMap(clouds, cloudsTexture, false)
  clouds.uniforms.uTerrainMap.value = demTexture
  clouds.uniforms.uSeaLevel.value = diameter

  // The static clouds drift east, slower than the Earth turns; the shader
  // offsets the texture rather than turning the mesh, so the ground's shadows
  // drift with them.
  useFrame(({ clock, gl }) => {
    if (!real) {
      drift.current += STATIC_DRIFT_PER_FRAME
      clouds.uniforms.uCloudShift.value = driftOffset(drift.current)
      return
    }
    // Real clouds sit on the geography they were photographed over.
    clouds.uniforms.uCloudShift.value = 0
    const { timestamp, jumpDate, timeScale } = useStore.getState()
    if (timestamp == null) return
    // Every View runs this; the shared clock keeps the second and third calls
    // in a frame no-ops.
    const wallMs = clock.elapsedTime * 1000
    const jumpToMs = jumpDate?.getTime() ?? null
    realClouds.tick(timestamp, jumpToMs, timeScale, wallMs, Date.now(), textureSet.clouds)
    const pick = pickBlend(realClouds.getSnapshot().frames, jumpToMs ?? timestamp)
    const texture = (t: THREE.Texture | 'static') => (t === 'static' ? cloudsTexture : t)
    const out = realCloudBlend.update(
      gl,
      pick && { a: texture(pick.a), b: texture(pick.b), mix: pick.mix },
      cloudsTexture,
      wallMs
    )
    setCloudMap(clouds, out?.texture ?? cloudsTexture, out?.measured ?? false)
  })

  return (
    <group>
      {/* Land with topology - main Earth surface */}
      <mesh
        ref={groundRef}
        geometry={groundSphere}
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
        <meshPhongMaterial
          ref={groundMaterial}
          {...groundPatch}
          map={earthTexture}
          specularMap={specularMap}
          // specular="#aaddff"
          emissiveMap={nightTexture}
          emissive={CITY_LIGHTS_COLOR}
          emissiveIntensity={CITY_LIGHTS_INTENSITY}
          shininess={100}
          displacementMap={demTexture}
          displacementScale={TERRAIN_DISPLACEMENT}
        />
      </mesh>

      {/* Clouds: a shell over the highest ground and cloud tops. The cloud
          texture is a uniform, never a material map: R3F would tag it sRGB. */}
      <mesh
        ref={cloudRef}
        geometry={cloudSphere}
        raycast={meshBounds}
        material={clouds.material}
      />

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

// The cloud shell picks its faces and draw order for each camera before
// three sorts the scene (CloudLayer.faceCamera). Outside the component: the
// react-hooks lint rejects mutating the scene from useThree in place.
// Returns the cleanup.
function cloudsFaceEachCamera(
  scene: THREE.Scene,
  clouds: CloudLayer,
  cloudRef: RefObject<THREE.Mesh | null>
) {
  const previous = scene.onBeforeRender
  scene.onBeforeRender = function (renderer, renderScene, camera, target) {
    previous.call(this, renderer, renderScene, camera, target)
    if (cloudRef.current) clouds.faceCamera(cloudRef.current, camera)
  }
  return () => {
    scene.onBeforeRender = previous
  }
}

/** Only geostationary imagery carries cloud-top heights (R) and their
 * confidence (B); the static and daily textures are grey. */
function setCloudMap(clouds: CloudLayer, map: THREE.Texture, measured: boolean) {
  clouds.uniforms.uCloudMap.value = map
  clouds.uniforms.uCloudMeasured.value = measured ? 1 : 0
  clouds.uniforms.uCloudMaxKm.value = maxTopKm(measured)
}

/**
 * Sets what three reads at a map's first upload (tides-01v.1): the full
 * anisotropy, which grazing views of the ground need, and one channel for
 * the grey data maps (the specular mask and the elevation map), a quarter of the
 * VRAM. The material and the cloud shader read their red channel.
 */
function prepareMaps(anisotropy: number, colour: THREE.Texture[], grey: THREE.Texture[]) {
  for (const map of colour) map.anisotropy = anisotropy
  for (const map of grey) {
    map.anisotropy = anisotropy
    map.format = THREE.RedFormat
  }
}

const _position = new THREE.Vector3()
const _quaternion = new THREE.Quaternion()
const _scale = new THREE.Vector3()

function getEarthTextureSet(baseTexture: string) {
  if (!isLowQuality()) {
    return {
      day: baseTexture,
      specular: earthSpecularMapHigh,
      clouds: earthCloudsTextureHigh,
      night: earthNightTextureHigh,
      dem: earthDemHigh,
      low: false,
    }
  }

  return {
    day: baseTexture,
    specular: earthSpecularMapLow,
    clouds: earthCloudsTextureLow,
    night: earthNightTextureLow,
    dem: earthDemLow,
    low: true,
  }
}
