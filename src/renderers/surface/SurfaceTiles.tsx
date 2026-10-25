// The streamed true-scale surface under the ship (tides-zmw.9.1), behind
// ?surface=1 (../../surface.ts). Mount inside Earth's OrbitingBody, beside
// EarthRenderer, so its group inherits Earth's tilt and spin; solar-system
// lazy-loads this module so the library stays out of the main chunk.
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { createSurfaceTiles, type SurfaceTiles as Tiles } from './createSurfaceTiles'
import { SURFACE_FRAME_PRIORITY } from './surface-frame'

export default function SurfaceTiles() {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const width = useThree((s) => s.size.width)
  const height = useThree((s) => s.size.height)
  // The elevation maps are linear-filtered 32-bit float textures, which iOS
  // can't sample (no OES_texture_float_linear): draw nothing there until
  // tides-zmw.9.2 converts them. The tier gate keeps phones out already;
  // this catches iPads, which report the high tier.
  const floatLinear = useMemo(() => gl.getContext().getExtension('OES_texture_float_linear') !== null, [gl])
  const holder = useRef<THREE.Group>(null)
  const surface = useRef<Tiles | null>(null)

  // Created in an effect and hung under the holder by hand (no state, so no
  // extra render), so StrictMode's mount, unmount, mount disposes the first
  // instance whole and draws only the second. Leaving ship mode unmounts
  // this: the camera is released and every tile, texture and in-flight
  // download with it.
  useEffect(() => {
    const parent = holder.current
    if (!floatLinear || !parent) return
    const created = createSurfaceTiles()
    created.tiles.setCamera(camera)
    parent.add(created.tiles.group)
    surface.current = created
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
  }, [camera, floatLinear])

  // In CSS pixels, as setResolutionFromRenderer would give: the error target
  // is in those pixels. After the effect above, so the camera is registered.
  useEffect(() => {
    surface.current?.tiles.setResolution(camera, width, height)
  }, [camera, floatLinear, width, height])

  useFrame(() => {
    const tiles = surface.current?.tiles
    if (!tiles?.group.parent) return
    // ShipController has moved the camera and OrbitingBody turned Earth this
    // frame, but neither world matrix is refreshed until the render: do it
    // here, so the tiles pick their detail and cull against where the camera
    // and ground are drawn this frame, not last frame.
    camera.updateWorldMatrix(true, false)
    tiles.group.updateWorldMatrix(true, false)
    tiles.update()
  }, SURFACE_FRAME_PRIORITY)

  return <group ref={holder} />
}
