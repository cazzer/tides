// The tides demo's marked spot (tides-zec.4): the user's pin, or a spot on
// the equator under the Moon at the daily step's start (tidesSpot). A child
// of Earth's OrbitingBody, so it turns with the globe under the tide's
// bulges. A red dot in a halo ring lying flat on the ground, drawn twice:
// bright where the ground's depth lets it show, and faint over everything,
// so it stays findable all the way round.
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { CLOUD_UNDER_AURORA_RENDER_ORDER } from '../renderers/earth-shells'
import { useStore } from '../store'
import { calculateLocationAndRotationForLatLng } from '../utils'
import { tidesSpot } from './tides'

// × Earth's radius.
const DOT_SIZE = 0.06 // [TUNE]
const HALO_INNER = 0.1
const HALO_OUTER = 0.13
const DOT_LIFT = 1.01
const TIDES_SPOT_COLOR = '#FF5A6A'
const GHOST_OPACITY = 0.35
// Over the tide shell and the ring's discs (TidesField), under its arrows.
const DOT_ORDER = CLOUD_UNDER_AURORA_RENDER_ORDER + 0.65
const Z = new THREE.Vector3(0, 0, 1)

function noRaycast() {}

function spotMaterial(depthTest: boolean, opacity: number) {
  return new THREE.MeshBasicMaterial({
    color: TIDES_SPOT_COLOR,
    transparent: true,
    opacity,
    toneMapped: false,
    depthWrite: false,
    depthTest,
    // The halo, seen from either side.
    side: THREE.DoubleSide,
  })
}

export function TidesSpot({ radius }: { radius: number }) {
  const location = useStore((s) => s.location)
  const { lat, lon } = tidesSpot(location)
  const { x, y, z } = calculateLocationAndRotationForLatLng(lat, lon, radius * DOT_LIFT).position
  // The halo faces out from the globe's centre.
  const facing = useMemo(() => new THREE.Quaternion().setFromUnitVectors(Z, new THREE.Vector3(x, y, z).normalize()), [x, y, z])
  const geometries = useMemo(
    () => ({
      dot: new THREE.SphereGeometry(DOT_SIZE * radius, 16, 12),
      halo: new THREE.RingGeometry(HALO_INNER * radius, HALO_OUTER * radius, 40),
    }),
    [radius]
  )
  const materials = useMemo(() => ({ bright: spotMaterial(true, 1), ghost: spotMaterial(false, GHOST_OPACITY) }), [])
  useEffect(
    () => () => {
      geometries.dot.dispose()
      geometries.halo.dispose()
    },
    [geometries]
  )
  useEffect(
    () => () => {
      materials.bright.dispose()
      materials.ghost.dispose()
    },
    [materials]
  )
  return (
    <group position={[x, y, z]} quaternion={facing}>
      {[materials.ghost, materials.bright].map((material) => (
        <group key={material.uuid}>
          <mesh renderOrder={DOT_ORDER} geometry={geometries.dot} material={material} raycast={noRaycast} />
          <mesh renderOrder={DOT_ORDER} geometry={geometries.halo} material={material} raycast={noRaycast} />
        </group>
      ))}
    </group>
  )
}
