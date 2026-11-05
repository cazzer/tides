import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { GLOW_LAYER } from './glow'
import { GLOW_ORDER, glowOn, useGlowSource } from './glowSources'

const black = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false })

/**
 * A black sphere in the glow layer (tides-64u.3), so a globe in front of a
 * glowing source (the Moon over Earth's lights, a planet across the Sun)
 * hides the glow behind it as it hides the source. Mount at the globe's
 * centre, in its frame.
 */
export function GlowOccluder({ radius }: { radius: number }) {
  return glowOn() ? <GlowOccluderOn radius={radius} /> : null
}

function GlowOccluderOn({ radius }: { radius: number }) {
  const mesh = useRef<THREE.Mesh>(null)
  useGlowSource(mesh, GLOW_ORDER.opaque)
  const geometry = useMemo(() => new THREE.SphereGeometry(radius, 32, 16), [radius])
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(() => {
    mesh.current?.layers.set(GLOW_LAYER)
  }, [])
  return (
    <mesh
      ref={mesh}
      geometry={geometry}
      material={black}
      raycast={() => null}
    />
  )
}
