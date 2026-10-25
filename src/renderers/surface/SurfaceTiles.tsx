// The streamed true-scale surface under the ship (tides-zmw.9.1), behind
// ?surface=1 (../../surface.ts). Mount inside Earth's OrbitingBody, beside
// EarthRenderer, so its group inherits Earth's tilt and spin; solar-system
// lazy-loads this module so the library stays out of the main chunk.
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { shipTelemetry } from '../../ship/ship-telemetry'
import { createSurfaceTiles, type SurfaceTiles as Tiles } from './createSurfaceTiles'
import { SURFACE_FRAME_PRIORITY } from './surface-frame'
import { smoothErrorTarget, surfaceErrorTarget, sweepRate } from './surface-lod'

export default function SurfaceTiles() {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const width = useThree((s) => s.size.width)
  const height = useThree((s) => s.size.height)
  // Without linear filtering of float textures (iOS), the elevation grids
  // are nearest-filtered instead (createSurfaceTiles, tides-zmw.9.2).
  const floatLinear = useMemo(() => gl.getContext().getExtension('OES_texture_float_linear') !== null, [gl])
  const touch = useMemo(() => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches, [])
  const holder = useRef<THREE.Group>(null)
  const surface = useRef<Tiles | null>(null)
  const errorTarget = useRef(NaN)

  // Created in an effect and hung under the holder by hand (no state, so no
  // extra render), so StrictMode's mount, unmount, mount disposes the first
  // instance whole and draws only the second. Leaving ship mode unmounts
  // this: the camera is released and every tile, texture and in-flight
  // download with it.
  useEffect(() => {
    const parent = holder.current
    if (!parent) return
    let created: Tiles
    try {
      created = createSurfaceTiles({ floatLinear, upload: (texture) => gl.initTexture(texture) })
    } catch (error) {
      // e.g. no OffscreenCanvas (Safari before 16.4), which the library's
      // terrain plugin needs to construct: fly over the globe alone.
      console.warn('surface tiles: unavailable here', error)
      return
    }
    created.tiles.setCamera(camera)
    parent.add(created.tiles.group)
    surface.current = created
    errorTarget.current = NaN
    return () => {
      surface.current = null
      parent.remove(created.tiles.group)
      created.tiles.deleteCamera(camera)
      // The library's cache refcounts throw synchronously on a broken
      // invariant; thrown here, that would unmount the whole app on exit.
      try {
        created.dispose()
      } catch (error) {
        console.error('surface tiles: dispose failed', error)
      }
    }
  }, [camera, gl, floatLinear])

  // In CSS pixels, as setResolutionFromRenderer would give: the error target
  // is in those pixels. After the effect above, so the camera is registered.
  useEffect(() => {
    surface.current?.tiles.setResolution(camera, width, height)
  }, [camera, gl, floatLinear, width, height])

  useFrame((_, delta) => {
    const current = surface.current
    if (!current?.tiles.group.parent) return
    const { tiles, budget } = current
    budget.tick()
    // Less detail the faster the ground sweeps past (surface-lod.ts), set
    // before update() picks this frame's tiles.
    const target = surfaceErrorTarget(sweepRate(shipTelemetry.speed, shipTelemetry.nearest), touch)
    errorTarget.current = smoothErrorTarget(errorTarget.current, target, delta)
    tiles.errorTarget = errorTarget.current
    // ShipController has moved the camera and OrbitingBody turned Earth this
    // frame, but neither world matrix is refreshed until the render: do it
    // here, so the tiles pick their detail and cull against where the camera
    // and ground are drawn this frame, not last frame.
    camera.updateWorldMatrix(true, false)
    tiles.group.updateWorldMatrix(true, false)
    tiles.update()
    current.syncCounters()
  }, SURFACE_FRAME_PRIORITY)

  return <group ref={holder} />
}
