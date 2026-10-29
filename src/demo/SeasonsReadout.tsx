// The seasons demo's sunlight readout (tides-zec.3): a glass panel top-left
// of the main view with the day's length at the user's pin (or 45°N without
// one), bars for how much the tilt and the distance to the Sun change its
// sunlight, and how high the noon Sun gets. Mounted in the main
// Panel's overlay while a demo runs (App.tsx); shown only while the step has
// aids.seasons on. It re-renders once a sim hour, through a bucketed store
// selector.
import styled from 'styled-components'
import { glassPanel } from '../glass-styles'
import { useStore } from '../store'
import { useDemoAid } from './demo-aids'
import { insolation, seasonsLatitude, SUNRISE_ALTITUDE, sunForSeasons } from './seasons'

const HOUR_MS = 3_600_000
const MINUS = '−'

export function SeasonsReadout() {
  return useDemoAid('seasons') ? <SeasonsReadoutLive /> : null
}

function SeasonsReadoutLive() {
  const location = useStore((s) => s.location)
  const hour = useStore((s) => (s.timestamp == null ? null : Math.floor(s.timestamp / HOUR_MS)))
  if (hour == null) return null
  return <SeasonsReadoutView {...seasonsLatitude(location)} timestamp={hour * HOUR_MS} />
}

/** A signed number with a true minus sign, and never "−0". */
function signed(value: number, digits = 0): string {
  const text = Math.abs(value).toFixed(digits)
  if (Number(text) === 0) return text
  return (value < 0 ? MINUS : '+') + text
}

function latitudeText(lat: number): string {
  const text = Math.abs(lat).toFixed(1)
  if (Number(text) === 0) return 'the equator'
  return `${text}°${lat > 0 ? 'N' : 'S'}`
}

function noonText(altitude: number): string {
  if (altitude < SUNRISE_ALTITUDE) return 'Noon Sun below the horizon'
  if (altitude < 0.5) return 'Noon Sun on the horizon'
  return `Noon Sun ${Math.round(altitude)}° up`
}

function daylightText(hours: number): string {
  if (hours >= 24) return '24 h of daylight (Sun up all day)'
  if (hours <= 0) return '0 h of daylight (Sun down all day)'
  // Never "24 h 0 min" for a day just short of it, nor "0 h 0 min".
  const minutes = Math.min(24 * 60 - 1, Math.max(1, Math.round(hours * 60)))
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min of daylight`
}

interface ShareBarProps {
  label: string
  /** A fraction (0.63 is +63%); null when there is nothing to compare with. */
  share: number | null
  digits: number
}

/** A share's bar from the centre line, right for more and left for less,
 * at one scale for both (100% fills a side), and its signed percent. */
function ShareBar({ label, share, digits }: ShareBarProps) {
  const text = share == null ? null : signed(share * 100, digits)
  // As shown, so a share that reads 0% draws no bar.
  const amount = share == null ? 0 : Math.min(1, Number(Math.abs(share * 100).toFixed(digits)) / 100)
  const side = share != null && share < 0 ? 'less' : 'more'
  return (
    <Row>
      <dt>{label}</dt>
      <Track aria-hidden="true">
        {amount > 0 && <Bar data-side={side} style={{ width: `${amount * 50}%` }} />}
      </Track>
      <dd>{text == null ? '—' : `${text}%`}</dd>
    </Row>
  )
}

export interface SeasonsReadoutViewProps {
  lat: number
  pinned: boolean
  timestamp: number
}

export function SeasonsReadoutView({ lat, pinned, timestamp }: SeasonsReadoutViewProps) {
  const sun = sunForSeasons(timestamp)
  const q = insolation(lat, sun.dec, sun.distanceAu)
  return (
    <Panel aria-label="Sunlight at this latitude">
      <Line>
        Sunlight at {latitudeText(lat)} <Muted>{pinned ? 'your pin' : 'example'}</Muted>
      </Line>
      <Daylight>{daylightText(q.daylightHours)}</Daylight>
      <Small>Compared with an equinox day</Small>
      <Shares>
        <ShareBar label="Tilt" share={q.tilt.percent} digits={0} />
        <ShareBar label="Distance" share={q.distance.percent} digits={1} />
      </Shares>
      <Small>{noonText(q.noonAltitude)}</Small>
      <Small $faint>Sizes and distances not to scale</Small>
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
  width: min(25em, calc(100% - var(--dock-inset-left) - var(--dock-inset-right)));
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
  margin-left: 4px;
  color: rgba(255, 255, 255, 0.55);
`

// The hook: how long the Sun is up.
const Daylight = styled.p`
  margin: 2px 0 6px;
  color: #fff;
  font-size: 1.33em;
  font-weight: 600;
`

const Small = styled.p<{ $faint?: boolean }>`
  margin: 4px 0 0;
  color: rgba(255, 255, 255, ${(p) => (p.$faint ? 0.45 : 0.6)});
  font-size: ${(p) => (p.$faint ? 0.83 : 0.92)}em;
`

// The demo's point: the tilt's share against the distance's, on one scale.
const Shares = styled.dl`
  display: grid;
  grid-template-columns: max-content 1fr 3.6em;
  align-items: center;
  column-gap: 8px;
  row-gap: 3px;
  margin: 3px 0 0;
  font-weight: 600;
  color: #fff;

  dt {
    font-weight: 500;
    color: rgba(255, 255, 255, 0.75);
  }

  dd {
    margin: 0;
    text-align: right;
  }
`

// A dt and its two dd's, laid on the list's grid.
const Row = styled.div`
  display: contents;
`

const Track = styled.dd`
  position: relative;
  height: 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);

  &::before {
    content: '';
    position: absolute;
    left: 50%;
    top: -2px;
    bottom: -2px;
    width: 1px;
    background: rgba(255, 255, 255, 0.45);
  }
`

// Warm for more sunlight, cool for less.
const Bar = styled.div`
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  min-width: 2px;
  border-radius: 0 4px 4px 0;
  background: #ffb347;

  &[data-side='less'] {
    right: 50%;
    left: auto;
    border-radius: 4px 0 0 4px;
    background: #6cb6ff;
  }
`
