// The planet map a globe binds (tides-0oi.7). In ship mode: its mip-tail
// proxy until the planet is PROMOTE_RADIUS_PX in radius, then the full map
// for the rest of the flight (ship/body-map-residency.ts). Outside it: the
// map, or, while a flight has left it retired, its proxy until its turn to
// come back (one upload a frame).
import { flushSync, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import * as THREE from 'three'
import { useStore } from '../store'
import {
  bodyRadiusPx,
  cachedMapProxy,
  fullMapOf,
  initialBodyMap,
  isRetiredMap,
  mapProxy,
  promoteAtDraw,
  promoteMap,
  retireMap,
  shipMapStep,
  systemMapStep,
  uploadSlot,
} from '../ship/body-map-residency'

const _position = new THREE.Vector3()
const _scale = new THREE.Vector3()
const _drawPosition = new THREE.Vector3()
const _drawScale = new THREE.Vector3()

/** The globe mesh's draw-time check (Object3D.onBeforeRender's arguments). */
export type BodyMapDrawCheck = (this: THREE.Object3D, ...args: Parameters<THREE.Object3D['onBeforeRender']>) => void

export interface ShipBodyMap {
  /** What uMap samples. */
  shown: THREE.Texture | null
  /**
   * For the globe mesh's onBeforeRender in ship mode: a planet the frame
   * callbacks couldn't measure yet (its first frame, before its orbit places
   * it) that draws past DRAW_PROMOTE_RADIUS_PX on its proxy gets its full map
   * before that draw.
   */
  onBeforeDraw: BodyMapDrawCheck | undefined
}

/**
 * The texture standing in for `map`, or `map`. `anchor` sits at the body's
 * centre; `radius` is in its local units, as is the globe mesh's.
 */
export function useShipBodyMap(
  map: THREE.Texture | null,
  anchor: RefObject<THREE.Object3D | null>,
  radius: number
): ShipBodyMap {
  const shipMode = useStore((s) => s.shipMode)
  const [held, setHeld] = useState<THREE.Texture | null>(() => map && initialBodyMap(map))
  const shown = held && (held === map || fullMapOf(held) === map) ? held : map
  const promoted = useRef(false)
  // Committed at once, so the layout effect binds it before this frame draws.
  const show = (texture: THREE.Texture) => flushSync(() => setHeld(texture))

  useFrame(({ gl, camera, size, viewport }) => {
    if (!map) return
    const showsProxy = shown !== map
    if (!shipMode && !showsProxy) return
    const frame = gl.info.render.frame
    if (!shipMode) {
      const step = systemMapStep(showsProxy, isRetiredMap(map), uploadSlot.free(frame))
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
    const step = shipMapStep(false, radiusPx, uploadSlot.free(frame), showsProxy, proxy !== undefined)
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

  const screenPx = useThree((s) => s.size.height * s.viewport.dpr)
  const onBeforeDraw = useMemo<BodyMapDrawCheck | undefined>(() => {
    if (!shipMode || !map) return undefined
    return function (renderer, _scene, camera, _geometry, material) {
      if (promoted.current) return
      const uniform = (material as THREE.ShaderMaterial).uniforms?.uMap
      if (!uniform || fullMapOf(uniform.value as THREE.Texture | null) !== map) return
      _drawPosition.setFromMatrixPosition(this.matrixWorld)
      const worldRadius = radius * _drawScale.setFromMatrixScale(this.matrixWorld).x
      const radiusPx = bodyRadiusPx(camera as THREE.PerspectiveCamera, _drawPosition, worldRadius, screenPx)
      if (!promoteAtDraw(radiusPx)) return
      // Uniforms upload after onBeforeRender, so this draw samples the map;
      // the state follows, and the frame callback sees it promoted.
      promoted.current = true
      promoteMap(renderer, map)
      uniform.value = map
      setHeld(map)
    }
  }, [shipMode, map, radius, screenPx])

  return { shown, onBeforeDraw }
}
