// The seasons demo's sunlight readout (tides-zec.3): a glass panel top-left
// of the main view with the noon Sun, the day's length and the sunlight at
// the user's pin (or 45°N without one), and how much of it the tilt and the
// distance to the Sun account for. Mounted in the main Panel's overlay while
// a demo runs (App.tsx); shown only while the step has aids.seasons on.
// It re-renders once a sim hour, through a bucketed store selector.
import styled from 'styled-components'
import { glassPanel, PHONE } from '../glass-styles'
import { useStore } from '../store'
import { useDemoAid } from './demo-aids'
import { insolation, seasonsLatitude, sunForSeasons } from './seasons'

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
  if (Number(text) === 0) return `${text}° · on the equator`
  return lat > 0 ? `${text}°N · northern hemisphere` : `${text}°S · southern hemisphere`
}

function daylightText(hours: number): string {
  if (hours >= 24) return 'daylight 24 h (Sun up all day)'
  if (hours <= 0) return 'daylight 0 h (Sun down all day)'
  const minutes = Math.round(hours * 60)
  return `daylight ${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

export interface SeasonsReadoutViewProps {
  lat: number
  pinned: boolean
  timestamp: number
}

export function SeasonsReadoutView({ lat, pinned, timestamp }: SeasonsReadoutViewProps) {
  const sun = sunForSeasons(timestamp)
  const q = insolation(lat, sun.dec, sun.distanceAu)
  const noon =
    q.noonAltitude > 0 ? `Noon Sun ${Math.round(q.noonAltitude)}° up` : 'Noon Sun below the horizon'
  const tilt =
    q.tilt.percent == null
      ? `${signed(q.tilt.wm2)} W/m²`
      : `${signed(q.tilt.percent * 100)}% (${signed(q.tilt.wm2)} W/m²)`
  return (
    <Panel aria-label="Sunlight at this latitude">
      <Line>
        {latitudeText(lat)}
        <Muted>{pinned ? ' (your pin)' : ' (example; no pin set)'}</Muted>
      </Line>
      <Line>
        {noon} · {daylightText(q.daylightHours)}
      </Line>
      <Line>
        Noon sunlight {Math.round(q.noonTop)} W/m² above the air, {Math.round(q.noonGround)} at the ground
      </Line>
      <Line>Day’s average above the air {Math.round(q.dailyTop)} W/m²</Line>
      <Line>Tilt vs equinox {tilt}</Line>
      <Line>
        Distance {sun.distanceAu.toFixed(4)} AU: {signed(q.distance.percent * 100, 1)}% (
        {signed(q.distance.wm2)} W/m²)
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
  max-width: min(300px, calc(100% - var(--dock-inset-left) - var(--dock-inset-right)));
  padding: 8px 12px;
  border-radius: 14px;
  color: rgba(255, 255, 255, 0.85);
  font-size: 12px;
  line-height: 1.35;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  ${glassPanel}

  ${PHONE} {
    font-size: 11px;
  }
`

const Line = styled.p`
  margin: 0;
`

const Muted = styled.span`
  color: rgba(255, 255, 255, 0.55);
`
