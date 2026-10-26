import type * as THREE from 'three'
import { shownFrame, type CloudStatus } from './cloud-frames'
import { isLatestStandIn, MODIS_FROM, utcDayKey, type CloudSource, type GibsSource } from './real-clouds'
import { useStore } from './store'
import { useRealCloudSnapshot, type GeoTextureInfo } from './renderers/realCloudTextures'

type StoreState = ReturnType<typeof useStore.getState>
const simTime = (s: StoreState) => (s.timestamp == null ? null : (s.jumpDate?.getTime() ?? s.timestamp))

interface Described {
  source: CloudSource
  status: CloudStatus
  texture: THREE.Texture | null
}

/** Which clouds Real weather shows, as a credits line in settings
 * (tides-1qv): the loaded frame nearer the sim time of the two being blended
 * (tides-kzj.4.4), or, before any has loaded, the one being fetched. Mount
 * only in Real mode. */
export function CloudsShown() {
  const { frames, source, status, texture } = useRealCloudSnapshot()
  // A key, so the per-frame timestamp only re-renders when the frame changes.
  const shownKey = useStore((s) => {
    const sim = simTime(s)
    return sim == null ? null : (shownFrame(frames, sim)?.key ?? null)
  })
  const shown = frames.find((f) => f.key === shownKey) ?? null
  const described: Described | null = shown ?? (source && { source, status, texture })
  // Only while nothing loaded is on screen: frames turning over during fast
  // playback aren't worth a flicker.
  const loading = !shown && (frames.length === 0 || frames.some((f) => f.status === 'loading'))
  return (
    <li>
      Clouds on screen:{' '}
      {described && (
        <CloudSourceText
          source={described.source}
          status={described.status}
          texture={described.texture}
        />
      )}
      {loading && (described ? ' · loading…' : 'loading…')}
    </li>
  )
}

const instrument = (source: GibsSource) => source.layer.split('_')[0]

/** 2026-10-18T18:00:00Z -> 2026-10-18 18:00 UTC */
const slotLabel = (time: string) => `${time.slice(0, 10)} ${time.slice(11, 16)} UTC`

function CloudSourceText({ source, status, texture }: Described) {
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
  // The frame's cloud types (tides-tvr.4.1), which the clouds are drawn by
  // (tides-tvr.4.2), come from Open-Meteo's layers, credited (with the link
  // the licence asks for) a few lines up.
  const typed = status === 'ready' && Boolean(texture?.userData.types)
  return <>{`NASA GIBS/ESDIS · ${what}${latest ? ' (latest)' : ''}${typed ? ' · types: Open-Meteo' : ''}`}</>
}
