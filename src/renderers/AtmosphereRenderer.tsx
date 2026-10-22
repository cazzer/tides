// A thin blue limb glow on the sunlit side, warming toward the terminator
// (tides-qe5). Additive, so it only ever brightens the limb.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '../store'
import { sunDirectionLocal } from '../aurora'
import shellVertex from '../shaders/shell/vertex.glsl'
import atmosphereFragment from '../shaders/atmosphere/fragment.frag'
import { ATMOSPHERE_OUTER } from './earth-shells'
import { useBodySphere } from '../ship/limb-detail'

// Fractions of the Earth's radius. The haze starts at the cloud deck and
// thins out with an (exaggerated, for visibility) ~60 km scale height.
const SURFACE = 1.012
const OUTER = ATMOSPHERE_OUTER
const SCALE_HEIGHT = 0.0095
// Linear RGB: blue overhead, reddening toward the terminator.
const SKY = new THREE.Vector3(0.3, 0.55, 1.0)
const DUSK = new THREE.Vector3(1.0, 0.45, 0.2)

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
          uSun: { value: new THREE.Vector3(1, 0, 0) },
          uGain: { value: 1.2 },
          uSky: { value: SKY },
          uDusk: { value: DUSK },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
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
    sunDirectionLocal(timestamp, u.uSun.value)
  })

  return (
    <mesh
      ref={mesh}
      geometry={geometry}
      material={material}
      renderOrder={1}
      raycast={noRaycast}
    />
  )
}
