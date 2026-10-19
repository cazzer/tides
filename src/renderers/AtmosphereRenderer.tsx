// A thin blue limb glow on the sunlit side, warming toward the terminator
// (tides-qe5). Additive, so it only ever brightens the limb.
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useStore } from '../store'
import { sunDirectionLocal } from '../aurora'
import shellVertex from '../shaders/shell/vertex.glsl'
import atmosphereFragment from '../shaders/atmosphere/fragment.frag'

// Fractions of the Earth's radius. The haze starts at the cloud deck and
// thins out with an (exaggerated, for visibility) ~60 km scale height.
const SURFACE = 1.012
const OUTER = 1.06
const SCALE_HEIGHT = 0.0095

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
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    []
  )
  // Uniforms are updated through the mesh, not the memoised material.
  const mesh = useRef<THREE.Mesh>(null)
  const geometry = useMemo(() => new THREE.SphereGeometry(radius * OUTER, 96, 48), [radius])

  useEffect(() => () => material.dispose(), [material])
  useEffect(() => () => geometry.dispose(), [geometry])

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
