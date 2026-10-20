import { describe, expect, it } from 'vitest'
import { airmass, extinction } from './renderers/Starfield'
import { HORIZON_GLOW, HORIZON_GLOW_HEIGHT, horizonGlowGeometry } from './sky'

const sinDeg = (deg: number) => Math.sin((deg * Math.PI) / 180)

describe('star extinction from the surface', () => {
  it('leaves the zenith untouched and stays finite at the horizon', () => {
    expect(airmass(1)).toBeCloseTo(1, 3)
    expect(airmass(0)).toBeCloseTo(40, 0)
    expect(extinction(1)).toBeCloseTo(1, 3)
  })

  it('fades stars into the horizon instead of cutting them off', () => {
    // ~1 airmass at 30°, so barely dimmer; nearly gone on the horizon.
    expect(extinction(sinDeg(30))).toBeGreaterThan(0.75)
    expect(extinction(sinDeg(10))).toBeGreaterThan(extinction(sinDeg(5)))
    expect(extinction(0)).toBeLessThan(0.001)
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
