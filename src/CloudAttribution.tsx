import { useId } from 'react'
import type * as THREE from 'three'
import { shownFrame, type CloudStatus } from './cloud-frames'
import { OPEN_METEO_SITE } from './forecast-clouds'
import { isLatestStandIn, MODIS_FROM, utcDayKey, type CloudSource, type GibsSource } from './real-clouds'
import { useStore } from './store'
import { useRealCloudSnapshot, type GeoTextureInfo } from './renderers/realCloudTextures'

const GIBS_URL = 'https://earthdata.nasa.gov/gibs'
// Wording requested by the GIBS documentation.
const ACKNOWLEDGEMENT =
  "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)."

type StoreState = ReturnType<typeof useStore.getState>
const simTime = (s: StoreState) => (s.timestamp == null ? null : (s.jumpDate?.getTime() ?? s.timestamp))

interface Described {
  source: CloudSource
  status: CloudStatus
  texture: THREE.Texture | null
}

/** Where the clouds on screen in Real weather come from: the loaded frame
 * nearer the sim time of the two being blended (tides-kzj.4.4), or, before
 * any has loaded, the one being fetched. Mount only in Real mode. */
export function CloudAttribution() {
  const { frames, source, status, texture } = useRealCloudSnapshot()
  // A key, so the per-frame timestamp only re-renders when the frame changes.
  const shownKey = useStore((s) => {
    const sim = simTime(s)
    return sim == null ? null : (shownFrame(frames, sim)?.key ?? null)
  })
  const shown = frames.find((f) => f.key === shownKey) ?? null
  const described: Described | null = shown ?? (source && { source, status, texture })
  // Credited whenever forecast data is on screen, not only as the nearer
  // frame, unless a frame only holds the latest observation for want of it.
  const forecast = frames.some(
    (f) => f.source.kind === 'forecast' && f.status === 'ready' && !f.texture?.userData.held
  )
  // Only while nothing loaded is on screen: frames turning over during fast
  // playback aren't worth a flicker.
  const loading = !shown && (frames.length === 0 || frames.some((f) => f.status === 'loading'))
  return (
    <p className="cloud-attribution">
      Clouds:{' '}
      {described && (
        <CloudSourceText
          source={described.source}
          status={described.status}
          texture={described.texture}
        />
      )}
      {loading && (described ? ' · loading…' : 'loading…')}
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

function CloudSourceText({ source, status, texture }: Described) {
  const acknowledgementId = useId()
  // A boolean, so the per-frame timestamp only re-renders when it flips.
  const latest = useStore((s) => {
    const sim = simTime(s)
    return sim != null && isLatestStandIn(source, sim, Date.now())
  })
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
  const geo =
    source.kind === 'geo' && status === 'ready'
      ? (texture?.userData.geo as GeoTextureInfo | null | undefined)
      : null
  const observedLabel =
    observed.kind === 'geo' ? slotLabel(observed.time) : `${instrument(daily)} ${daily.date}`
  const held = source.kind === 'forecast' && status === 'ready' && Boolean(texture?.userData.held)
  const what =
    source.kind === 'forecast'
      ? held
        ? `${observedLabel} (no forecast)`
        : `forecast ${slotLabel(source.time)} from ${observedLabel}`
      : geo
        ? `${geo.satellites.join(', ')} ${slotLabel(geo.time)} + ${instrument(daily)} ${daily.date}`
        : source.kind === 'geo'
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
