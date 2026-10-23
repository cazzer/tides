import { useId, type ReactNode } from 'react'
import styled from 'styled-components'
import { OPEN_METEO_SITE } from './forecast-clouds'

export const GIBS_URL = 'https://earthdata.nasa.gov/gibs'
// Wording requested by the GIBS documentation.
export const GIBS_ACKNOWLEDGEMENT =
  "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)."
const SOLAR_SYSTEM_SCOPE_URL = 'https://www.solarsystemscope.com/textures/'
const CC_BY_URL = 'https://creativecommons.org/licenses/by/4.0/'
const STELLARIUM_URL = 'https://github.com/Stellarium/stellarium/tree/master/skycultures/modern'
const FREE_ART_LICENSE_URL = 'https://artlibre.org/licence/lal/en/'

/** Every source the scene draws from (tides-1qv), for the settings panel
 * rather than over the views. `children` adds live lines, as list items. */
export function Credits({ children }: { children?: ReactNode }) {
  const acknowledgementId = useId()
  return (
    <CreditList>
      <li>
        Satellite clouds and ground imagery:{' '}
        <Link
          href={GIBS_URL}
          title={GIBS_ACKNOWLEDGEMENT}
          aria-describedby={acknowledgementId}
        >
          NASA GIBS/ESDIS
        </Link>
        <span
          id={acknowledgementId}
          className="visually-hidden"
        >
          {GIBS_ACKNOWLEDGEMENT}
        </span>
        {' · Blue Marble Next Generation'}
      </li>
      <li>
        Cloud forecasts: <Link href={OPEN_METEO_SITE}>Weather data by Open-Meteo.com</Link>
      </li>
      <li>
        Planet textures: <Link href={SOLAR_SYSTEM_SCOPE_URL}>Solar System Scope</Link> (
        <Link
          href={CC_BY_URL}
          title="Creative Commons Attribution 4.0 International"
        >
          CC BY 4.0
        </Link>
        )
      </li>
      <li>
        Constellation art: Johan Meuris for <Link href={STELLARIUM_URL}>Stellarium</Link> (
        <Link href={FREE_ART_LICENSE_URL}>Free Art License</Link>)
      </li>
      {children}
    </CreditList>
  )
}

function Link(props: { href: string; title?: string; 'aria-describedby'?: string; children: ReactNode }) {
  return (
    <a
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  )
}

// The settings hint's type, as a list.
const CreditList = styled.ul`
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  color: #888;
  overflow-wrap: anywhere;

  a {
    color: inherit;
  }

  a:hover {
    color: #bbb;
  }
`
