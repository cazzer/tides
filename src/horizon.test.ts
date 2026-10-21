import { describe, expect, it } from 'vitest'
import {
  DRAWN_MAGNITUDE_SCALE,
  airmass,
  extinction,
  starBrightness,
} from './renderers/Starfield'
import { HORIZON_GLOW, HORIZON_GLOW_HEIGHT, horizonGlowGeometry } from './sky'

const sinDeg = (deg: number) => Math.sin((deg * Math.PI) / 180)

describe('star extinction from the surface', () => {
  it('leaves the zenith untouched and stays finite at the horizon', () => {
    expect(airmass(1)).toBeCloseTo(1, 3)
    expect(airmass(0)).toBeCloseTo(40, 0)
    expect(extinction(1)).toBeCloseTo(1, 3)
  })

  it('fades stars into the horizon instead of cutting them off', () => {
    // ~2 airmasses at 30°, so barely dimmer; mostly gone on the horizon.
    expect(extinction(sinDeg(30))).toBeGreaterThan(0.9)
    expect(extinction(sinDeg(10))).toBeGreaterThan(extinction(sinDeg(5)))
    expect(extinction(0)).toBeLessThan(0.1)
  })

  it('dims on the drawn magnitude scale, so stars reach the horizon (tides-clo)', () => {
    // The scale maps the brightness ramp's magnitudes onto drawn flux.
    const loss = (from: number, to: number) => starBrightness(to) / starBrightness(from)
    expect(10 ** (-0.4 * DRAWN_MAGNITUDE_SCALE * 7.2)).toBeCloseTo(loss(-1.5, 5.7), 6)
    // Starting on the floor, as most of the catalogue does, a star keeps about
    // half its brightness 5° up and a third 3° up. In full flux it kept 9% at
    // 4°, which went black and left an empty band above the horizon.
    expect(extinction(sinDeg(5))).toBeGreaterThan(0.45)
    expect(extinction(sinDeg(3))).toBeGreaterThan(0.3)
    expect(starBrightness(9)).toBe(starBrightness(5.7))
  })
})

describe('horizon glow', () => {
  it('is brightest on the horizon and fades by e per HORIZON_GLOW_HEIGHT', () => {
    const radius = 5
    const geometry = horizonGlowGeometry(radius)
    const position = geometry.getAttribute('position')
    const color = geometry.getAttribute('color')
    for (let i = 0; i < position.count; i += 1) {
      const altitude = (Math.asin(position.getY(i) / radius) * 180) / Math.PI
      expect(altitude).toBeGreaterThan(-1e-6)
      if (altitude < 20) {
        expect(color.getZ(i)).toBeCloseTo(HORIZON_GLOW.b * Math.exp(-altitude / HORIZON_GLOW_HEIGHT), 5)
      }
    }
    let top = 0
    for (let i = 1; i < position.count; i += 1) {
      if (position.getY(i) > position.getY(top)) top = i
    }
    expect(color.getZ(top)).toBe(0)
  })
})
