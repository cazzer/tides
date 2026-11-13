import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  DECK_FLOOR_LIGHT,
  DECK_ABOVE_MU,
  DECK_BELOW_DIM,
  DECK_BELOW_MU,
  DECK_HORIZON_GAIN,
  DECK_HORIZON_MU,
  DECK_LAYER_DETAIL,
  DECK_LAYER_EASE_HEIGHTS,
  DECK_LAYER_LIGHT,
  DECK_LAYER_SEEN,
  DECK_MAX_EXPONENT,
  DECK_NO_TINT,
  DECK_PROFILES,
  JUPITER_INSIDE_TINT,
  deckAhead,
  deckColumn,
  deckDayLight,
  deckEye,
  deckFade,
  deckInside,
  deckLayerHit,
  deckLayerLight,
  deckLayerShow,
  deckLayerWeight,
  deckViewShade,
  deckShare,
  deckSunElevation,
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
    expect(glsl).toContain('float deckLayerHit(float r, float mu, float level)')
    expect(glsl).toContain('float c = (r - level) * (r + level);')
    expect(glsl).toContain('return c / (-b + sqrt(h));')
    const float = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`)
    for (const [name, value] of [
      ['DECK_BELOW_DIM', DECK_BELOW_DIM],
      ['DECK_HORIZON_GAIN', DECK_HORIZON_GAIN],
      ['DECK_HORIZON_MU', DECK_HORIZON_MU],
      ['DECK_ABOVE_MU', DECK_ABOVE_MU],
      ['DECK_LAYER_DETAIL', DECK_LAYER_DETAIL],
    ] as const) {
      expect(glsl).toContain(`#define ${name} ${float(value)}\n`)
    }
    expect(glsl).toContain(`#define DECK_BELOW_MU (${float(DECK_BELOW_MU)})\n`)
    expect(glsl).toContain('float deckViewShade(float mu, float inside)')
    expect(glsl).toContain('smoothstep(DECK_BELOW_MU, -DECK_HORIZON_MU, mu)')
    expect(glsl).toContain('smoothstep(DECK_HORIZON_MU, DECK_ABOVE_MU, mu)')
    expect(glsl).toContain('return mix(1.0, shape, inside);')
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

