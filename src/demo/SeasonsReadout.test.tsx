import { Seasons } from 'astronomy-engine'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SeasonsReadoutView } from './SeasonsReadout'

const seasons = Seasons(2026)
const june = seasons.jun_solstice.date.getTime()
const september = seasons.sep_equinox.date.getTime()
const december = seasons.dec_solstice.date.getTime()

/** The readout's text, tags dropped. */
function text(lat: number, pinned: boolean, timestamp: number): string {
  return renderToStaticMarkup(<SeasonsReadoutView lat={lat} pinned={pinned} timestamp={timestamp} />)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
}

describe('SeasonsReadoutView', () => {
  it('is a named region', () => {
    const html = renderToStaticMarkup(<SeasonsReadoutView lat={45} pinned={false} timestamp={june} />)
    expect(html).toContain('aria-label="Sunlight at this latitude"')
  })

  it('reads 45°N at the June solstice, with no pin set', () => {
    const t = text(45, false, june)
    for (const part of [
      'Sunlight at 45.0°N · northern hemisphere (example, no pin)',
      'Noon Sun 68° up · daylight 15 h 37 min',
      'At noon 1226 W/m² in space · 843 at the ground (69% gets through)',
      'Day’s average 484 W/m² in space',
      'Against an equinox day at average distance:',
      'tilt +63% (+193 W/m²)',
      'distance −3.2% (−16 W/m²)',
    ])
      expect(t).toContain(part)
  })

  it('reads a southern pin’s summer in December', () => {
    const t = text(-45, true, december)
    expect(t).toContain('southern hemisphere (your pin)')
    expect(t).toContain('tilt +63%')
  })

  it('says when the Sun stays down', () => {
    const t = text(70, true, december)
    expect(t).toContain('Noon Sun below the horizon · daylight 0 h (Sun down all day)')
    expect(t).toContain('No sunlight at noon')
  })

  it('keeps the noon Sun and the day’s length in step at the polar circle', () => {
    // 67°N in December: the geometric noon Sun is just below the horizon, but
    // refraction lifts its top edge into a short day.
    const t = text(67, true, december)
    expect(t).toContain('Noon Sun on the horizon')
    expect(t).toContain('At noon the Sun only skims the horizon')
    expect(t).not.toContain('below the horizon')
    expect(t).not.toContain('No sunlight')
    expect(t).toMatch(/daylight [0-2] h \d+ min/)
  })

  it('never shows a minus zero, or a W/m² against a 0%', () => {
    const t = text(45, false, september)
    expect(t).toContain('tilt 0% (0 W/m²)')
    expect(t).not.toMatch(/[−+-]0(?![.\d])/)
  })
})
