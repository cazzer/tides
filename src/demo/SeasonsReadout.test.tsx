import { Seasons } from 'astronomy-engine'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SeasonsReadoutView } from './SeasonsReadout'

const seasons = Seasons(2026)
const june = seasons.jun_solstice.date.getTime()
const september = seasons.sep_equinox.date.getTime()
const december = seasons.dec_solstice.date.getTime()

describe('SeasonsReadoutView', () => {
  it('reads 45°N at the June solstice, with no pin set', () => {
    const html = renderToStaticMarkup(<SeasonsReadoutView lat={45} pinned={false} timestamp={june} />)
    expect(html).toContain('aria-label="Sunlight at this latitude"')
    for (const text of [
      '45.0°N',
      'northern hemisphere',
      'example',
      '68° up',
      '15 h 37 min',
      '1226 W/m²',
      '843',
      '484 W/m²',
      '+63%',
      '−3.2%',
    ])
      expect(html).toContain(text)
  })

  it('reads a southern pin’s summer in December', () => {
    const html = renderToStaticMarkup(<SeasonsReadoutView lat={-45} pinned timestamp={december} />)
    expect(html).toContain('southern hemisphere')
    expect(html).toContain('your pin')
    expect(html).toContain('+63%')
  })

  it('says when the Sun stays down', () => {
    const html = renderToStaticMarkup(<SeasonsReadoutView lat={70} pinned timestamp={december} />)
    expect(html).toContain('Sun down all day')
    expect(html).toContain('below the horizon')
  })

  it('never shows a minus zero at the equinox', () => {
    const html = renderToStaticMarkup(<SeasonsReadoutView lat={45} pinned={false} timestamp={september} />)
    expect(html).toContain('Tilt vs equinox 0% (0 W/m²)')
    expect(html).not.toMatch(/[\u2212+-]0(?![.\d])/)
  })
})
