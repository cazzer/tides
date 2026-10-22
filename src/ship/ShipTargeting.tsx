import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useStore } from '../store'
import { createShipBodies, updateShipBodies } from './ship-bodies'
import { createShipRanges, measureRanges, trueSeparations } from './ship-distances'
import { getShipTarget, setShipTarget, shipTelemetry } from './ship-telemetry'
import {
  createScreenBody,
  cycleTarget,
  edgePoint,
  pickBody,
  projectBody,
  shipNav,
  targetMarker,
} from './ship-targeting'

// As ShipController: at 1× bodies barely move between refreshes.
const BODY_REFRESH_MS = 250
// True separations change by a few thousand km a minute at most.
const SEPARATION_REFRESH_MS = 10_000
// A press that moves further than this is a drag (steering), not a tap.
const TAP_SLOP_PX = 8
// The marker brackets a body this much wider than its disc, and no smaller.
const MARKER_PAD_PX = 10
const MARKER_MIN_PX = 28
// An edge arrow sits this far inside the view.
const EDGE_INSET_PX = 28

const INTERACTIVE = 'button, a, input, select, textarea, [role="button"], [role="slider"], dialog'

/**
 * Ship mode's target lock and range finder (tides-3bl.5). Mount inside the
 * ship View after ShipController, so each frame it reads the camera where the
 * ship now is. It
 * - picks a target on a tap or click on the scene (by projected disc, the
 *   scene having no pointer events) and cycles targets on T;
 * - positions the HUD's marker on the target (or an edge arrow off screen);
 * - measures true ranges for the HUD into shipNav.
 */
export function ShipTargeting() {
  const camera = useThree((s) => s.camera)
  // drei's View connects its event layer to the div it tracks: the scene's
  // surface, under every overlay. Taps that land on an overlay never reach it.
  const surface = useThree((s) => s.events.connected) as HTMLElement | undefined
  const bodies = useMemo(() => createShipBodies(), [])
  const screen = useMemo(() => bodies.map(() => createScreenBody()), [bodies])
  const ranges = useMemo(() => createShipRanges(bodies.length), [bodies])
  const bodiesAt = useRef<number | null>(null)
  const separations = useRef<Float64Array | null>(null)
  const separationsAt = useRef<number | null>(null)

  useFrame(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return
    const t = useStore.getState().timestamp ?? Date.now()
    if (bodiesAt.current == null || Math.abs(t - bodiesAt.current) >= BODY_REFRESH_MS) {
      updateShipBodies(bodies, t)
      bodiesAt.current = t
    }
    if (
      separationsAt.current == null ||
      Math.abs(t - separationsAt.current) >= SEPARATION_REFRESH_MS
    ) {
      separations.current = trueSeparations(
        bodies.map((b) => b.key),
        t
      )
      separationsAt.current = t
    }
    camera.updateMatrixWorld()

    const target = getShipTarget()
    measureRanges(camera.position, bodies, separations.current!, ranges)
    const nearest = bodies.findIndex((b) => b.key === shipTelemetry.nearest.key)
    const targetIndex = bodies.findIndex((b) => b.key === target)
    shipNav.nearestKm = nearest >= 0 ? ranges.km[nearest] : NaN
    shipNav.targetKm = targetIndex >= 0 ? ranges.km[targetIndex] : NaN
    shipNav.kmPerUnit = ranges.kmPerUnit

    const marker = targetMarker.current
    if (!marker) return
    const host = marker.parentElement
    if (targetIndex < 0 || !host) {
      marker.hidden = true
      return
    }
    const width = host.clientWidth
    const height = host.clientHeight
    const s = projectBody(bodies[targetIndex], camera, width, height, screen[targetIndex])
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
      const hud = targetMarker.hud
      const hudBottom = hud ? hud.offsetTop + hud.offsetHeight : 0
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
  useEffect(() => {
    if (!surface) return
    let press: { id: number; x: number; y: number } | null = null
    const onDown = (event: PointerEvent) => {
      const onControl = (event.target as Element | null)?.closest?.(INTERACTIVE)
      press =
        event.isPrimary && event.button === 0 && !onControl
          ? { id: event.pointerId, x: event.clientX, y: event.clientY }
          : null
    }
    const onUp = (event: PointerEvent) => {
      const start = press
      press = null
      if (!start || start.id !== event.pointerId) return
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX) return
      if (!(camera instanceof THREE.PerspectiveCamera)) return
      const rect = surface.getBoundingClientRect()
      camera.updateMatrixWorld()
      bodies.forEach((body, i) =>
        projectBody(body, camera, rect.width, rect.height, screen[i])
      )
      const key = pickBody(screen, event.clientX - rect.left, event.clientY - rect.top)
      if (key) setShipTarget(key)
    }
    const onCancel = () => {
      press = null
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
      if (event.key !== 't' && event.key !== 'T') return
      if (event.repeat || event.defaultPrevented) return
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (document.querySelector('dialog[open]')) return
      const target = event.target as Element | null
      if (target?.closest?.('input, select, textarea, [contenteditable="true"]')) return
      camera.updateMatrixWorld()
      setShipTarget(cycleTarget(bodies, camera, getShipTarget()))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [camera, bodies])

  // A target doesn't outlive the ship session.
  useEffect(() => () => setShipTarget(null), [])

  return null
}
