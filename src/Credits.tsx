import { useId, type ReactNode } from 'react'
import styled from 'styled-components'
import { OPEN_METEO_SITE } from './forecast-clouds'
import { EOX_CREDIT, USGS_CREDIT } from './renderers/surface/credit-sources'

export const GIBS_URL = 'https://earthdata.nasa.gov/gibs'
// Wording requested by the GIBS documentation.
export const GIBS_ACKNOWLEDGEMENT =
  "We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)."
export const USGS_URL = 'https://www.usgs.gov/programs/national-geospatial-program/national-map'
export const EOX_URL = 'https://s2maps.eu/'
const CC_BY_NC_SA_URL = 'https://creativecommons.org/licenses/by-nc-sa/4.0/'
const SOLAR_SYSTEM_SCOPE_URL = 'https://www.solarsystemscope.com/textures/'
const CC_BY_URL = 'https://creativecommons.org/licenses/by/4.0/'
const STELLARIUM_URL = 'https://github.com/Stellarium/stellarium/tree/master/skycultures/modern'
const FREE_ART_LICENSE_URL = 'https://artlibre.org/licence/lal/en/'
export const MAPTERHORN_URL = 'https://mapterhorn.com/'
// Zoom 4 mixes Copernicus GLO-30 with national CC BY DEMs, each listed there.
export const MAPTERHORN_ATTRIBUTION_URL = 'https://mapterhorn.com/attribution/'
// Wording required by the Copernicus DEM licence.
export const COPERNICUS_DEM_NOTICE =
  '© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved'

/** Every source the scene draws from (tides-1qv), for the settings panel
 * rather than over the views. `children` adds live lines, as list items. */
export function Credits({ children }: { children?: ReactNode }) {
  const acknowledgementId = useId()
  const copernicusId = useId()
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
        {' · Blue Marble Next Generation, VIIRS City Lights 2012'}
      </li>
      <li>
        Terrain: <Link href={MAPTERHORN_URL}>Mapterhorn</Link>,{' '}
        <Link
          href={MAPTERHORN_ATTRIBUTION_URL}
          title={COPERNICUS_DEM_NOTICE}
          aria-describedby={copernicusId}
        >
          Copernicus GLO-30 and others
        </Link>
        <span
          id={copernicusId}
          className="visually-hidden"
        >
          {COPERNICUS_DEM_NOTICE}
        </span>
      </li>
      <li>
        Ground imagery in the US: <Link href={USGS_URL}>{USGS_CREDIT}</Link> (public domain)
      </li>
      <li>
        Ground imagery elsewhere: <Link href={EOX_URL}>{EOX_CREDIT}</Link> (
        <Link
          href={CC_BY_NC_SA_URL}
          title="Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International"
        >
          CC BY-NC-SA 4.0
        </Link>
        )
      </li>
      <li>
        {/* CC BY 4.0 asks for the licence and whether the data was changed:
            it is, resampled into forecast frames and cloud types
            (tides-tvr.4.1). */}
        Cloud forecasts and cloud types: <Link href={OPEN_METEO_SITE}>Weather data by Open-Meteo.com</Link> (
        <Link
          href={CC_BY_URL}
          title="Creative Commons Attribution 4.0 International"
        >
          CC BY 4.0
        </Link>
        , adapted)
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
