import * as THREE from 'three'
import { MakeTime, Observer, SearchLocalSolarEclipse } from 'astronomy-engine'
import { describe, expect, it } from 'vitest'
import { coveredFraction } from './eclipse'
import {
  CORONA_SHOW_VISIBLE,
  coronaFade,
  eclipseDaylight,
  eclipseMoonDirection,
  eclipseSkyAt,
  matchedMoonDistance,
  skyOffset,
} from './eclipse-sky'

// The 2024-04-08 total solar eclipse from Torreón and Dallas. The contacts
// come from astronomy-engine's own search, independent of sunVisibleFraction.

const SECOND = 1000
const DEG = Math.PI / 180

const places = [
  ['Torreón', 25.54, -103.41],
  ['Dallas', 32.78, -96.8],
] as const

function contacts(lat: number, lon: number) {
  const e = SearchLocalSolarEclipse(MakeTime(new Date('2024-04-01T00:00:00Z')), new Observer(lat, lon, 0))
  return {
    partialBegin: e.partial_begin.time.date.getTime(),
    totalBegin: e.total_begin!.time.date.getTime(),
    peak: e.peak.time.date.getTime(),
    totalEnd: e.total_end!.time.date.getTime(),
  }
}

describe('eclipseSkyAt', () => {
  it.each(places)('%s: the Sun is hidden through totality and only then', (_, lat, lon) => {
    const c = contacts(lat, lon)
    expect(eclipseSkyAt(c.totalBegin + 10 * SECOND, lat, lon).visible).toBe(0)
    expect(eclipseSkyAt(c.totalEnd - 10 * SECOND, lat, lon).visible).toBe(0)
    expect(eclipseSkyAt(c.totalBegin - 15 * SECOND, lat, lon).visible).toBeGreaterThan(0)
    expect(eclipseSkyAt(c.totalEnd + 15 * SECOND, lat, lon).visible).toBeGreaterThan(0)
    expect(eclipseSkyAt(c.partialBegin - 60 * SECOND, lat, lon).visible).toBe(1)
  })

  it('Torreón at 17:49:07 UTC: about 43% of the Sun shows', () => {
    const e = eclipseSkyAt(Date.parse('2024-04-08T17:49:07Z'), 25.54, -103.41)
    expect(Math.abs(e.visible - 0.43)).toBeLessThan(0.03)
  })

  it('Dallas: totality within 18:40–18:44 UTC, as eclipse.test.ts has it', () => {
    expect(eclipseSkyAt(Date.parse('2024-04-08T18:39:30Z'), 32.78, -96.8).visible).toBeGreaterThan(0)
    expect(eclipseSkyAt(Date.parse('2024-04-08T18:42:00Z'), 32.78, -96.8).visible).toBe(0)
    expect(eclipseSkyAt(Date.parse('2024-04-08T18:45:00Z'), 32.78, -96.8).visible).toBeGreaterThan(0)
  })

  it('Torreón at greatest eclipse: the Moon just larger than the Sun, the Sun high', () => {
    const c = contacts(25.54, -103.41)
    const e = eclipseSkyAt(c.peak, 25.54, -103.41)
    const ratio = e.moonRadius / e.sunRadius
    expect(ratio).toBeGreaterThan(1)
    expect(ratio).toBeLessThan(1.1)
    expect(Math.asin(e.sunSinAltitude) / DEG).toBeGreaterThan(65)
  })

  it('returns unit directions', () => {
    const e = eclipseSkyAt(Date.parse('2024-04-08T18:00:00Z'), 25.54, -103.41)
    expect(e.sun.length()).toBeCloseTo(1, 12)
    expect(e.moon.length()).toBeCloseTo(1, 12)
  })
})

describe('skyOffset', () => {
  const k = 43.3
  const contact = 0.55 * DEG

  it('is k times the separation up to contact, continuous there, and increasing', () => {
    expect(skyOffset(0.2 * DEG, contact, k)).toBeCloseTo(k * 0.2 * DEG, 12)
    expect(Math.abs(skyOffset(contact + 1e-12, contact, k) - skyOffset(contact, contact, k))).toBeLessThan(1e-11)
    let previous = -1
    for (let s = 0; s < Math.PI; s += 0.01 * DEG) {
      const offset = skyOffset(s, contact, k)
      expect(offset).toBeGreaterThanOrEqual(previous)
      expect(offset).toBeLessThanOrEqual(Math.PI)
      previous = offset
    }
  })

  it('keeps every phase’s coverage exactly', () => {
    const rs = 0.2662 * DEG
    const rm = 0.2813 * DEG
    for (let f = 0.01; f < 1; f += 0.01) {
      const separation = f * (rs + rm)
      const drawn = coveredFraction(k * rs, k * rm, skyOffset(separation, rs + rm, k))
      expect(Math.abs(drawn - coveredFraction(rs, rm, separation))).toBeLessThan(1e-9)
    }
  })
})

describe('eclipseMoonDirection', () => {
  const c = contacts(25.54, -103.41)

  it.each([
    ['mid-partial', Date.parse('2024-04-08T17:49:07Z')],
    ['totality', c.peak],
    ['an hour after', c.peak + 3600 * SECOND],
  ])('%s: turned from the Sun by skyOffset, toward the Moon', (_, t) => {
    const e = eclipseSkyAt(t, 25.54, -103.41)
    const k = 43.3
    const drawn = eclipseMoonDirection(e, k)
    expect(drawn.angleTo(e.sun)).toBeCloseTo(skyOffset(e.separation, e.sunRadius + e.moonRadius, k), 9)
    const normal = new THREE.Vector3().crossVectors(e.sun, e.moon).normalize()
    expect(Math.abs(drawn.dot(normal))).toBeLessThan(1e-9)
  })

  it('at totality the drawn Moon covers the drawn Sun', () => {
    const e = eclipseSkyAt(c.peak, 25.54, -103.41)
    const k = 43.3
    const offset = eclipseMoonDirection(e, k).angleTo(e.sun)
    expect(offset + k * e.sunRadius).toBeLessThanOrEqual(k * e.moonRadius)
  })
})

describe('matchedMoonDistance', () => {
  it('draws the Moon to the Sun’s scale', () => {
    const sunScene = Math.asin(10 / 50)
    const sunTrue = 0.2662 * DEG
    const moonTrue = 0.2813 * DEG
    const k = sunScene / sunTrue
    const moonScene = Math.asin(1.5 / matchedMoonDistance(1.5, k, moonTrue))
    expect(Math.abs(moonScene / sunScene - moonTrue / sunTrue)).toBeLessThan(1e-6)
  })
})

describe('eclipseDaylight', () => {
  it('is full under a high whole Sun, gone when it is hidden or set', () => {
    expect(eclipseDaylight(1, Math.sin(60 * DEG))).toBe(1)
    expect(eclipseDaylight(0, Math.sin(60 * DEG))).toBe(0)
    expect(eclipseDaylight(1, Math.sin(-10 * DEG))).toBe(0)
  })
})

describe('coronaFade', () => {
  it('is full once the Sun is hidden and gone while any of it shows much', () => {
    expect(coronaFade(0)).toBe(1)
    expect(coronaFade(CORONA_SHOW_VISIBLE)).toBe(0)
    expect(coronaFade(0.5)).toBe(0)
    let previous = 2
    for (let v = 0; v <= CORONA_SHOW_VISIBLE; v += CORONA_SHOW_VISIBLE / 50) {
      expect(coronaFade(v)).toBeLessThanOrEqual(previous)
      previous = coronaFade(v)
    }
  })
})
