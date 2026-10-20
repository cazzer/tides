import { describe, expect, it } from 'vitest'
import { Body, Ecliptic, GeoVector, Seasons } from 'astronomy-engine'
import {
  LUNAR_WINDOW_MS,
  QuarterCache,
  ZODIAC_SIGNS,
  glyphOpacity,
  moonQuartersBetween,
  zodiacSignIndex,
  type LunarEvent,
} from './calendar-rings'
import { earthAngle, moonPosition } from './ephemeris'

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const DEG = Math.PI / 180

function sceneAngle([x, , z]: [number, number, number]): number {
  return Math.atan2(-z, x)
}

function angleBetween(a: number, b: number): number {
  const d = a - b
  return Math.abs(d - 2 * Math.PI * Math.round(d / (2 * Math.PI)))
}

describe('moonQuartersBetween', () => {
  const fullMoon = moonQuartersBetween(
    Date.parse('2026-03-01T00:00:00Z'),
    Date.parse('2026-03-05T00:00:00Z')
  ).find((e) => e.quarter === 2)!

  it('finds the 2026-03-03 full moon at Earth’s angle on that date', () => {
    expect(fullMoon).toBeDefined()
    expect(
      Math.abs(fullMoon.t - Date.parse('2026-03-03T11:38:32Z'))
    ).toBeLessThan(60_000)
  })

  // A full moon sits outside Earth's orbit on the Sun–Earth line and a new
  // moon inside it, so the scene's own Moon checks the glyph's angle.
  it('puts a full moon where the scene’s Moon is opposite the Sun', () => {
    const moon = moonPosition(fullMoon.t)
    expect(Math.hypot(moon[0], moon[2])).toBeGreaterThan(58)
    expect(angleBetween(sceneAngle(moon), fullMoon.angle)).toBeLessThan(DEG)
  })

  it('puts a new moon where the scene’s Moon is between Sun and Earth', () => {
    const newMoon = moonQuartersBetween(fullMoon.t, fullMoon.t + 20 * DAY).find(
      (e) => e.quarter === 0
    )!
    const moon = moonPosition(newMoon.t)
    expect(Math.hypot(moon[0], moon[2])).toBeLessThan(42)
    expect(angleBetween(sceneAngle(moon), newMoon.angle)).toBeLessThan(DEG)
  })

  it('cycles new, first, full, last', () => {
    const events = moonQuartersBetween(fullMoon.t, fullMoon.t + 60 * DAY)
    events.forEach((e, i) => {
      if (i > 0) expect(e.quarter).toBe((events[i - 1].quarter + 1) % 4)
    })
  })
})

describe('zodiacSignIndex', () => {
  const equinox = Seasons(2026).mar_equinox.date.getTime()

  it('turns from Pisces to Aries at the March equinox', () => {
    expect(ZODIAC_SIGNS[zodiacSignIndex(earthAngle(equinox - HOUR))]).toBe(
      'Pisces'
    )
    expect(ZODIAC_SIGNS[zodiacSignIndex(earthAngle(equinox + HOUR))]).toBe(
      'Aries'
    )
  })

  // Against the Sun's geocentric longitude from its position vector (J2000
  // ecliptic, ~0.4° from the ecliptic of date) rather than SunPosition, which
  // earthAngle uses.
  it.each([
    ['2026-04-05T12:00:00Z', 'Aries'],
    ['2026-07-30T12:00:00Z', 'Leo'],
    ['2026-12-25T12:00:00Z', 'Capricorn'],
  ])('puts %s in %s', (iso, sign) => {
    const date = new Date(iso)
    const sunLon = Ecliptic(GeoVector(Body.Sun, date, true)).elon * DEG
    expect(ZODIAC_SIGNS[zodiacSignIndex(sunLon)]).toBe(sign)
    expect(ZODIAC_SIGNS[zodiacSignIndex(earthAngle(date.getTime()))]).toBe(
      sign
    )
  })

  it('wraps angles outside one turn', () => {
    expect(zodiacSignIndex(-1e-9)).toBe(11)
    expect(zodiacSignIndex(2 * Math.PI + 1e-9)).toBe(0)
    expect(zodiacSignIndex(-Math.PI / 2)).toBe(9)
  })
})

describe('glyphOpacity', () => {
  it('is opaque well inside the window and hidden at its edge', () => {
    expect(glyphOpacity(0)).toBe(1)
    expect(glyphOpacity(-100 * DAY)).toBe(1)
    expect(glyphOpacity(LUNAR_WINDOW_MS)).toBe(0)
    expect(glyphOpacity(-LUNAR_WINDOW_MS - DAY)).toBe(0)
  })

  it('fades monotonically toward the edge', () => {
    let previous = 1
    for (let d = 160; d <= 180; d += 0.25) {
      const opacity = glyphOpacity(d * DAY)
      expect(opacity).toBeLessThanOrEqual(previous)
      expect(glyphOpacity(-d * DAY)).toBe(opacity)
      previous = opacity
    }
  })
})

describe('QuarterCache', () => {
  const MARGIN = 200 * DAY

  function expectMatches(actual: LunarEvent[], expected: LunarEvent[]) {
    expect(actual.map((e) => e.quarter)).toEqual(expected.map((e) => e.quarter))
    actual.forEach((e, i) => {
      expect(Math.abs(e.t - expected[i].t)).toBeLessThan(1000)
    })
  }

  it('matches a fresh search while stepping, reversing and jumping', () => {
    const start = Date.parse('2026-01-01T00:00:00Z')
    const steps = 2 * 365
    // One long search, sliced per step, keeps the oracle cheap.
    const reference = moonQuartersBetween(
      start - MARGIN - DAY,
      start + steps * DAY + MARGIN + DAY
    )
    const window = (now: number) =>
      reference.filter((e) => e.t > now - MARGIN && e.t <= now + MARGIN)

    const cache = new QuarterCache()
    for (let d = 0; d <= steps; d++) {
      const now = start + d * DAY
      cache.update(now)
      expectMatches(cache.events, window(now))
    }
    for (let d = steps; d >= 0; d--) {
      const now = start + d * DAY
      cache.update(now)
      expectMatches(cache.events, window(now))
    }

    const later = start + 10 * 365 * DAY
    cache.update(later)
    expectMatches(
      cache.events,
      moonQuartersBetween(later - MARGIN, later + MARGIN)
    )
  })

  it.each([-399, -150, 150, 399])(
    'stays whole across a %i-day step, short of a rebuild',
    (days) => {
      const now = Date.parse('2026-06-01T00:00:00Z')
      const cache = new QuarterCache()
      cache.update(now)
      const then = now + days * DAY
      cache.update(then)
      expectMatches(
        cache.events,
        moonQuartersBetween(then - MARGIN, then + MARGIN)
      )
    }
  )
})
