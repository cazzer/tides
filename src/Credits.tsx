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
// The MFWAM global analysis and forecast product the Marine API serves.
export const COPERNICUS_MARINE_WAVES_URL = 'https://doi.org/10.48670/moi-00017'
const STELLARIUM_URL = 'https://github.com/Stellarium/stellarium/tree/master/skycultures/modern'
const FREE_ART_LICENSE_URL = 'https://artlibre.org/licence/lal/en/'
export const MAPTERHORN_URL = 'https://mapterhorn.com/'
export const ETOPO_URL = 'https://www.ncei.noaa.gov/products/etopo-global-relief-model'
export const NSIDC_SEA_ICE_INDEX_URL = 'https://doi.org/10.7265/a98x-0f50'
// NOAA Open Data Dissemination's GOES-R buckets, where the GLM files come from (tides-ufyr.13).
export const GLM_URL = 'https://registry.opendata.aws/noaa-goes/'
// The simulated lightning's flash rates (tides-ufyr.14): NASA GHRC's LIS Very
// High Resolution Monthly Climatology, read from its GIBS layer
// (LIS_Very_High_Resolution_Lightning_Monthly_Climatology_LIS_Mean_Flash_Rate):
// the dataset's DOI (Albrecht et al. 2016, VHRMC; CMR C1979883359-GHRC_DAAC),
// as scripts/build-lightning-climatology.py cites it (tides-ufyr.14.1).
export const LIS_CLIMATOLOGY_URL = 'https://doi.org/10.5067/LIS/LIS/DATA302'
// The data citation NSIDC requires (nsidc.org/data/g02135/versions/4), with the
// subset scripts/build-sea-ice.py takes; fetched by 2026-11-03 (tides-zec.19).
export const NSIDC_SEA_ICE_CITATION =
  'Fetterer, F., Knowles, K., Meier, W. N., Savoie, M., Windnagel, A. K. & Stafford, T. (2025). Sea Ice Index. (G02135, Version 4). [Data Set]. Boulder, Colorado USA. National Snow and Ice Data Center. https://doi.org/10.7265/a98x-0f50. Daily sea ice concentration, both hemispheres, every 7 days of 2025, and the daily extents. Date Accessed 11-03-2026.'
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
  const seaIceId = useId()
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
        Ocean depth: <Link href={ETOPO_URL}>NOAA NCEI ETOPO 2022</Link> (public domain)
      </li>
      <li>
        Sea ice:{' '}
        <Link
          href={NSIDC_SEA_ICE_INDEX_URL}
          title={NSIDC_SEA_ICE_CITATION}
          aria-describedby={seaIceId}
        >
          NSIDC Sea Ice Index, Version 4 (G02135)
        </Link>
        <span
          id={seaIceId}
          className="visually-hidden"
        >
          {NSIDC_SEA_ICE_CITATION}
        </span>
        {', 2025'}
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
        Lightning (Real weather), observed:{' '}
        <Link href={GLM_URL}>NOAA GOES-R Geostationary Lightning Mapper, GOES-19 and GOES-18</Link>, via NOAA Open Data
        Dissemination; the Americas, Atlantic and Pacific only
      </li>
      <li>
        Lightning (Real weather) elsewhere in time, before the GLM archive and after the latest data: simulated: flash
        rates from <Link href={LIS_CLIMATOLOGY_URL}>NASA GHRC&apos;s LIS Very High Resolution Monthly Lightning
        Climatology</Link> (38° S–38° N; elsewhere a seasonal guess), placed under thick cloud and, in forecast hours,
        under <Link href={OPEN_METEO_SITE}>Open-Meteo</Link>&apos;s forecast showers
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
        {/* Open-Meteo asks for its providers too: its Marine API's waves here
            are Météo-France MFWAM, credited as Copernicus Marine requires.
            Adapted: means of four days' maxima, a season apart, at 7.5° (tides-d9f.5),
            and the current wave directions at 15° with the real weather (tides-nh8.4). */}
        Sea state (wave climate and live wave directions): <Link href={OPEN_METEO_SITE}>Weather data by Open-Meteo.com</Link> (
        <Link
          href={CC_BY_URL}
          title="Creative Commons Attribution 4.0 International"
        >
          CC BY 4.0
        </Link>
        , adapted: means of four days' maxima, a season apart, at 7.5°; current directions at 15°), from Météo-France MFWAM,{' '}
        <Link href={COPERNICUS_MARINE_WAVES_URL}>generated using E.U. Copernicus Marine Service Information</Link>
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
