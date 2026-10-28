import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { COPERNICUS_DEM_NOTICE, COPERNICUS_MARINE_WAVES_URL, Credits, ETOPO_URL, GIBS_ACKNOWLEDGEMENT } from './Credits'
import { OPEN_METEO_SITE } from './forecast-clouds'

// The credits the views used to draw over the scene, now in settings (tides-1qv).
describe('Credits', () => {
  const html = renderToStaticMarkup(<Credits />)
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])

  test('credits NASA GIBS with its requested acknowledgement', () => {
    expect(hrefs).toContain('https://earthdata.nasa.gov/gibs')
    expect(html).toContain(GIBS_ACKNOWLEDGEMENT.replace(/'/g, '&#x27;'))
    expect(html).toContain('Blue Marble Next Generation')
    expect(html).toContain('VIIRS City Lights 2012')
  })

  test('credits NOAA NCEI\'s ETOPO 2022 for the ocean\'s depth', () => {
    expect(hrefs).toContain(ETOPO_URL)
    expect(html).toContain('ETOPO 2022')
  })

  test('credits Open-Meteo, Solar System Scope and Stellarium with their licences', () => {
    expect(hrefs).toEqual(
      expect.arrayContaining([
        OPEN_METEO_SITE,
        'https://www.solarsystemscope.com/textures/',
        'https://creativecommons.org/licenses/by/4.0/',
        'https://github.com/Stellarium/stellarium/tree/master/skycultures/modern',
        'https://artlibre.org/licence/lal/en/',
      ])
    )
  })

  test('credits Open-Meteo as CC BY 4.0, adapted, next to its link', () => {
    const line = html.match(/<li>Cloud forecasts and cloud types:.*?<\/li>/)?.[0] ?? ''
    expect(line).toContain(`href="${OPEN_METEO_SITE}"`)
    expect(line).toContain('Weather data by Open-Meteo.com')
    expect(line).toContain('href="https://creativecommons.org/licenses/by/4.0/"')
    expect(line).toMatch(/CC BY 4.0<\/a>, adapted\)/)
  })

  test('credits the wave climate to Open-Meteo, adapted, and its Copernicus Marine source', () => {
    const line = html.match(/<li>Sea state \(wave climate\):.*?<\/li>/)?.[0] ?? ''
    expect(line).toContain(`href="${OPEN_METEO_SITE}"`)
    expect(line).toContain('href="https://creativecommons.org/licenses/by/4.0/"')
    expect(line).toMatch(/CC BY 4.0<\/a>, adapted: means of four days(?:'|&#x27;|&#39;) maxima, a season apart, at 7\.5°\)/)
    expect(line).toContain(`href="${COPERNICUS_MARINE_WAVES_URL}"`)
    expect(line).toContain('generated using E.U. Copernicus Marine Service Information')
  })

  test("credits Mapterhorn's terrain with the Copernicus notice and its per-source attribution", () => {
    expect(hrefs).toEqual(expect.arrayContaining(['https://mapterhorn.com/', 'https://mapterhorn.com/attribution/']))
    expect(html).toContain('Copernicus GLO-30')
    expect(html).toContain(COPERNICUS_DEM_NOTICE)
  })

  test('credits USGS (public domain) and EOX Sentinel-2 cloudless with its licence', () => {
    expect(hrefs).toEqual(
      expect.arrayContaining([
        'https://www.usgs.gov/programs/national-geospatial-program/national-map',
        'https://s2maps.eu/',
        'https://creativecommons.org/licenses/by-nc-sa/4.0/',
      ])
    )
    expect(html).toContain('USGS The National Map')
    expect(html).toContain('public domain')
    expect(html).toContain('Sentinel-2 cloudless')
    expect(html).toContain('Contains modified Copernicus Sentinel data 2020')
  })

  test('opens every link in a new tab without an opener', () => {
    const anchors = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0])
    expect(anchors.length).toBe(hrefs.length)
    for (const a of anchors) expect(a).toMatch(/target="_blank"[^>]*rel="noreferrer"|rel="noreferrer"[^>]*target="_blank"/)
  })

  test('appends live lines', () => {
    expect(renderToStaticMarkup(<Credits><li>Clouds on screen: x</li></Credits>)).toContain(
      '<li>Clouds on screen: x</li>'
    )
  })
})
