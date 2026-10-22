import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useStore } from '../store'
import { createShipBodies, updateShipBodies } from './ship-bodies'
import { createShipRanges, measureRanges, trueBodies, type TrueBodies } from './ship-distances'
import { getShipTarget, setShipTarget, shipTelemetry } from './ship-telemetry'
import { resetShipApproach, updateApproach } from './approach'
import {
  applyMarker,
  bodyMarkers,
  createMarkerPlacement,
  isMarked,
  placeMarker,
} from './body-markers'
import {
  createScreenBody,
  cycleTarget,
  edgePoint,
  isMoonBody,
  pickBody,
  projectBody,
  shipNav,
  targetMarker,
} from './ship-targeting'

// As ShipController: at 1× bodies barely move between refreshes.
const BODY_REFRESH_MS = 250
// True positions move tens of km a second; the ranges they give are only
// as good as the scene's compression anyway.
const TRUTH_REFRESH_MS = 10_000
// A press that moves further than this is a drag (steering), not a tap.
const TAP_SLOP_PX = 8
// The marker brackets a body this much wider than its disc, and no smaller.
const MARKER_PAD_PX = 10
const MARKER_MIN_PX = 28
// An edge arrow sits this far inside the view.
const EDGE_INSET_PX = 28

const HIDDEN = createMarkerPlacement()

const INTERACTIVE = 'button, a, input, select, textarea, [role="button"], [role="slider"], dialog'

/**
 * Ship mode's target lock and range finder (tides-3bl.5). Mount inside the
 * ship View after ShipController, so each frame it reads the camera where the
 * ship now is. It
 * - picks a target on a tap or click on the scene (by projected disc, the
 *   scene having no pointer events) and cycles targets on T;
 * - positions the HUD's marker on the target (or an edge arrow off screen);
 * - measures true ranges for the HUD into shipNav;
 * - places the minimum-size body markers (body-markers.ts);
 * - works out the approach subject and its state for the HUD's approach
 *   indicator (approach.ts, shipApproach).
 */
