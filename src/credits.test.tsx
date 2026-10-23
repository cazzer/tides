import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { Credits, GIBS_ACKNOWLEDGEMENT } from './Credits'
import { OPEN_METEO_SITE } from './forecast-clouds'

// The credits the views used to draw over the scene, now in settings (tides-1qv).
describe('Credits', () => {
  const html = renderToStaticMarkup(<Credits />)
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])

  test('credits NASA GIBS with its requested acknowledgement', () => {
    expect(hrefs).toContain('https://earthdata.nasa.gov/gibs')
    expect(html).toContain(GIBS_ACKNOWLEDGEMENT.replace(/'/g, '&#x27;'))
    expect(html).toContain('Blue Marble Next Generation')
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
