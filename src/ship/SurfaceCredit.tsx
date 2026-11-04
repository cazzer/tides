import { useSyncExternalStore } from 'react'
import styled, { css } from 'styled-components'
import { creditLine, type SurfaceSource } from '../renderers/surface/credit-sources'
import { getActiveSurfaceSources, subscribeSurfaceSources } from '../renderers/surface/surface-credits'

/** The surface's credits (tides-zmw.9.9): only the sources whose tiles are
 * on screen. `stacked`: in SurfaceCreditCorner, which places it. */
export function SurfaceCredit({ stacked = false }: { stacked?: boolean }) {
  const sources = useSyncExternalStore(subscribeSurfaceSources, getActiveSurfaceSources, getActiveSurfaceSources)
  return <SurfaceCreditLine sources={sources} stacked={stacked} />
}

export function SurfaceCreditLine({ sources, stacked = false }: { sources: readonly SurfaceSource[]; stacked?: boolean }) {
  if (sources.length === 0) return null
  return (
    <Line
      data-surface-credit
      $stacked={stacked}
    >
      {creditLine(sources)}
    </Line>
  )
}

// The top-right corner, which ShipHud's strip leaves free (its CREDIT_ROOM,
// 262px with the inset): on a phone that is the exit and help buttons' row,
// 40px tall plus the 8px gap above the strip: four lines of 11px fit in that
// without clipping (credit-sources.test.ts holds the text to that budget). Names, never takes taps.
const CORNER = css`
  position: absolute;
  top: calc(var(--dock-top) + (var(--dock-height) - var(--dock-button-size, 40px)) / 2);
  right: var(--dock-inset-right);
  box-sizing: border-box;
  width: 246px;
  max-width: calc(100% - var(--dock-inset-left) - var(--dock-inset-right) - 2 * (var(--dock-button-size, 40px) + 8px) - 8px);
  pointer-events: none;
  z-index: 1;
`

/** The credit's corner, for the credit (stacked) and the lines under it:
 * ship mode's sea ice note (tides-6ru.2). */
export const SurfaceCreditCorner = styled.div`
  ${CORNER}
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
`

const Line = styled.p<{ $stacked: boolean }>`
  ${({ $stacked }) => ($stacked ? '' : CORNER)}
  margin: 0;
  font-size: 10px;
  line-height: 11px;
  text-align: right;
  color: rgba(255, 255, 255, 0.78);
  text-shadow:
    0 0 2px #000,
    0 1px 3px #000;
  pointer-events: none;
`
