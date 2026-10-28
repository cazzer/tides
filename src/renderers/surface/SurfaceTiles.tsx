// The streamed true-scale surface under the ship (tides-zmw.9.1), on unless
// ?surface=0 (../../surface.ts). Mount inside Earth's OrbitingBody, beside
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
//
// tides-tvr.7.2: the system view mounts them too (eye="system"), in the main
// view's close zoom over Earth on the high tier (../../close-zoom-rules.ts
// systemSurfaceTilesOn). With no ship there, they set the handover's eye
// (setSurfaceEye) and read the sweep from the camera's own height and motion
// over the ground, in Earth's frame; close zoom's floor then reads their
// ground as the ship's does (../../close-zoom.ts earthGroundRadius). Leaving
// ship mode, close zoom or Earth focus unmounts them.
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { shipTelemetry } from '../../ship/ship-telemetry'
import { setSurfaceEye, surfaceOpacityUniform } from '../../surface-handover'
import { createSurfaceTiles, type SurfaceTiles as Tiles } from './createSurfaceTiles'
import { ActiveSources, creditsShown, NO_SOURCES, sourcesForTile, tileOnNearSide, tileRadianBounds, type SurfaceSource } from './credit-sources'
import type { ImageryTile } from './imagery'
import { setActiveSurfaceSources } from './surface-credits'
import { createSurfaceGround, type SurfaceGround } from './surface-ground'
import { forEachCachedModel } from './terrain-internals'
import { createRectWriter } from './grid-upload'
import { setSurfaceGroundSampler, surfaceGroundSampler } from '../../surface-ground'
import { SURFACE_FRAME_PRIORITY } from './surface-frame'
import { subscribeSurfaceLink, surfaceLink } from './surface-link'
import { EYE_REACH_METRES, eyeMarginMetres, groundSpeed, smoothErrorTarget, surfaceErrorTarget, sweepRate } from './surface-lod'
import { EARTH_RADIUS, EARTH_UNITS_PER_METRE } from '../../ship/ship-bodies'
import { closeZoomState, groundAngle } from '../../close-zoom'

// How often the visible tiles are read for the credits line; it only needs to
// notice tiles arriving and leaving.
const CREDIT_INTERVAL_MS = 250
const creditEye = new THREE.Vector3()
// The system view's eye this frame, in Earth's frame, and the nearest
// surface it gives sweepRate.
const systemEye = new THREE.Vector3()
const systemNearest = { key: 'earth', surfaceDistance: Infinity }

export interface SurfaceTilesProps {
  /**
   * Whose eye the tiles are drawn for: the ship's (ShipController sets the
   * handover and the telemetry the detail reads), or the system view's
   * camera in close zoom, which sets both here.
   */
  eye?: 'ship' | 'system'
}

