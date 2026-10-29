import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TIDES_DEFAULT_SPOT } from './tides'
import { TidesReadoutView } from './TidesReadout'

const SPRING = Date.parse('2026-10-10T15:50:36Z')
const NEAP = Date.parse('2026-10-18T16:13:19Z')
const KING = Date.parse('2026-12-24T01:28:45Z')

type Spot = { lat: number; lon: number; pinned: boolean }
const DEFAULT: Spot = { ...TIDES_DEFAULT_SPOT, pinned: false }

/** The readout's text, tags dropped. */
function text(timestamp: number, spot: Spot = DEFAULT, withSun = true): string {
  return renderToStaticMarkup(<TidesReadoutView {...spot} timestamp={timestamp} withSun={withSun} />)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
}

describe('TidesReadoutView', () => {
  it('is a named region', () => {
    const html = renderToStaticMarkup(<TidesReadoutView {...DEFAULT} timestamp={SPRING} withSun />)
    expect(html).toContain('aria-label="Tide-raising pull"')
  })

  it('reads the spring tide at the default spot', () => {
    const t = text(SPRING)
    for (const part of [
      'Tide at the red dot +49 cm',
      'Pull Moon 0.98× · Sun 0.46× · white: both · range 77 cm',
      'Pull × the Moon’s average. Ideal all-ocean Earth, sea drawn ×3,000,000; real coasts lag hours.',
    ])
      expect(t).toContain(part)
    expect(t).not.toContain('your pin')
  })

  it('reads the Moon’s tide alone without the Sun', () => {
    const t = text(SPRING, DEFAULT, false)
    expect(t).toContain('Tide at the red dot +33 cm')
    expect(t).toContain('Pull Moon 0.98× · range 52 cm')
    expect(t).not.toContain('Sun')
  })

  it('reads the neap and king tides', () => {
    expect(text(NEAP)).toContain('Pull Moon 0.87× · Sun 0.46× · white: both · range 22 cm')
    expect(text(KING)).toContain('Pull Moon 1.25× · Sun 0.48× · white: both · range 93 cm')
  })

  it('names the user’s pin, with a true minus at a low', () => {
    // A quarter of a day on, the equator under the Moon is at low water.
    const t = text(SPRING + 6.25 * 3_600_000, { lat: 0, lon: -62.4, pinned: true })
    expect(t).toContain('· your pin')
    expect(t).toMatch(/Tide at the red dot −2[45] cm/)
    expect(t).not.toMatch(/[−+-]0(?![.\d])/)
  })
})