export function ShipTargeting() {
  const camera = useThree((s) => s.camera)
  // drei's View connects its event layer to the div it tracks: the scene's
  // surface, under every overlay. Taps that land on an overlay never reach it.
  const surface = useThree((s) => s.events.connected) as HTMLElement | undefined
  const bodies = useMemo(() => createShipBodies(), [])
  const screen = useMemo(() => bodies.map(() => createScreenBody()), [bodies])
  const ranges = useMemo(() => createShipRanges(bodies.length), [bodies])
  const placement = useMemo(() => createMarkerPlacement(), [])
  const bodiesAt = useRef<number | null>(null)
  const truth = useRef<TrueBodies | null>(null)
  const truthAt = useRef<number | null>(null)

  useFrame(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return
    const t = useStore.getState().timestamp ?? Date.now()
    if (bodiesAt.current == null || Math.abs(t - bodiesAt.current) >= BODY_REFRESH_MS) {
      updateShipBodies(bodies, t)
      bodiesAt.current = t
    }
    if (
      truth.current == null ||
      truthAt.current == null ||
      Math.abs(t - truthAt.current) >= TRUTH_REFRESH_MS
    ) {
      truth.current = trueBodies(
        bodies.map((b) => b.key),
        t
      )
      truthAt.current = t
    }
    camera.updateMatrixWorld()

    const target = getShipTarget()
    measureRanges(camera.position, bodies, truth.current, ranges)
    const nearest = ranges.nearest
    const targetIndex = bodies.findIndex((b) => b.key === target)
    shipNav.nearestKey = nearest >= 0 ? bodies[nearest].key : null
    shipNav.nearestKm = nearest >= 0 ? ranges.km[nearest] : NaN
    shipNav.targetKm = targetIndex >= 0 ? ranges.km[targetIndex] : NaN
    shipNav.kmPerUnit = ranges.kmPerUnit

    updateApproach({
      bodies,
      position: camera.position,
      velocity: shipTelemetry.velocity,
      speed: shipTelemetry.speed,
      cap: shipTelemetry.speedCap,
      throttle: shipTelemetry.throttle,
      flightAssist: shipTelemetry.flightAssist,
      targetKey: target,
      km: ranges.km,
    })

    const { width, height, hudBottom } = targetMarker
    if (width === 0 || height === 0) return
    for (let i = 0; i < bodies.length; i++) {
      projectBody(bodies[i], camera, width, height, screen[i])
    }
    // The moon dot follows whichever moon is targeted; no target, no dot.
    let moonPlaced = false
    for (let i = 0; i < bodies.length; i++) {
      const key = bodies[i].key
      const element = isMoonBody(key) ? bodyMarkers.moon : bodyMarkers.planets.get(key)
      if (!element) continue
      if (!isMarked(key, target)) continue
      applyMarker(element, placeMarker(screen[i], screen, width, height, placement))
      if (isMoonBody(key)) moonPlaced = true
    }
    if (!moonPlaced && bodyMarkers.moon) applyMarker(bodyMarkers.moon, HIDDEN)

    const marker = targetMarker.current
    if (!marker) return
    if (targetIndex < 0) {
      marker.hidden = true
      return
    }
    const s = screen[targetIndex]
    marker.hidden = false
    const onScreen =
      s.inFront && s.x >= 0 && s.x <= width && s.y >= 0 && s.y <= height
    if (onScreen) {
      const size = Math.max(MARKER_MIN_PX, Math.min(2 * s.radiusPx, width) + 2 * MARKER_PAD_PX)
      marker.dataset.mode = 'bracket'
      marker.style.width = `${size}px`
      marker.style.height = `${size}px`
      marker.style.transform = `translate(${s.x - size / 2}px, ${s.y - size / 2}px)`
    } else {
      // Below the HUD strip, which would hide an arrow along the top.
      const edge = edgePoint(s.dirX, s.dirY, {
        left: EDGE_INSET_PX,
        top: Math.max(EDGE_INSET_PX, hudBottom + EDGE_INSET_PX),
        right: width - EDGE_INSET_PX,
        bottom: height - EDGE_INSET_PX,
      })
      marker.dataset.mode = 'edge'
      marker.style.width = ''
      marker.style.height = ''
      marker.style.transform = `translate(${edge.x}px, ${edge.y}px) rotate(${edge.angle}rad)`
    }
  })

  // Tap or click on the scene: lock the body under it. A miss keeps the
  // current target (clearing is the HUD's ×), so a stray tap costs nothing.
  // The body is picked where the press lands: on a desktop the mouse steers,
  // so the view turns under a held click. It only counts as a tap if the
  // pointer then lifts nearby. Presses are tracked per pointer, so a tap
  // works while the other thumb holds the steer stick.
  useEffect(() => {
    if (!surface) return
    const presses = new Map<number, { x: number; y: number; key: string | null }>()
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      if ((event.target as Element | null)?.closest?.(INTERACTIVE)) return
      if (!(camera instanceof THREE.PerspectiveCamera)) return
      const rect = surface.getBoundingClientRect()
      camera.updateMatrixWorld()
      bodies.forEach((body, i) => projectBody(body, camera, rect.width, rect.height, screen[i]))
      presses.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        key: pickBody(
          screen,
          event.clientX - rect.left,
          event.clientY - rect.top,
          getShipTarget()
        ),
      })
    }
    const onUp = (event: PointerEvent) => {
      const press = presses.get(event.pointerId)
      presses.delete(event.pointerId)
      if (!press?.key) return
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP_PX) return
      setShipTarget(press.key)
    }
    const onCancel = (event: PointerEvent) => {
      presses.delete(event.pointerId)
    }
    surface.addEventListener('pointerdown', onDown)
    surface.addEventListener('pointerup', onUp)
    surface.addEventListener('pointercancel', onCancel)
    return () => {
      surface.removeEventListener('pointerdown', onDown)
      surface.removeEventListener('pointerup', onUp)
      surface.removeEventListener('pointercancel', onCancel)
    }
  }, [surface, camera, bodies, screen])

  // T: the next body out from the screen centre.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // By position, as the flight keys (desktop-keys.ts); Shift is allowed.
      if (event.code !== 'KeyT') return
      if (event.repeat || event.defaultPrevented) return
      if (event.altKey || event.ctrlKey || event.metaKey) return
      if (document.querySelector('dialog[open]')) return
      const target = event.target as Element | null
      if (target?.closest?.('input, select, textarea, [contenteditable="true"]')) return
      camera.updateMatrixWorld()
      setShipTarget(cycleTarget(bodies, camera, getShipTarget()))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [camera, bodies])

  // A target (or an approach) doesn't outlive the ship session.
  useEffect(
    () => () => {
      setShipTarget(null)
      resetShipApproach()
    },
    []
  )

  return null
}