export default function SurfaceTiles({ eye = 'ship' }: SurfaceTilesProps) {
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
  // The system view's eye last frame, in Earth's frame, for its speed.
  const previousEye = useRef({ has: false, at: new THREE.Vector3() })

  // Created in an effect and hung under the holder by hand (no state, so no
  // extra render), so StrictMode's mount, unmount, mount disposes the first
  // instance whole and draws only the second. Leaving ship mode (or, in the
  // system view, close zoom or Earth focus) unmounts this: the camera is
  // released and every tile, texture and in-flight download with it.
  useEffect(() => {
    const parent = holder.current
    const previous = previousEye.current
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
      // The system view's eye goes with the tiles: the globe draws it all.
      if (eye === 'system') setSurfaceEye(Infinity)
      previous.has = false
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
  }, [camera, gl, floatLinear, link, eye])

  // In CSS pixels, as setResolutionFromRenderer would give: the error target
  // is in those pixels, and the cache's marks follow them (surface-lod.ts).
  // After the effect above, so the camera is registered.
  useEffect(() => {
    surface.current?.setViewSize(camera, width, height)
  }, [camera, gl, floatLinear, link, width, height])

  useFrame((_, delta) => {
    const current = surface.current
    const holderGroup = current?.tiles.group.parent
    if (!current || !holderGroup) return
    const { tiles, budget } = current
    budget.tick()
    // ShipController (or the system view's controls) has moved the camera
    // and OrbitingBody turned Earth this frame, but neither world matrix is
    // refreshed until the render: do it here, so the tiles pick their detail
    // and cull against where the camera and ground are drawn this frame, not
    // last frame (and the system view's eye below reads them).
    camera.updateWorldMatrix(true, false)
    tiles.group.updateWorldMatrix(true, false)
    let speed: number
    let nearest: { key: string | null; surfaceDistance: number }
    let margin: number
    if (eye === 'system') {
      // The holder sits in Earth's spinning body, centred on it: the camera
      // there is its height over the sea-level sphere, and its motion over
      // the ground, which close zoom's turn with Earth leaves still.
      const local = holderGroup.worldToLocal(camera.getWorldPosition(systemEye))
      const eyeR = local.length()
      const altitude = eyeR - EARTH_RADIUS
      setSurfaceEye(altitude)
      const previous = previousEye.current
      speed = groundSpeed(previous.has ? previous.at : null, local, delta)
      previous.at.copy(local)
      previous.has = true
      // The gap to the ground close zoom's floor read this frame under the
      // eye (the sea-level sphere until it has).
      systemNearest.surfaceDistance = Math.max(eyeR - (closeZoomState.groundUnderEye ?? EARTH_RADIUS), 0)
      nearest = systemNearest
      // Rest detail over the floor's window around the eye, not a second's
      // travel ahead: the camera looks straight down, so a drag's second
      // (several altitudes) would cover the whole view and cancel the sweep's
      // coarsening.
      margin = Math.max(EYE_REACH_METRES, (groundAngle(altitude, EARTH_RADIUS) * EARTH_RADIUS) / EARTH_UNITS_PER_METRE)
    } else {
      speed = shipTelemetry.air.speed
      nearest = shipTelemetry.nearest
      margin = eyeMarginMetres(speed / EARTH_UNITS_PER_METRE)
    }
    // Less detail the faster the ground sweeps past (surface-lod.ts), but
    // the rest detail under and around the eye (in flight, a second's
    // flight ahead), set before update() picks this frame's tiles.
    const target = surfaceErrorTarget(sweepRate(speed, nearest), touch)
    errorTarget.current = smoothErrorTarget(errorTarget.current, target, delta)
    current.setErrorTarget(errorTarget.current, surfaceErrorTarget(0, touch), margin)
    tiles.update()
    ground.current?.invalidate()
    // None of the ground is the tiles' above the handover's top (ShipController,
    // or the system view's eye above, has written this frame's share): the
    // globe draws it all.
    tiles.group.visible = surfaceOpacityUniform.value > 0
    current.syncCounters()
    const now = performance.now()
    const credit = credits.current
    if (credit && !creditsShown(eye, tiles.group.visible)) {
      // The system view's tiles, mounted but not drawing yet: no credits,
      // and a fresh read the frame they start to.
      credit.at = -Infinity
      setActiveSurfaceSources(NO_SOURCES)
    } else if (credit && now - credit.at >= CREDIT_INTERVAL_MS) {
      credit.at = now
      const seen = new Set<SurfaceSource>()
      const servedByEox = (tile: ImageryTile) => current.overlay.servedByEox(tile)
      // The camera in the tiles' own frame (ECEF metres), for the horizon.
      const viewer = tiles.group.worldToLocal(camera.getWorldPosition(creditEye))
      for (const tile of tiles.visibleTiles) {
        const bounds = tileRadianBounds(tile)
        if (bounds && tileOnNearSide(bounds, viewer)) sourcesForTile(bounds, servedByEox).forEach((s) => seen.add(s))
      }
      setActiveSurfaceSources(credit.sources.update(seen, now))
    }
  }, SURFACE_FRAME_PRIORITY)

  return <group ref={holder} />
}
