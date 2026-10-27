import { useEffect, useRef } from 'react'
import styled from 'styled-components'
import { MAX_DT } from './flight'
import { shipTelemetry } from './ship-telemetry'
import { prefersReducedMotion } from './reduced-motion'
import { sweepRate } from '../renderers/surface/surface-lod'
import { blurFilter, blurTarget, easeBlur } from './speed-blur'

/**
 * The speed blur (tides-5lj, speed-blur.ts): a soft blur round the edges of
 * the ship view while the boost raises the cap low over Earth, scaling with
 * the spool and the ground's sweep, so coarse or late tiles read as speed.
 * Off under prefers-reduced-motion, and hidden (no filter at all) whenever
 * it rounds to 0. It sits outside drei's View, so it runs its own rAF loop
 * as the HUD does, and touches the DOM only when the drawn blur changes.
 * Decorative: hidden from assistive tech, and it never takes the pointer.
 */
export function SpeedBlur() {
  const layer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = layer.current
    if (!element) return
    let frame = 0
    let last = NaN
    let px = 0
    let shown = 'none'
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      const dt = Number.isFinite(last) ? Math.min(Math.max(0, now - last) / 1000, MAX_DT) : 0
      last = now
      // The sweep the tiles coarsen with (SurfaceTiles), through the air.
      const sweep = sweepRate(shipTelemetry.air.speed, shipTelemetry.nearest)
      // Reduced motion cuts it at once rather than easing it out.
      px = prefersReducedMotion() ? 0 : easeBlur(px, blurTarget(sweep, shipTelemetry.boost, shipTelemetry.boosted), dt)
      const filter = blurFilter(px)
      if (filter === shown) return
      shown = filter
      element.style.setProperty('backdrop-filter', filter)
      element.style.setProperty('-webkit-backdrop-filter', filter)
      element.style.visibility = filter === 'none' ? 'hidden' : 'visible'
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <Layer
      ref={layer}
      aria-hidden="true"
    />
  )
}

// Clear over the middle, where the pilot looks, full by the edges.
const EDGE_MASK = 'radial-gradient(ellipse at center, transparent 40%, #000 90%)'

const Layer = styled.div`
  position: absolute;
  inset: 0;
  pointer-events: none;
  visibility: hidden;
  -webkit-mask-image: ${EDGE_MASK};
  mask-image: ${EDGE_MASK};
`
