// The planet map a ship-mode globe binds (tides-0oi.7): its mip-tail proxy
// until the planet is PROMOTE_RADIUS_PX across in radius, then the full map
// for the rest of the flight (ship/body-map-residency.ts). Outside ship mode,
// the map as it is.
import { useFrame } from '@react-three/fiber'
import { useEffect, useRef, useState, type RefObject } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import {
  cachedMapProxy,
  fullMapOf,
  mapProxy,
  projectedRadiusPx,
  promoteMap,
  retireMap,
  shouldUploadNow,
  uploadSlot,
} from '../ship/body-map-residency'

const _position = new THREE.Vector3()
const _scale = new THREE.Vector3()

/**
 * `map`, or in ship mode the texture standing in for it. `anchor` sits at
 * the body's centre; `radius` is in its local units.
 */
export function useShipBodyMap(
  map: THREE.Texture | null,
  anchor: RefObject<THREE.Object3D | null>,
  radius: number
): THREE.Texture | null {
  const shipMode = useStore((s) => s.shipMode)
  // The map itself until its proxy is built (one frame's budget, below).
  const [held, setHeld] = useState<THREE.Texture | null>(() => (map && cachedMapProxy(map)) ?? map)
  const shown = held && (held === map || fullMapOf(held) === map) ? held : map
  const promoted = useRef(false)

  useFrame(({ gl, camera, clock, size, viewport }) => {
    const body = anchor.current
    if (!shipMode || !map || promoted.current || !body) return
    const frame = clock.elapsedTime
    body.getWorldPosition(_position)
    // Not placed yet (its orbit's frame runs after this one): the Sun's spot.
    if (_position.lengthSq() === 0) return
    const worldRadius = radius * body.getWorldScale(_scale).x
    const fov = (camera as THREE.PerspectiveCamera).fov
    const radiusPx = projectedRadiusPx(camera.position.distanceTo(_position), worldRadius, size.height * viewport.dpr, fov)
    if (shouldUploadNow(radiusPx, uploadSlot.free(frame))) {
      uploadSlot.take(frame)
      promoted.current = true
      if (shown !== map) {
        promoteMap(gl, map)
        setHeld(map)
      }
      return
    }
    if (shown !== map || !uploadSlot.take(frame)) return
    const proxy = mapProxy(gl, map)
    if (proxy) setHeld(proxy)
    // A map that can't have one stays as it is.
    else promoted.current = true
  })

  const showsProxy = shipMode && map !== null && shown !== map
  useEffect(() => {
    if (showsProxy && map) retireMap(map)
  }, [showsProxy, map])

  return shipMode ? shown : map
}
