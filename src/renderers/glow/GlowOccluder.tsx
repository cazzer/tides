import { useRef } from 'react'
import * as THREE from 'three'
import { GLOW_LAYER } from './glow'
import { GLOW_ORDER, useGlowOn, useGlowSource } from './glowSources'

const black = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false })

/**
 * A black globe in the glow layer (tides-64u.3), so a body in front of a
 * glowing source (the Moon over Earth's lights, a planet across the Sun)
 * hides the glow behind it as it hides the source. Takes the body's own
 * sphere, limb detail and all, so no glow shows past its limb up close.
 * Mount in the body's frame.
 */
export function GlowOccluder({ geometry }: { geometry: THREE.BufferGeometry }) {
  return useGlowOn() ? <GlowOccluderOn geometry={geometry} /> : null
}

function GlowOccluderOn({ geometry }: { geometry: THREE.BufferGeometry }) {
  const mesh = useRef<THREE.Mesh>(null)
  useGlowSource(mesh, GLOW_ORDER.opaque, false)
  return (
    <mesh
      ref={mesh}
      layers={GLOW_LAYER}
      geometry={geometry}
      material={black}
      raycast={() => null}
    />
  )
}
