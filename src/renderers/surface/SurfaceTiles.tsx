// The streamed true-scale surface under the ship (tides-zmw.9.1), behind
// ?surface=1 (../../surface.ts). Mount inside Earth's OrbitingBody, beside
// EarthRenderer, so its group inherits Earth's tilt and spin; solar-system
// lazy-loads this module so the library stays out of the main chunk.
//
// tides-zmw.9.7: the tiles wait for their View's globe link (surface-link.ts;
// the ground haze then, every globe feature since tides-zmw.9.16) so every
// tile is built with it, and draw only below the handover's top
// (surfaceOpacityUniform, ../../surface-handover.ts; surface-scale.ts
// dissolves them in under it).
//
// tides-zmw.9.8: the ship's floor reads the tiles it draws (surface-ground.ts,
// registered in ../../surface-ground.ts while mounted), refreshed after each
// update.
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { shipTelemetry } from '../../ship/ship-telemetry'
import { surfaceOpacityUniform } from '../../surface-handover'
import { createSurfaceTiles, type SurfaceTiles as Tiles } from './createSurfaceTiles'
import { ActiveSources, sourcesForTile, tileOnNearSide, tileRadianBounds, type SurfaceSource } from './credit-sources'
import type { ImageryTile } from './imagery'
import { setActiveSurfaceSources } from './surface-credits'
import { createSurfaceGround, type SurfaceGround } from './surface-ground'
import { forEachCachedModel } from './terrain-internals'
import { createRectWriter } from './grid-upload'
import { setSurfaceGroundSampler, surfaceGroundSampler } from '../../surface-ground'
import { SURFACE_FRAME_PRIORITY } from './surface-frame'
import { subscribeSurfaceLink, surfaceLink } from './surface-link'
import { eyeMarginMetres, smoothErrorTarget, surfaceErrorTarget, sweepRate } from './surface-lod'
import { EARTH_UNITS_PER_METRE } from '../../ship/ship-bodies'

// How often the visible tiles are read for the credits line; it only needs to
// notice tiles arriving and leaving.
const CREDIT_INTERVAL_MS = 250
const creditEye = new THREE.Vector3()

export default function SurfaceTiles() {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  // The globe's link in this View, which EarthRenderer publishes.
  const link = useSyncExternalStore(subscribeSurfaceLink, () => surfaceLink(scene))
  const width = useThree((s) => s.size.width)
  const height = useThree((s) => s.size.height)
  // Without linear filtering of float textures (iOS), the elevation grids
  // are nearest-filtered instead (createSurfaceTiles, tides-zmw.9.2).
  const floatLinear = useMemo(() => gl.getContext().getExtension('OES_texture_float_linear') !== null, [gl])
  const touch = useMemo(() => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches, [])
  const holder = useRef<THREE.Group>(null)
  const surface = useRef<Tiles | null>(null)
  const ground = useRef<SurfaceGround | null>(null)
  const errorTarget = useRef(NaN)
  const credits = useRef<{ sources: ActiveSources; at: number } | null>(null)

  // Created in an effect and hung under the holder by hand (no state, so no
  // extra render), so StrictMode's mount, unmount, mount disposes the first
  // instance whole and draws only the second. Leaving ship mode unmounts
  // this: the camera is released and every tile, texture and in-flight
  // download with it.
  useEffect(() => {
    const parent = holder.current
    if (!parent || !link) return
    let created: Tiles
    try {
      created = createSurfaceTiles({ floatLinear, upload: (texture) => gl.initTexture(texture), writeRects: createRectWriter(gl), link })
    } catch (error) {
      // e.g. no OffscreenCanvas (Safari before 16.4), which the library's
      // terrain plugin needs to construct: fly over the globe alone.
      console.warn('surface tiles: unavailable here', error)
      return
    }
    created.tiles.setCamera(camera)
    parent.add(created.tiles.group)
    surface.current = created
    const sampler = createSurfaceGround({
      group: created.tiles.group,
      forEachLoadedModel: (callback) => forEachCachedModel(created.tiles, callback),
    }, { deepest: created.viewError.deepest })
    ground.current = sampler
    setSurfaceGroundSampler(sampler)
    errorTarget.current = NaN
    const sources = new ActiveSources()
    credits.current = { sources, at: -Infinity }
    return () => {
      surface.current = null
      ground.current = null
      if (surfaceGroundSampler() === sampler) setSurfaceGroundSampler(null)
      credits.current = null
      setActiveSurfaceSources([])
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
  }, [camera, gl, floatLinear, link])

  // In CSS pixels, as setResolutionFromRenderer would give: the error target
  // is in those pixels, and the cache's marks follow them (surface-lod.ts).
  // After the effect above, so the camera is registered.
  useEffect(() => {
    surface.current?.setViewSize(camera, width, height)
  }, [camera, gl, floatLinear, link, width, height])

  useFrame((_, delta) => {
    const current = surface.current
    if (!current?.tiles.group.parent) return
    const { tiles, budget } = current
    budget.tick()
    // Less detail the faster the ground sweeps past (surface-lod.ts), but
    // the rest detail under and around the eye (a second's flight ahead),
    // set before update() picks this frame's tiles.
    const speed = shipTelemetry.air.speed
    const target = surfaceErrorTarget(sweepRate(speed, shipTelemetry.nearest), touch)
    errorTarget.current = smoothErrorTarget(errorTarget.current, target, delta)
    current.setErrorTarget(errorTarget.current, surfaceErrorTarget(0, touch), eyeMarginMetres(speed / EARTH_UNITS_PER_METRE))
    // ShipController has moved the camera and OrbitingBody turned Earth this
    // frame, but neither world matrix is refreshed until the render: do it
    // here, so the tiles pick their detail and cull against where the camera
    // and ground are drawn this frame, not last frame.
    camera.updateWorldMatrix(true, false)
    tiles.group.updateWorldMatrix(true, false)
    tiles.update()
    ground.current?.invalidate()
    // None of the ground is the tiles' above the handover's top (ShipController
    // has written this frame's share): the globe draws it all.
    tiles.group.visible = surfaceOpacityUniform.value > 0
    current.syncCounters()
    const now = performance.now()
    const credit = credits.current
    if (credit && now - credit.at >= CREDIT_INTERVAL_MS) {
      credit.at = now
      const seen = new Set<SurfaceSource>()
      const servedByEox = (tile: ImageryTile) => current.overlay.servedByEox(tile)
      // The camera in the tiles' own frame (ECEF metres), for the horizon.
      const eye = tiles.group.worldToLocal(camera.getWorldPosition(creditEye))
      for (const tile of tiles.visibleTiles) {
        const bounds = tileRadianBounds(tile)
        if (bounds && tileOnNearSide(bounds, eye)) sourcesForTile(bounds, servedByEox).forEach((s) => seen.add(s))
      }
      setActiveSurfaceSources(credit.sources.update(seen, now))
    }
  }, SURFACE_FRAME_PRIORITY)

  return <group ref={holder} />
}
