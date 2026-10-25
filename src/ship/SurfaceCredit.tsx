import { useSyncExternalStore } from 'react'
import styled from 'styled-components'
import { SOURCE_TEXT, type SurfaceSource } from '../renderers/surface/credit-sources'
import { getActiveSurfaceSources, subscribeSurfaceSources } from '../renderers/surface/surface-credits'

/** The surface's credits (tides-zmw.9.9): only the sources whose tiles are on screen. */
export function SurfaceCredit() {
  const sources = useSyncExternalStore(subscribeSurfaceSources, getActiveSurfaceSources, getActiveSurfaceSources)
  return <SurfaceCreditLine sources={sources} />
}

export function SurfaceCreditLine({ sources }: { sources: readonly SurfaceSource[] }) {
  if (sources.length === 0) return null
  return (
    <Line data-surface-credit>
      {sources.map((s) => SOURCE_TEXT[s]).join(' \u00b7 ')}
    </Line>
  )
}

// The top-right corner, which ShipHud's strip leaves free (its CREDIT_ROOM,
// 262px with the inset): on a phone that is the exit and help buttons' row,
// 40px tall, so the text is clamped to what fits there. Names, never takes taps.
const Line = styled.p`
  position: absolute;
  top: calc(var(--dock-top) + (var(--dock-height) - var(--dock-button-size, 40px)) / 2);
  right: var(--dock-inset-right);
  box-sizing: border-box;
  width: 246px;
  max-width: calc(100% - var(--dock-inset-left) - var(--dock-inset-right) - 2 * (var(--dock-button-size, 40px) + 8px) - 8px);
  max-height: var(--dock-button-size, 40px);
  margin: 0;
  overflow: hidden;
  font-size: 9px;
  line-height: 11px;
  text-align: right;
  color: rgba(255, 255, 255, 0.6);
  text-shadow:
    0 0 2px #000,
    0 1px 3px #000;
  pointer-events: none;
  z-index: 1;
`
