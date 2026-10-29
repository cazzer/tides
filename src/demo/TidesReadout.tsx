// The tides demo's readout (tides-zec.4): a glass panel top-left of the main
// view with the Moon's and the Sun's tide-raising pull in units of the
// Moon's at its average distance, the high–low range they make together (in
// those units and in real centimetres), the ideal tide at the red dot and the
// shell's exaggeration.
// Mounted in the main Panel's overlay while a demo runs (App.tsx); shown only
// while the step has aids.tides on. It re-renders once every ten sim
// minutes, through a bucketed store selector.
import styled from 'styled-components'
import { glassPanel } from '../glass-styles'
import { useStore } from '../store'
import { useDemoAid } from './demo-aids'
import { rangeMetres, spotTide, TIDE_EXAGGERATION, tidePulls, tidesSpot } from './tides'

const BUCKET_MS = 600_000
const MINUS = '−'

export function TidesReadout() {
  return useDemoAid('tides') ? <TidesReadoutLive /> : null
}

function TidesReadoutLive() {
  const location = useStore((s) => s.location)
  const bucket = useStore((s) => (s.timestamp == null ? null : Math.floor(s.timestamp / BUCKET_MS)))
  if (bucket == null) return null
  return <TidesReadoutView {...tidesSpot(location)} timestamp={bucket * BUCKET_MS} />
}

const thousands = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })

/** A signed whole number with a true minus sign, and never "−0". */
function signed(value: number): string {
  const rounded = Math.round(value)
  if (rounded === 0) return '0'
  return (rounded < 0 ? MINUS : '+') + Math.abs(rounded)
}

function times(value: number): string {
  return `${value.toFixed(2)}×`
}

function spotText(lat: number, lon: number, pinned: boolean): string {
  if (pinned) return 'your pin'
  const where = Math.abs(lat) < 0.05 ? 'equator' : `${Math.abs(lat).toFixed(1)}°${lat < 0 ? 'S' : 'N'}`
  return `example: ${where} ${Math.abs(lon).toFixed(1)}°${lon < 0 ? 'W' : 'E'}`
}

export interface TidesReadoutViewProps {
  lat: number
  lon: number
  pinned: boolean
  timestamp: number
}

export function TidesReadoutView({ lat, lon, pinned, timestamp }: TidesReadoutViewProps) {
  const pulls = tidePulls(timestamp)
  const tide = spotTide(lat, lon, timestamp)
  return (
    <Panel aria-label="Tide-raising pull">
      <Line>
        Tide-raising pull, <Muted>× the Moon’s average</Muted>
      </Line>
      <Line>
        Moon <Strong>{times(pulls.moon)}</Strong> <Muted>({thousands.format(pulls.moonKm)} km)</Muted> · Sun{' '}
        <Strong>{times(pulls.sun)}</Strong>
      </Line>
      <Line>
        High–low range <Strong>{times(pulls.range)}</Strong> · <Strong>{Math.round(rangeMetres(pulls.range) * 100)} cm</Strong>
      </Line>
      <Spot>
        Ideal tide at the red dot <Strong>{signed(tide * 100)} cm</Strong> <Muted>· {spotText(lat, lon, pinned)}</Muted>
      </Spot>
      <Line>
        <Muted>Bulge drawn ×{thousands.format(TIDE_EXAGGERATION)}</Muted>
      </Line>
    </Panel>
  )
}

// Where the dock's top row would be: it is hidden while a demo runs.
const Panel = styled.section`
  position: absolute;
  top: var(--dock-top);
  left: var(--dock-inset-left);
  z-index: 1;
  box-sizing: border-box;
  max-width: min(360px, calc(100% - var(--dock-inset-left) - var(--dock-inset-right)));
  padding: 8px 12px;
  border-radius: 14px;
  color: rgba(255, 255, 255, 0.85);
  font-size: 12px;
  line-height: 1.35;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  ${glassPanel}
`

const Line = styled.p`
  margin: 0;
`

const Muted = styled.span`
  color: rgba(255, 255, 255, 0.55);
`

const Strong = styled.span`
  font-weight: 600;
  color: #fff;
`

// The spot's tide, set off from the pulls above it.
const Spot = styled.p`
  margin: 6px 0 0;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.18);
`
