import { useId } from 'react'
import { OPEN_METEO_SITE } from './forecast-clouds'
import { isLatestStandIn, MODIS_FROM, utcDayKey, type GibsSource } from './real-clouds'
import { useStore } from './store'
import {
  useRealCloudSnapshot,
  type GeoTextureInfo,
  type RealCloudSnapshot,
} from './renderers/realCloudTextures'

const GIBS_URL = 'https://earthdata.nasa.gov/gibs'
// Wording requested by the GIBS documentation.
const ACKNOWLEDGEMENT =
  "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)."

/** Where the clouds in Real weather come from. Mount only in Real mode. */
export function CloudAttribution() {
  const snapshot = useRealCloudSnapshot()
  const { source, status } = snapshot
  // Credited whenever a forecast is on screen, not only as the primary frame.
  const forecast = snapshot.frames.some((f) => f.source.kind === 'forecast' && f.status === 'ready')
  return (
    <p className="cloud-attribution">
      Clouds: <CloudSourceText snapshot={snapshot} />
      {status === 'loading' && (source ? ' · loading…' : 'loading…')}
      {forecast && (
        <>
          {' · '}
          <a
            href={OPEN_METEO_SITE}
            target="_blank"
            rel="noreferrer"
          >
            Weather data by Open-Meteo.com
          </a>
        </>
      )}
    </p>
  )
}

const instrument = (source: GibsSource) => source.layer.split('_')[0]

/** 2026-10-18T18:00:00Z -> 2026-10-18 18:00 UTC */
const slotLabel = (time: string) => `${time.slice(0, 10)} ${time.slice(11, 16)} UTC`

function CloudSourceText({ snapshot: { source, status, texture } }: { snapshot: RealCloudSnapshot }) {
  const acknowledgementId = useId()
  // A boolean, so the per-frame timestamp only re-renders when it flips.
  const latest = useStore(
    (s) =>
      s.timestamp != null &&
      isLatestStandIn(source, s.jumpDate?.getTime() ?? s.timestamp, Date.now())
  )
  if (!source) return null
  if (source.kind === 'static') {
    return source.reason === 'before-coverage'
      ? <>simulated (before {utcDayKey(MODIS_FROM)})</>
      : <>simulated (no imagery yet)</>
  }
  // A forecast evolves the latest observation, which is GIBS imagery too.
  const observed = source.kind === 'forecast' ? source.base : source
  const daily = observed.kind === 'geo' ? observed.fallback : observed
  if (status === 'failed') {
    const what =
      source.kind === 'forecast'
        ? `forecast ${slotLabel(source.time)}`
        : source.kind === 'geo'
          ? slotLabel(source.time)
          : `${instrument(daily)} ${daily.date}`
    return <>simulated ({what} unavailable)</>
  }
  // Geostationary satellites where they see, the daily composite elsewhere.
  // While loading, the texture is still the previous source's.
  const geo =
    source.kind === 'geo' && status === 'ready'
      ? (texture?.userData.geo as GeoTextureInfo | null | undefined)
      : null
  const what =
    source.kind === 'forecast'
      ? `forecast ${slotLabel(source.time)} from ${
          observed.kind === 'geo' ? slotLabel(observed.time) : `${instrument(daily)} ${daily.date}`
        }`
      : geo
        ? `${geo.satellites.join(', ')} ${slotLabel(geo.time)} + ${instrument(daily)} ${daily.date}`
        : source.kind === 'geo' && status === 'loading'
          ? slotLabel(source.time)
          : `${instrument(daily)} ${daily.date}`
  return (
    <>
      <a
        href={GIBS_URL}
        target="_blank"
        rel="noreferrer"
        title={ACKNOWLEDGEMENT}
        aria-describedby={acknowledgementId}
      >
        NASA GIBS/ESDIS
      </a>
      <span
        id={acknowledgementId}
        className="visually-hidden"
      >
        {ACKNOWLEDGEMENT}
      </span>
      {` · ${what}${latest ? ' (latest)' : ''}`}
    </>
  )
}
