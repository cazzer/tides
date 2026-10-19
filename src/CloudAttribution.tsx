import { useId } from 'react'
import { MODIS_FROM, utcDayKey } from './real-clouds'
import { useRealCloudSnapshot, type RealCloudSnapshot } from './renderers/realCloudTextures'

const GIBS_URL = 'https://earthdata.nasa.gov/gibs'
// Wording requested by the GIBS documentation.
const ACKNOWLEDGEMENT =
  "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)."

/** Where the clouds in Real weather come from. Mount only in Real mode. */
export function CloudAttribution() {
  const snapshot = useRealCloudSnapshot()
  const { source, status } = snapshot
  return (
    <p className="cloud-attribution">
      Clouds: <CloudSourceText snapshot={snapshot} />
      {status === 'loading' && (source ? ' · loading…' : 'loading…')}
    </p>
  )
}

function CloudSourceText({ snapshot: { source, status } }: { snapshot: RealCloudSnapshot }) {
  const acknowledgementId = useId()
  if (!source) return null
  if (source.kind === 'static') {
    return source.reason === 'before-coverage'
      ? <>simulated (before {utcDayKey(MODIS_FROM)})</>
      : <>simulated (no imagery yet)</>
  }
  const instrument = source.layer.split('_')[0]
  if (status === 'failed') {
    return <>simulated ({instrument} {source.date} unavailable)</>
  }
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
      {` · ${instrument} ${source.date}`}
    </>
  )
}
