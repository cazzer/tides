// The tides demo's readout (tides-zec.4): a glass panel top-left of the main
// view led by the ideal tide at the red dot, then the Moon's and the Sun's
// tide-raising pull in units of the Moon's at its average distance, coloured
// as their arrows, the white arrows' key and the high–low range the two make
// together in real centimetres; last, muted, what the picture leaves out. Kept short so the
// Moon above Earth clears it on a phone. With aids.tidesSun off it is the
// Moon's alone, as the field is.
// Mounted in the main Panel's overlay while a demo runs (App.tsx); shown only
// while the step has aids.tides on. It re-renders once every ten sim
// minutes, through a bucketed store selector.
import styled from 'styled-components'
import { glassPanel } from '../glass-styles'
import { useStore } from '../store'
import { useDemoAid } from './demo-aids'
import { moonAlone, rangeMetres, spotTide, TIDE_EXAGGERATION, tidePulls, tidesSpot } from './tides'
import { TIDES_MOON_COLOR, TIDES_SUN_COLOR } from './tides-field'

const BUCKET_MS = 600_000
const MINUS = '−'

export function TidesReadout() {
  return useDemoAid('tides') ? <TidesReadoutLive /> : null
}

function TidesReadoutLive() {
  const location = useStore((s) => s.location)
  const withSun = useDemoAid('tidesSun')
  const bucket = useStore((s) => (s.timestamp == null ? null : Math.floor(s.timestamp / BUCKET_MS)))
  if (bucket == null) return null
  return <TidesReadoutView {...tidesSpot(location)} timestamp={bucket * BUCKET_MS} withSun={withSun} />
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

export interface TidesReadoutViewProps {
  lat: number
  lon: number
  pinned: boolean
  timestamp: number
  withSun: boolean
}

export function TidesReadoutView({ lat, lon, pinned, timestamp, withSun }: TidesReadoutViewProps) {
  const all = tidePulls(timestamp)
  const pulls = withSun ? all : moonAlone(all)
  const tide = spotTide(lat, lon, timestamp, withSun)
  return (
    <Panel aria-label="Tide-raising pull">
      <Lead>
        Tide at the red dot <Strong>{signed(tide * 100)} cm</Strong>
        {pinned && <Muted> · your pin</Muted>}
      </Lead>
      <Line>
        Pull <Moon>Moon {times(pulls.moon)}</Moon>
        {withSun && (
          <>
            {' '}
            · <Sun>Sun {times(pulls.sun)}</Sun> · <Strong>white: both</Strong>
          </>
        )}{' '}
        · range <Strong>{Math.round(rangeMetres(pulls.range) * 100)} cm</Strong>
      </Line>
      <Line>
        <Muted>
          Pull × the Moon’s average. Ideal all-ocean Earth, sea drawn ×{thousands.format(TIDE_EXAGGERATION)}; real
          coasts lag hours.
        </Muted>
      </Line>
    </Panel>
  )
}

// Where the dock's top row would be: it is hidden while a demo runs. Its
// type grows with the screen beside the demo caption's (tides-zec.15), and
// the box in ems with it.
const Panel = styled.section`
  position: absolute;
  top: var(--dock-top);
  left: var(--dock-inset-left);
  z-index: 1;
  box-sizing: border-box;
  max-width: min(30em, calc(100% - var(--dock-inset-left) - var(--dock-inset-right)));
  padding: 0.67em 1em;
  border-radius: 1.17em;
  color: rgba(255, 255, 255, 0.85);
  font-size: clamp(12px, 1.1vw, 18px);
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

// The tide at the spot, the payoff, larger than the rest.
const Lead = styled.p`
  margin: 0 0 2px;
  font-size: 1.25em;
`

const Moon = styled.span`
  font-weight: 600;
  color: ${TIDES_MOON_COLOR};
`

const Sun = styled.span`
  font-weight: 600;
  color: ${TIDES_SUN_COLOR};
`
