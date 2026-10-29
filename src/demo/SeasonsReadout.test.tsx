import { Seasons } from 'astronomy-engine'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SeasonsReadoutView } from './SeasonsReadout'

const seasons = Seasons(2026)
const june = seasons.jun_solstice.date.getTime()
const september = seasons.sep_equinox.date.getTime()
const december = seasons.dec_solstice.date.getTime()

function html(lat: number, pinned: boolean, timestamp: number): string {
  return renderToStaticMarkup(<SeasonsReadoutView lat={lat} pinned={pinned} timestamp={timestamp} />)
}

/** The readout's text, tags dropped. */
function text(lat: number, pinned: boolean, timestamp: number): string {
  return html(lat, pinned, timestamp)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
}

/** Each bar's side and width, as a share of its track. */
function bars(lat: number, timestamp: number): { side: string; width: number }[] {
  return [...html(lat, false, timestamp).matchAll(/data-side="(\w+)" style="width:([\d.]+)%"/g)].map((m) => ({
    side: m[1],
    width: Number(m[2]),
  }))
}

describe('SeasonsReadoutView', () => {
  it('is a named region', () => {
    expect(html(45, false, june)).toContain('aria-label="Sunlight at this latitude"')
  })

  it('reads 45°N at the June solstice, with no pin set', () => {
    const t = text(45, false, june)
    for (const part of [
      'Sunlight at 45.0°N example',
      '15 h 37 min of daylight',
      'Compared with an equinox day',
      'Tilt +63%',
      'Distance −3.2%',
      'Noon Sun 68° up',
      'Sizes and distances not to scale',
    ])
      expect(t).toContain(part)
  })

  it('draws the tilt and the distance on one scale, more to the right and less to the left', () => {
    const [tilt, distance] = bars(45, june)
    expect(tilt).toEqual({ side: 'more', width: 31.5 })
    expect(distance.side).toBe('less')
    expect(distance.width).toBeCloseTo(1.6)
  })

  it('reads a southern pin’s summer in December', () => {
    const t = text(-45, true, december)
    expect(t).toContain('Sunlight at 45.0°S your pin')
    expect(t).toContain('Tilt +63%')
  })

  it('says when the Sun stays down', () => {
    const t = text(70, true, december)
    expect(t).toContain('0 h of daylight (Sun down all day)')
    expect(t).toContain('Tilt −100%')
    expect(t).toContain('Noon Sun below the horizon')
  })

  it('says when the Sun stays up', () => {
    expect(text(70, true, june)).toContain('24 h of daylight (Sun up all day)')
  })

  it('shows a dash for the tilt where an equinox day has next to no sunlight', () => {
    const t = text(90, true, december)
    expect(t).toContain('Tilt —')
    expect(t).not.toContain('NaN')
  })

  it('keeps the noon Sun and the day’s length in step at the polar circle', () => {
    // 67°N in December: the geometric noon Sun is just below the horizon, but
    // refraction lifts its top edge into a short day.
    const t = text(67, true, december)
    expect(t).toContain('Noon Sun on the horizon')
    expect(t).not.toContain('below the horizon')
    expect(t).toMatch(/[0-2] h \d+ min of daylight/)
  })

  it('never shows a minus zero, nor a bar for a 0%', () => {
    const t = text(45, false, september)
    expect(t).toContain('Tilt 0%')
    expect(t).not.toMatch(/[−+-]0(?![.\d])/)
    expect(bars(45, september)).toHaveLength(1)
  })

  it('names the equator', () => {
    expect(text(0, true, june)).toContain('Sunlight at the equator your pin')
  })
})
