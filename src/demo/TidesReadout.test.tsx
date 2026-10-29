import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TIDES_DEFAULT_SPOT } from './tides'
import { TidesReadoutView } from './TidesReadout'

const SPRING = Date.parse('2026-10-10T15:50:36Z')
const NEAP = Date.parse('2026-10-18T16:13:19Z')
const KING = Date.parse('2026-12-24T01:28:45Z')

/** The readout's text, tags dropped. */
function text(timestamp: number, spot: { lat: number; lon: number; pinned: boolean } = { ...TIDES_DEFAULT_SPOT, pinned: false }): string {
  return renderToStaticMarkup(<TidesReadoutView {...spot} timestamp={timestamp} />)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/ \)/g, ')')
    .replace(/\( /g, '(')
}

describe('TidesReadoutView', () => {
  it('is a named region', () => {
    const html = renderToStaticMarkup(<TidesReadoutView {...TIDES_DEFAULT_SPOT} pinned={false} timestamp={SPRING} />)
    expect(html).toContain('aria-label="Tide-raising pull"')
  })

  it('reads the spring tide at the default spot', () => {
    const t = text(SPRING)
    for (const part of [
      'Tide-raising pull, × the Moon’s average',
      'Moon 0.98× (387,631 km) · Sun 0.46×',
      'High–low range 1.43× · 77 cm',
      'Ideal tide at the red dot +49 cm · example: equator 62.4°W',
      'Bulge drawn ×1,000,000',
    ])
      expect(t).toContain(part)
  })

  it('reads the neap and king tides', () => {
    expect(text(NEAP)).toContain('Moon 0.87× (402,738 km) · Sun 0.46×')
    expect(text(NEAP)).toContain('High–low range 0.41× · 22 cm')
    expect(text(KING)).toContain('Moon 1.25× (356,729 km) · Sun 0.48×')
    expect(text(KING)).toContain('High–low range 1.73× · 93 cm')
  })

  it('names the user’s pin, with a true minus at a low', () => {
    // A quarter of a day on, the equator under the Moon is at low water.
    const t = text(SPRING + 6.25 * 3_600_000, { lat: 0, lon: -62.4, pinned: true })
    expect(t).toContain('· your pin')
    expect(t).toMatch(/Ideal tide at the red dot −2[45] cm/)
    expect(t).not.toMatch(/[−+-]0(?![.\d])/)
  })
})
