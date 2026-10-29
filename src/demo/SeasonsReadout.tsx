// The seasons demo's sunlight readout (tides-zec.3): a glass panel top-left
// of the main view with the noon Sun, the day's length and the sunlight at
// the user's pin (or 45°N without one), and how much of it the tilt and the
// distance to the Sun account for. Mounted in the main Panel's overlay while
// a demo runs (App.tsx); shown only while the step has aids.seasons on.
// It re-renders once a sim hour, through a bucketed store selector.
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

/** A share as a percent and its W/m²; a percent that rounds to 0 shows 0
 * W/m² too, so the two never disagree in sign. */
function share(percent: number | null, wm2: number, digits: number): { percent: string; wm2: string } {
  if (percent == null) return { percent: '', wm2: `${signed(wm2)} W/m²` }
  const p = signed(percent * 100, digits)
  return { percent: `${p}%`, wm2: `(${Number(p) === 0 ? '0' : signed(wm2)} W/m²)` }
}

function latitudeText(lat: number): string {
  const text = Math.abs(lat).toFixed(1)
  if (Number(text) === 0) return `${text}° · on the equator`
  return lat > 0 ? `${text}°N · northern hemisphere` : `${text}°S · southern hemisphere`
}

function noonText(altitude: number): string {
  if (altitude < SUNRISE_ALTITUDE) return 'Noon Sun below the horizon'
  if (altitude < 0.5) return 'Noon Sun on the horizon'
  return `Noon Sun ${Math.round(altitude)}° up`
}

function daylightText(hours: number): string {
  if (hours >= 24) return 'daylight 24 h (Sun up all day)'
  if (hours <= 0) return 'daylight 0 h (Sun down all day)'
  // Never "24 h 0 min" for a day just short of it, nor "0 h 0 min".
  const minutes = Math.min(24 * 60 - 1, Math.max(1, Math.round(hours * 60)))
  return `daylight ${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

function noonSunlightText(altitude: number, top: number, ground: number): string {
  if (altitude < SUNRISE_ALTITUDE) return 'No sunlight at noon'
  if (top <= 0) return 'At noon the Sun only skims the horizon'
  const through = Math.round((100 * ground) / top)
  return `At noon ${Math.round(top)} W/m² in space · ${Math.round(ground)} at the ground (${through}% gets through)`
}

export interface SeasonsReadoutViewProps {
  lat: number
  pinned: boolean
  timestamp: number
}

export function SeasonsReadoutView({ lat, pinned, timestamp }: SeasonsReadoutViewProps) {
  const sun = sunForSeasons(timestamp)
  const q = insolation(lat, sun.dec, sun.distanceAu)
  const tilt = share(q.tilt.percent, q.tilt.wm2, 0)
  const distance = share(q.distance.percent, q.distance.wm2, 1)
  return (
    <Panel aria-label="Sunlight at this latitude">
      <Line>
        Sunlight at {latitudeText(lat)}
        <Muted>{pinned ? ' (your pin)' : ' (example, no pin)'}</Muted>
      </Line>
      <Line>
        {noonText(q.noonAltitude)} · {daylightText(q.daylightHours)}
      </Line>
      <Line>{noonSunlightText(q.noonAltitude, q.noonTop, q.noonGround)}</Line>
      <Line>Day’s average {Math.round(q.dailyTop)} W/m² in space</Line>
      <Compare>
        <Line>Against an equinox day at average distance:</Line>
        <Shares>
          <dt>tilt</dt>
          <dd>{tilt.percent}</dd>
          <dd>{tilt.wm2}</dd>
          <dt>distance</dt>
          <dd>{distance.percent}</dd>
          <dd>{distance.wm2}</dd>
        </Shares>
      </Compare>
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

// The demo's point, set off: the tilt's share against the distance's.
const Compare = styled.div`
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.18);
`

const Shares = styled.dl`
  display: grid;
  grid-template-columns: max-content max-content 1fr;
  column-gap: 8px;
  margin: 2px 0 0 12px;
  font-weight: 600;
  color: #fff;

  dt {
    font-weight: 500;
    color: rgba(255, 255, 255, 0.75);
  }

  dd {
    margin: 0;
  }
`
