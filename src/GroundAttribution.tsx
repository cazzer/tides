import { useId, type CSSProperties } from 'react'
import { GIBS_ACKNOWLEDGEMENT, GIBS_URL } from './CloudAttribution'
import { useGibsPatchShown } from './renderers/gibsPatch'

/** Credits the GIBS imagery under the ship (tides-01v.7) while any shows.
 * `slot`: how many credits stack above it. */
export function GroundAttribution({ slot }: { slot: number }) {
  const acknowledgementId = useId()
  if (!useGibsPatchShown()) return null
  return (
    <p
      className="planet-attribution ground-attribution"
      style={{ '--attribution-slot': slot } as CSSProperties}
    >
      Ground imagery:{' '}
      <a
        href={GIBS_URL}
        target="_blank"
        rel="noreferrer"
        title={GIBS_ACKNOWLEDGEMENT}
        aria-describedby={acknowledgementId}
      >
        NASA GIBS/ESDIS
      </a>
      <span
        id={acknowledgementId}
        className="visually-hidden"
      >
        {GIBS_ACKNOWLEDGEMENT}
      </span>
      {' · Blue Marble Next Generation'}
    </p>
  )
}
