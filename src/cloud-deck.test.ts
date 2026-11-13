import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DECK_FLOOR_LIGHT,
  DECK_MAX_EXPONENT,
  DECK_PROFILES,
  deckAhead,
  deckColumn,
  deckDayLight,
  deckEye,
  deckFade,
  deckInside,
  deckShare,
  deckSunlight,
  setDeckEye,
  type DeckProfile,
} from './cloud-deck'

const profiles = Object.entries(DECK_PROFILES) as [string, DeckProfile][]
const R = 6.5

describe('the cloud decks (tides-ufyr.8.3)', () => {
  it.each(profiles)("ramps %s's share from 0 at its top to 1 at its floor, monotone", (_key, deck) => {
    expect(deckShare(R * deck.top, R, deck)).toBe(0)
    expect(deckShare(R * 1.2, R, deck)).toBe(0)
    expect(deckShare(R * deck.floor, R, deck)).toBeCloseTo(1, 12)
    expect(deckShare(R * deck.base, R, deck)).toBe(1)
    let last = -1
    for (let i = 0; i <= 200; i++) {
      const share = deckShare(R * (deck.top + 0.01 - (i / 200) * (deck.top + 0.02 - deck.floor)), R, deck)
      expect(share).toBeGreaterThanOrEqual(last)
      last = share
    }
  })

  it.each(profiles)("fades %s's fog in from its shell's top to the cloud top", (_key, deck) => {
    expect(deckFade(R * deck.top, R, deck)).toBe(0)
    expect(deckFade(R * (deck.top + 0.01), R, deck)).toBe(0)
    expect(deckFade(R, R, deck)).toBe(1)
    expect(deckFade(R * deck.floor, R, deck)).toBe(1)
    const mid = deckFade(R * (1 + deck.top) * 0.5, R, deck)
    expect(mid).toBeCloseTo(0.5, 12)
  })
})

describe('deckColumn', () => {
  const H = 0.004 * R

  it('runs on continuously across the cloud top, every way', () => {
    for (const mu of [-1, -0.5, -0.05, 0, 0.05, 0.5, 1]) {
      const below = deckColumn(R - 1e-7, mu, R, H)
      const above = deckColumn(R + 1e-7, mu, R, H)
      expect(Math.abs(below - above) / Math.max(above, 1e-12), String(mu)).toBeLessThan(1e-4)
    }
  })

  it('meets itself at the horizon', () => {
    for (const r of [R * 0.99, R, R * 1.01]) {
      const up = deckColumn(r, 1e-6, R, H)
      const down = deckColumn(r, -1e-6, R, H)
      expect(Math.abs(up - down) / up).toBeLessThan(1e-3)
    }
  })

  it('gives H·e^{z/H} straight up from z under the cloud top (Chapman, within 1%)', () => {
    for (const z of [-0.01, 0, 0.005, 0.015]) {
      const r = R - z * R
      expect(deckColumn(r, 1, R, H) / (H * Math.exp((z * R) / H))).toBeCloseTo(1, 2)
    }
  })

  it('thickens downward and with depth', () => {
    // Its light through: past the exponent's cap the column can ease, long
    // after it is opaque.
    let last = 1
    for (let i = 0; i <= 40; i++) {
      const through = Math.exp(-deckColumn(R * 1.016, 1 - (i / 40) * 2, R, H) / (0.004 * R))
      expect(through).toBeLessThanOrEqual(last)
      last = through
    }
    expect(deckColumn(R * 0.99, 0.3, R, H)).toBeGreaterThan(deckColumn(R, 0.3, R, H))
  })

  it.each(profiles)("is opaque straight down at %s's floor, and well above it, but finite", (_key, deck) => {
    const h = deck.scaleHeight * R
    const visibility = deck.visibility * R
    for (const r of [R * deck.floor, R, R * (1 + deck.scaleHeight)]) {
      const column = deckColumn(r, -1, R, h)
      expect(Number.isFinite(column)).toBe(true)
      expect(Math.exp(-column / visibility)).toBeLessThan(1e-3)
    }
    // The exponent's cap keeps the deepest line finite.
    expect(deckColumn(R * 0.5, -1, R, h)).toBeLessThan(Math.exp(DECK_MAX_EXPONENT + 1) * R)
  })

  it('sees through overhead from the fog shell top, not from the cloud top down', () => {
    const deck = DECK_PROFILES.jupiter!
    const h = deck.scaleHeight * R
    const visibility = deck.visibility * R
    const T = (r: number, mu: number) => Math.exp(-deckColumn(r, mu, R, h) / visibility)
    expect(T(R * deck.top, 1)).toBeGreaterThan(0.95)
    expect(T(R, 1)).toBeCloseTo(Math.exp(-1), 1)
    expect(T(R * deck.floor, 0)).toBeLessThan(1e-6)
  })
})

