// The planet map a globe binds (tides-0oi.7). In ship mode: its mip-tail
// proxy until the planet is PROMOTE_RADIUS_PX in radius, then the full map
// for the rest of the flight (ship/body-map-residency.ts). Outside it: the
// map, or, while a flight has left it retired, its proxy until its turn to
// come back (one upload a frame).
import { flushSync, useFrame } from '@react-three/fiber'
import { useEffect, useRef, useState, type RefObject } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import {
  bodyRadiusPx,
  cachedMapProxy,
  fullMapOf,
  initialBodyMap,
  isRetiredMap,
  mapProxy,
  promoteMap,
  retireMap,
  shipMapStep,
  systemMapStep,
  uploadSlot,
} from '../ship/body-map-residency'

const _position = new THREE.Vector3()
const _scale = new THREE.Vector3()

/**
 * The texture standing in for `map`, or `map`. `anchor` sits at the body's
 * centre; `radius` is in its local units.
 */
export function useShipBodyMap(
  map: THREE.Texture | null,
  anchor: RefObject<THREE.Object3D | null>,
  radius: number
): THREE.Texture | null {
  const shipMode = useStore((s) => s.shipMode)
  const [held, setHeld] = useState<THREE.Texture | null>(() => map && initialBodyMap(map))
  const shown = held && (held === map || fullMapOf(held) === map) ? held : map
  const promoted = useRef(false)

  useFrame(({ gl, camera, size, viewport }) => {
    if (!map) return
    const frame = gl.info.render.frame
    const showsProxy = shown !== map
    // Committed now, so the layout effect binds it before this frame draws.
    const show = (texture: THREE.Texture) => flushSync(() => setHeld(texture))
    if (!shipMode) {
      const step = systemMapStep({ showsProxy, retired: isRetiredMap(map), slotFree: uploadSlot.free(frame) })
      if (step === 'restore') {
        uploadSlot.take(frame)
        promoteMap(gl, map)
      }
      if (step === 'restore' || step === 'show') show(map)
      return
    }
    const body = anchor.current
    if (promoted.current || !body) return
    body.getWorldPosition(_position)
    // Not placed yet (its orbit's frame runs after this one): the Sun's spot.
    if (_position.lengthSq() === 0) return
    const worldRadius = radius * body.getWorldScale(_scale).x
    const radiusPx = bodyRadiusPx(camera as THREE.PerspectiveCamera, _position, worldRadius, size.height * viewport.dpr)
    const proxy = cachedMapProxy(map)
    const step = shipMapStep({
      promoted: false,
      radiusPx,
      slotFree: uploadSlot.free(frame),
      showsProxy,
      proxyCached: proxy !== undefined,
    })
    if (step === 'promote') {
      uploadSlot.take(frame)
      promoted.current = true
      promoteMap(gl, map)
      if (showsProxy) show(map)
    } else if (step === 'proxy' && proxy) {
      show(proxy)
    } else if (step === 'build') {
      uploadSlot.take(frame)
      const built = mapProxy(gl, map)
      if (built) show(built)
      // A map that can't have one stays as it is.
      else promoted.current = true
    }
  })

  const showsProxy = map !== null && shown !== map
  useEffect(() => {
    if (shipMode && showsProxy && map && !isRetiredMap(map)) retireMap(map)
  }, [shipMode, showsProxy, map])

  return shown
}
