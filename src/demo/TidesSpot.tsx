// The tides demo's marked spot (tides-zec.4): the user's pin, or a spot on
// the equator under the Moon at the daily step's start (tidesSpot). A child
// of Earth's OrbitingBody, so it turns with the globe under the tide's
// bulges. Drawn twice: a bright dot the ground's depth hides on the far side,
// and a faint copy over everything, so it stays findable all the way round.
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { CLOUD_UNDER_AURORA_RENDER_ORDER } from '../renderers/earth-shells'
import { useStore } from '../store'
import { calculateLocationAndRotationForLatLng } from '../utils'
import { tidesSpot } from './tides'

// × Earth's radius.
const DOT_SIZE = 0.05
const DOT_LIFT = 1.01
const TIDES_SPOT_COLOR = '#FF5A6A'
const GHOST_OPACITY = 0.35
// Over the tide shell and the ring's discs (TidesField), under its arrows.
const DOT_ORDER = CLOUD_UNDER_AURORA_RENDER_ORDER + 0.65

function noRaycast() {}

export function TidesSpot({ radius }: { radius: number }) {
  const location = useStore((s) => s.location)
  const { lat, lon } = tidesSpot(location)
  const { x, y, z } = calculateLocationAndRotationForLatLng(lat, lon, radius * DOT_LIFT).position
  const geometry = useMemo(() => new THREE.SphereGeometry(DOT_SIZE * radius, 16, 12), [radius])
  const materials = useMemo(
    () => ({
      dot: new THREE.MeshBasicMaterial({ color: TIDES_SPOT_COLOR, transparent: true, toneMapped: false, depthWrite: false }),
      ghost: new THREE.MeshBasicMaterial({
        color: TIDES_SPOT_COLOR,
        transparent: true,
        opacity: GHOST_OPACITY,
        toneMapped: false,
        depthWrite: false,
        depthTest: false,
      }),
    }),
    []
  )
  useEffect(() => () => geometry.dispose(), [geometry])
  useEffect(
    () => () => {
      materials.dot.dispose()
      materials.ghost.dispose()
    },
    [materials]
  )
  return (
    <group position={[x, y, z]}>
      <mesh renderOrder={DOT_ORDER} geometry={geometry} material={materials.ghost} raycast={noRaycast} />
      <mesh renderOrder={DOT_ORDER} geometry={geometry} material={materials.dot} raycast={noRaycast} />
    </group>
  )
}