describe('deckSunElevation (the Sun cos(zenith) at the eye, tides-ufyr.8.3.2)', () => {
  const eye = { x: 0, y: R * 0.99, z: 0 }
  it('is 1 with the Sun overhead, negative on the far side, about 0 at the terminator', () => {
    expect(deckSunElevation(eye, { x: 0, y: 3, z: 0 })).toBeCloseTo(1, 12)
    expect(deckSunElevation(eye, { x: 0, y: -1, z: 0 })).toBeCloseTo(-1, 12)
    expect(deckSunElevation(eye, { x: 0.6, y: -0.8, z: 0 })).toBeLessThan(0)
    expect(deckSunElevation(eye, { x: 1, y: 0, z: 0 })).toBeCloseTo(0, 12)
    expect(deckSunElevation(eye, { x: 0.6, y: 0.8, z: 0 })).toBeCloseTo(0.8, 12)
  })

  it('falls back to the Sun overhead at zero distance or with no Sun direction', () => {
    expect(deckSunElevation({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBe(1)
    expect(deckSunElevation(eye, { x: 0, y: 0, z: 0 })).toBe(1)
  })
})

// The ship at rest over a deck: the cushion's top, half way from the floor
// to the cloud top (ship-bodies.ts deckRestRadius, tested there).
const restOf = (deck: DeckProfile) => (deck.floor + 1) / 2

describe('deckLayerShow (the layer under the fog, tides-ufyr.4.1)', () => {
  it.each(profiles)('is exactly 0 at and over the cloud top of %s, 1 at rest and at its floor', (_key, deck) => {
    for (const at of [1, 1.001, 1.02, deck.top]) expect(deckLayerShow(R * at, R, deck)).toBe(0)
    expect(deckLayerShow(R * (1 - DECK_LAYER_EASE_HEIGHTS * deck.scaleHeight), R, deck)).toBe(1)
    expect(deckLayerShow(R * restOf(deck), R, deck)).toBe(1)
    expect(deckLayerShow(R * deck.floor, R, deck)).toBe(1)
  })

  it.each(profiles)('rises monotonically and continuously under the cloud top of %s', (_key, deck) => {
    let last = 0
    for (let i = 1; i <= 200; i++) {
      const v = deckLayerShow(R * (1 - (i / 200) * (1 - deck.floor)), R, deck)
      expect(v).toBeGreaterThanOrEqual(last)
      expect(v - last).toBeLessThan(0.1)
      last = v
    }
  })

  it.each(profiles)('is deckInside on %s, at DECK_LAYER_EASE_HEIGHTS 1', (_key, deck) => {
    expect(DECK_LAYER_EASE_HEIGHTS).toBe(1)
    for (let i = 0; i <= 100; i++) {
      const at = R * (1.01 - (i / 100) * (1.01 - deck.floor))
      expect(deckLayerShow(at, R, deck)).toBe(deckInside(at, R, deck))
    }
  })

  it('is off with no layerSeen', () => {
    const deck = { ...DECK_PROFILES.uranus!, layerSeen: 0 }
    expect(deckLayerShow(R * deck.floor, R, deck)).toBe(0)
  })
})

describe('deckLayerHit', () => {
  const level = R * 0.979

  it('is the height over the layer straight down, and none climbing or level', () => {
    for (const r of [R * 0.985, R * 0.9925, R]) {
      expect(deckLayerHit(r, -1, level)).toBeCloseTo(r - level, 12)
      expect(deckLayerHit(r, 0, level)).toBe(Infinity)
      expect(deckLayerHit(r, 0.5, level)).toBe(Infinity)
    }
  })

  it('misses just over the tangent and hits just under it, at about the tangent distance', () => {
    for (const r of [R * 0.985, R * 0.9925, R]) {
      const tangent = -Math.sqrt(1 - (level / r) ** 2)
      expect(deckLayerHit(r, tangent + 1e-6, level)).toBe(Infinity)
      const s = deckLayerHit(r, tangent - 1e-6, level)
      expect(Number.isFinite(s)).toBe(true)
      expect(s / Math.sqrt(r * r - level * level)).toBeCloseTo(1, 2)
    }
  })

  it('is Δ/|mu| over a thin gap Δ, plane-parallel', () => {
    const delta = 1e-6 * R
    for (const mu of [-1, -0.5, -0.2]) {
      expect(deckLayerHit(level + delta, mu, level) / (delta / -mu)).toBeCloseTo(1, 4)
    }
  })

  it('is 0 for an eye at or under the layer', () => {
    expect(deckLayerHit(level, -0.5, level)).toBe(0)
    expect(deckLayerHit(level * 0.99, 0.5, level)).toBe(0)
  })
})

describe('deckLayerWeight', () => {
  it('is none for a miss or with no seen', () => {
    expect(deckLayerWeight(Infinity, 0.01)).toBe(0)
    expect(deckLayerWeight(0.01, 0)).toBe(0)
    expect(deckLayerWeight(0, 0.01)).toBe(1)
  })

  it.each(profiles)("shows %s's layer at the nadir in part, fading toward the horizon, gone at the tangent", (_key, deck) => {
    const level = R * deck.base
    const seen = R * deck.layerSeen
    for (const at of [deck.floor, restOf(deck)]) {
      const r = R * at
      const show = deckLayerShow(r, R, deck)
      const weight = (mu: number) => show * deckLayerWeight(deckLayerHit(r, mu, level), seen)
      const nadir = weight(-1)
      expect(nadir).toBeGreaterThanOrEqual(0.2)
      expect(nadir).toBeLessThanOrEqual(0.7)
      const tangent = -Math.sqrt(1 - (level / r) ** 2)
      let last = nadir
      for (let i = 1; i <= 100; i++) {
        const v = weight(-1 + (i / 100) * (tangent + 1))
        expect(v).toBeLessThanOrEqual(last)
        last = v
      }
      // The shader's cut-off: no seam where the ray stops meeting it.
      expect(show * deckLayerWeight(Math.sqrt(r * r - level * level), seen)).toBeLessThan(1 / 512)
    }
  })

  it('is on for every giant', () => {
    for (const [, deck] of profiles) expect(deck.layerSeen).toBe(DECK_LAYER_SEEN)
    expect(DECK_LAYER_SEEN).toBeGreaterThan(0)
  })
})

describe("insideTint (the albedo's tint in the deck, tides-ufyr.4.1)", () => {
  it.each(profiles)('is none for %s but Jupiter', (key, deck) => {
    expect(deck.insideTint).toEqual(key === 'jupiter' ? JUPITER_INSIDE_TINT : DECK_NO_TINT)
  })

  it("warms Jupiter's fog at its own brightness", () => {
    const [r, g, b] = JUPITER_INSIDE_TINT
    expect(r).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(b)
    expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeCloseTo(1, 2)
    // Subtle: no channel moves by more than a fifth.
    for (const c of JUPITER_INSIDE_TINT) expect(Math.abs(c - 1)).toBeLessThanOrEqual(0.2)
  })
})

describe('deckLayerLight (the layer lit darker than the fog)', () => {
  it.each(profiles)("is DECK_LAYER_LIGHT of the fog's daylight at %s's base, under the eye's", (_key, deck) => {
    expect(DECK_LAYER_LIGHT).toBeLessThan(1)
    for (const mu of [0.2, 0.7, 1]) {
      expect(deckLayerLight(mu, R, deck)).toBeCloseTo(DECK_LAYER_LIGHT * deckDayLight(R * deck.base, mu, R, deck), 12)
      for (const at of [deck.floor, restOf(deck), 1]) {
        expect(deckLayerLight(mu, R, deck)).toBeLessThan(deckDayLight(R * at, mu, R, deck))
      }
    }
    expect(deckLayerLight(-0.2, R, deck)).toBe(0)
  })
})

describe('deckViewShade (which way is down, inside the deck)', () => {
  it('is exactly 1 at inside 0, every way', () => {
    for (let i = 0; i <= 200; i++) expect(deckViewShade(-1 + i / 100, 0)).toBe(1)
  })

  it('is darker down than at the horizon, a little brighter there than up, and 1 straight up', () => {
    expect(deckViewShade(-1, 1)).toBeCloseTo(DECK_BELOW_DIM, 12)
    expect(deckViewShade(DECK_BELOW_MU, 1)).toBeCloseTo(DECK_BELOW_DIM, 12)
    expect(deckViewShade(0, 1)).toBeCloseTo(DECK_HORIZON_GAIN, 12)
    expect(deckViewShade(-DECK_HORIZON_MU, 1)).toBeCloseTo(DECK_HORIZON_GAIN, 12)
    expect(deckViewShade(DECK_ABOVE_MU, 1)).toBeCloseTo(1, 12)
    expect(deckViewShade(1, 1)).toBe(1)
    expect(DECK_BELOW_DIM).toBeLessThan(1)
    expect(DECK_HORIZON_GAIN).toBeGreaterThan(1)
  })

  it('rises to the horizon and falls back above it, continuously', () => {
    let last = deckViewShade(-1, 1)
    for (let i = 1; i <= 400; i++) {
      const mu = -1 + i / 200
      const v = deckViewShade(mu, 1)
      if (mu <= 0) expect(v).toBeGreaterThanOrEqual(last - 1e-12)
      else expect(v).toBeLessThanOrEqual(last + 1e-12)
      expect(Math.abs(v - last)).toBeLessThan(0.02)
      last = v
    }
  })

  it('blends in by inside', () => {
    expect(deckViewShade(-0.8, 0.5)).toBeCloseTo(1 + 0.5 * (DECK_BELOW_DIM - 1), 12)
  })
})

describe('the view inside at the Uranus and Neptune stop (tides-ufyr.4.1)', () => {
  // The phone's pose, floor + 0.0005 R, the Sun overhead, the fog's colour
  // lit as deck.frag does inside (uSunIntensity 5, an ambient of 0.14) and
  // the albedo the same at both points: the shade a ray gets over the
  // horizon's, before tone mapping.
  const lit = (light: number) => 5 * light + 0.14
  it.each(['uranus', 'neptune'] as const)('is darker at the bottom of the screen than at the horizon on %s', (key) => {
    const deck = DECK_PROFILES[key]!
    const r = R * (deck.floor + 0.0005)
    const show = deckLayerShow(r, R, deck)
    const inside = deckInside(r, R, deck)
    const fog = lit(deckDayLight(r, 1, R, deck))
    const layer = lit(deckLayerLight(1, R, deck))
    const shade = (mu: number) => {
      const w = show * deckLayerWeight(deckLayerHit(r, mu, R * deck.base), R * deck.layerSeen)
      return (1 - w + (w * layer) / fog) * deckViewShade(mu, inside)
    }
    const horizon = shade(0)
    // The bottom of a level 60-degree view and a little below it.
    for (const mu of [-0.5, -0.6]) {
      const ratio = shade(mu) / horizon
      expect(ratio).toBeGreaterThan(0.5)
      expect(ratio).toBeLessThan(0.62)
    }
    // Straight ahead, pitched 6 degrees down, under the horizon band.
    expect(shade(-Math.sin((6 * Math.PI) / 180))).toBeLessThan(horizon)
    expect(shade(0.4)).toBeLessThan(horizon)
  })
})

describe("Jupiter's tint, from its haze sky", () => {
  it('is half way from white to #f2d9b0 in linear light, at a luminance of 1', () => {
    const linear = (c: number) => ((c / 255 + 0.055) / 1.055) ** 2.4
    const sky = [0xf2, 0xd9, 0xb0].map(linear)
    const half = sky.map((c) => (1 + c / Math.max(...sky)) / 2)
    const luminance = 0.2126 * half[0] + 0.7152 * half[1] + 0.0722 * half[2]
    half.forEach((c, i) => expect(JUPITER_INSIDE_TINT[i]).toBeCloseTo(c / luminance, 3))
  })
})