describe('deckAhead', () => {
  const H = 0.004 * R
  const visibility = 0.004 * R

  it('is the local visibility at the horizon, nearer falling, further climbing', () => {
    for (const r of [R * 0.99, R, R * 1.01]) {
      const local = visibility * Math.exp((r - R) / H)
      expect(deckAhead(r, 0, R, H, visibility)).toBeCloseTo(local, 9)
      expect(deckAhead(r, -0.5, R, H, visibility)).toBeLessThan(local)
      expect(deckAhead(r, 0.1, R, H, visibility)).toBeGreaterThan(local)
    }
  })

  it('reaches an optical depth of 1, plane-parallel', () => {
    for (const mu of [-1, -0.3, 0.2]) {
      const r = R * 1.002
      const s = deckAhead(r, mu, R, H, visibility)
      // ∫ σ(r + mu·t) dt over [0, s].
      let tau = 0
      const n = 4000
      for (let i = 0; i < n; i++) {
        const t = ((i + 0.5) / n) * s
        tau += (Math.exp(-(r + mu * t - R) / H) / visibility) * (s / n)
      }
      expect(tau, String(mu)).toBeCloseTo(1, 3)
    }
  })

  it('never reaches it climbing out of thin fog', () => {
    expect(deckAhead(R * 1.016, 1, R, H, visibility)).toBe(Infinity)
  })
})

describe('the shaders mirror', () => {
  it('keeps deck-column.glsl in step with deckColumn and deckAhead', () => {
    const glsl = readFileSync(new URL('./shaders/planet/deck-column.glsl', import.meta.url), 'utf8')
    expect(glsl).toContain(`#define DECK_MAX_EXPONENT ${DECK_MAX_EXPONENT}.0`)
    expect(glsl).toContain('float deckColumn(float r, float mu, float R, float H)')
    expect(glsl).toContain('float p = max(r * sqrt(max(0.0, 1.0 - mu * mu)), H);')
    expect(glsl).toContain('return (-H / mu) * log(1.0 - k);')
  })
})

describe('deckSunlight (the Sun glow through the fog)', () => {
  it.each(profiles)("is whole over %s's fog shell and all but gone at its floor", (_key, deck) => {
    for (const mu of [-0.5, 0, 0.5, 1]) {
      expect(deckSunlight(R * deck.top, mu, R, deck)).toBe(1)
      expect(deckSunlight(R * 1.1, mu, R, deck)).toBe(1)
      expect(deckSunlight(R * deck.floor, mu, R, deck)).toBeLessThan(1e-3)
    }
    // The Sun overhead at the cloud top: the fog's own e^-1 overhead.
    expect(deckSunlight(R, 1, R, deck)).toBeCloseTo(Math.exp(-deck.scaleHeight / deck.visibility), 2)
  })

  it('dims with depth and as the Sun sinks', () => {
    const deck = DECK_PROFILES.jupiter!
    let last = 1
    for (let i = 0; i <= 50; i++) {
      const light = deckSunlight(R * (deck.top - (i / 50) * (deck.top - deck.floor)), 0.7, R, deck)
      expect(light).toBeLessThanOrEqual(last + 1e-12)
      last = light
    }
    const at = R * 1.005
    expect(deckSunlight(at, 1, R, deck)).toBeGreaterThan(deckSunlight(at, 0.2, R, deck))
    expect(deckSunlight(at, 0.2, R, deck)).toBeGreaterThan(deckSunlight(at, -0.2, R, deck))
  })

  it('records the deck the eye is in, and clears to full light', () => {
    setDeckEye('jupiter', 0.25)
    expect(deckEye).toEqual({ key: 'jupiter', sunlight: 0.25 })
    setDeckEye(null, 0.25)
    expect(deckEye).toEqual({ key: null, sunlight: 1 })
  })
})

