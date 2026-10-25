import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { setActiveSurfaceSources } from '../renderers/surface/surface-credits'
import { creditLine } from '../renderers/surface/credit-sources'
import { SurfaceCredit, SurfaceCreditLine } from './SurfaceCredit'

describe('SurfaceCreditLine', () => {
  test('draws nothing without sources', () => {
    expect(renderToStaticMarkup(<SurfaceCreditLine sources={[]} />)).toBe('')
  })
  test('names Mapterhorn and USGS over the US', () => {
    const html = renderToStaticMarkup(<SurfaceCreditLine sources={['mapterhorn', 'usgs']} />)
    expect(html).toContain('Mapterhorn')
    expect(html).toContain('Imagery USGS')
    expect(html).not.toContain('Sentinel')
  })
  test('names Mapterhorn and EOX with the Copernicus notice elsewhere', () => {
    const html = renderToStaticMarkup(<SurfaceCreditLine sources={['mapterhorn', 'eox']} />)
    expect(html).toContain('https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2020)')
    expect(html).not.toContain('USGS')
  })
})

describe('SurfaceCredit', () => {
  test('is off until the surface publishes sources, and off again after', () => {
    expect(renderToStaticMarkup(<SurfaceCredit />)).toBe('')
    setActiveSurfaceSources(['mapterhorn', 'eox'])
    expect(renderToStaticMarkup(<SurfaceCredit />)).toContain('Mapterhorn')
    setActiveSurfaceSources([])
    expect(renderToStaticMarkup(<SurfaceCredit />)).toBe('')
  })
})

// A conservative 0.52 em per character at 10 px, four 11 px lines (the exit
// row plus the gap above the strip), at the narrowest phone's usable width
// (320 - 96 - 16) and the line's own 246 px.
describe('creditLine budget', () => {
  const all = creditLine(['mapterhorn', 'usgs', 'eox'])
  test.each([208, 246])('all three sources fit four lines at %i px', (width) => {
    expect(Math.ceil((all.length * 5.2) / width)).toBeLessThanOrEqual(4)
  })
  test('keeps the EOX wording verbatim', () => {
    expect(all).toContain('Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2020)')
  })
})
