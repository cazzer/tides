import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { setActiveSurfaceSources } from '../renderers/surface/surface-credits'
import { SurfaceCredit, SurfaceCreditLine } from './SurfaceCredit'

describe('SurfaceCreditLine', () => {
  test('draws nothing without sources', () => {
    expect(renderToStaticMarkup(<SurfaceCreditLine sources={[]} />)).toBe('')
  })
  test('names Mapterhorn and USGS over the US', () => {
    const html = renderToStaticMarkup(<SurfaceCreditLine sources={['mapterhorn', 'usgs']} />)
    expect(html).toContain('Mapterhorn')
    expect(html).toContain('USGS The National Map')
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