describe('deckInside (how far the fog light takes over, tides-ufyr.8.3.2)', () => {
  it.each(profiles)('is exactly 0 at and over the cloud top of %s, 1 a scale height under it and at its floor', (_key, deck) => {
    expect(deckInside(R, R, deck)).toBe(0)
    expect(deckInside(R * 1.02, R, deck)).toBe(0)
    expect(deckInside(R * deck.top, R, deck)).toBe(0)
    expect(deckInside(R * (1 - deck.scaleHeight), R, deck)).toBe(1)
    expect(deckInside(R * deck.floor, R, deck)).toBe(1)
  })

  it.each(profiles)('rises monotonically and continuously through the band on %s', (_key, deck) => {
    const steps = 200
    let last = deckInside(R, R, deck)
    for (let i = 1; i <= steps; i++) {
      const v = deckInside(R * (1 - (i / steps) * 2 * deck.scaleHeight), R, deck)
      expect(v).toBeGreaterThanOrEqual(last)
      expect(v - last).toBeLessThan(0.02)
      last = v
    }
  })
})

describe('deckDayLight (the fog lit by the Sun at the eye, tides-ufyr.8.3.2)', () => {
  it.each(profiles)('is dark with the Sun down on %s at any depth', (_key, deck) => {
    for (const mu of [-1, -0.3, 0]) {
      for (const at of [1.01, 1, 0.995, deck.floor, deck.base]) {
        expect(deckDayLight(R * at, mu, R, deck)).toBe(0)
      }
    }
  })

  it.each(profiles)('is the Sun elevation at the cloud top of %s and DECK_FLOOR_LIGHT of it at the floor', (_key, deck) => {
    for (const mu of [0.2, 0.7, 1]) {
      expect(deckDayLight(R, mu, R, deck)).toBeCloseTo(mu, 12)
      expect(deckDayLight(R * deck.floor, mu, R, deck)).toBeCloseTo(DECK_FLOOR_LIGHT * mu, 12)
    }
  })

  it.each(profiles)('dims with depth and as the Sun sinks on %s, and stays finite under the floor', (_key, deck) => {
    let last = Infinity
    for (let i = 0; i <= 50; i++) {
      const v = deckDayLight(R * (1 - (i / 50) * (1 - deck.floor)), 0.7, R, deck)
      expect(v).toBeLessThanOrEqual(last)
      last = v
    }
    const at = R * 0.995
    expect(deckDayLight(at, 1, R, deck)).toBeGreaterThan(deckDayLight(at, 0.5, R, deck))
    expect(deckDayLight(at, 0.5, R, deck)).toBeGreaterThan(deckDayLight(at, 0.1, R, deck))
    for (const at of [deck.base, 0.9, 0.5, 0]) {
      const v = deckDayLight(R * at, 0.7, R, deck)
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
    }
  })

  it.each(profiles)("lights %s's floor at least 4x the old sun-depth dimming", (_key, deck) => {
    const before = 0.7 * Math.exp(-(1 - deck.floor) / deck.sunDepth)
    expect(deckDayLight(R * deck.floor, 0.7, R, deck)).toBeGreaterThanOrEqual(4 * before)
  })
})
