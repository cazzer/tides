// A thin blue limb glow on the sunlit side, warming toward the terminator
// (tides-qe5). Additive, so it only ever brightens the limb.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '../store'
import { sunDirectionLocal } from '../aurora'
import shellVertex from '../shaders/shell/vertex.glsl'
import atmosphereFragment from '../shaders/atmosphere/fragment.frag'
import {
  ATMOSPHERE_DUSK,
  ATMOSPHERE_GAIN,
  ATMOSPHERE_OUTER,
  ATMOSPHERE_RENDER_ORDER,
  ATMOSPHERE_SCALE_HEIGHT,
  ATMOSPHERE_SKY,
  ATMOSPHERE_SURFACE,
  pickShellFaces,
} from './earth-shells'
import { useBodySphere } from '../ship/limb-detail'

// Fractions of the Earth's radius. The haze starts at the cloud deck and
// thins out with an (exaggerated, for visibility) ~60 km scale height.
const SURFACE = ATMOSPHERE_SURFACE
const OUTER = ATMOSPHERE_OUTER
const SCALE_HEIGHT = ATMOSPHERE_SCALE_HEIGHT
// Linear RGB: blue overhead, reddening toward the terminator.
const SKY = new THREE.Vector3(...ATMOSPHERE_SKY)
const DUSK = new THREE.Vector3(...ATMOSPHERE_DUSK)

const noRaycast = () => null

export default function AtmosphereRenderer({ radius }: { radius: number }) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: shellVertex,
        fragmentShader: atmosphereFragment,
        uniforms: {
          uSurface: { value: 0 },
          uOuter: { value: 0 },
          uScaleHeight: { value: 0 },
          uSeaLevel: { value: 0 },
          uSun: { value: new THREE.Vector3(1, 0, 0) },
          uGain: { value: ATMOSPHERE_GAIN },
          uSky: { value: SKY },
          uDusk: { value: DUSK },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        // Double-sided in ship mode (pickShellFaces), where the shader keeps
        // one face per ray.
        forceSinglePass: true,
      }),
    []
  )
  // Uniforms are updated through the mesh, not the memoised material.
  const mesh = useRef<THREE.Mesh>(null)
  // The glow is faint but not zero at its outer edge, so from the ship's stop
  // a coarse shell shows as facets there.
  const geometry = useBodySphere('earth', radius * OUTER, [96, 48])

  useEffect(() => () => material.dispose(), [material])

  useFrame(() => {
    const { timestamp } = useStore.getState()
    const shader = mesh.current?.material as THREE.ShaderMaterial | undefined
    if (timestamp == null || !shader) return
    const u = shader.uniforms
    u.uSurface.value = radius * SURFACE
    u.uOuter.value = radius * OUTER
    u.uScaleHeight.value = radius * SCALE_HEIGHT
    u.uSeaLevel.value = radius
    sunDirectionLocal(timestamp, u.uSun.value)
  })

  return (
    <mesh
      ref={mesh}
      geometry={geometry}
      material={material}
      renderOrder={ATMOSPHERE_RENDER_ORDER}
      raycast={noRaycast}
      onBeforeRender={(_renderer, _scene, camera, _geometry, shader) =>
        pickShellFaces(mesh.current!, shader, camera)
      }
    />
  )
}
