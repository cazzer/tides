import { describe, expect, it } from 'vitest'
import { Body, HelioVector, KM_PER_AU, PlanetOrbitalPeriod } from 'astronomy-engine'
import { earthPosition, moonPosition, type Vec3 } from './ephemeris'
import { PLANETS, PLANET_KEYS, planetOrbitPath, planetPosition } from './planets'
import {
  FLIGHT_KM_PER_UNIT,
  FLIGHT_UNITS_PER_AU,
  flightEarthPosition,
  flightMoonPosition,
  flightOrbitPath,
  flightPlanetPosition,
  positionsFor,
} from './flight-scale'
import golden from './flight-scale.golden.json'

const X = FLIGHT_UNITS_PER_AU
const DAY = 86_400_000
const T = Date.UTC(2026, 9, 22, 12)
const ARCSEC = Math.PI / 180 / 3600

// Float64 bits as hex, so -0, NaN and the last ulp all count.
function bits(xs: ArrayLike<number>): string[] {
  const view = new DataView(new ArrayBuffer(8))
  return Array.from(xs, (x) => {
    view.setFloat64(0, x)
    return view.getBigUint64(0).toString(16).padStart(16, '0')
  })
}

const len = ([x, y, z]: Vec3) => Math.hypot(x, y, z)
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dist = (a: Vec3, b: Vec3) => len(sub(a, b))
function angle(a: Vec3, b: Vec3): number {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  // atan2 of |a × b| and a · b stays accurate at tiny angles.
  const cx = a[1] * b[2] - a[2] * b[1]
  const cy = a[2] * b[0] - a[0] * b[2]
  const cz = a[0] * b[1] - a[1] * b[0]
  return Math.atan2(Math.hypot(cx, cy, cz), dot)
}
function helioAu(body: Body, t: number): Vec3 {
  const { x, y, z } = HelioVector(body, new Date(t))
  return [x, y, z]
}

describe('system view (golden, recorded before tides-2hv.6)', () => {
  // flight-scale.golden.json was written from main at ad6cfd0, before
  // heliocentricScene took a distance function or moonPosition was split.
  const { times } = golden

  it('places every planet bit-for-bit as before', () => {
    for (const key of PLANET_KEYS) {
      const at = planetPosition(PLANETS[key].body)
      expect(times.map((t) => bits(at(t)))).toEqual(
        golden.planets[key as keyof typeof golden.planets]
      )
    }
  })

  it('draws orbit paths bit-for-bit as before', () => {
    expect(bits(planetOrbitPath(Body.Mars, times[3], 8))).toEqual(golden.marsOrbit)
    expect(bits(planetOrbitPath(Body.Neptune, times[1], 8))).toEqual(golden.neptuneOrbit)
  })

  it('places Earth and the Moon bit-for-bit as before', () => {
    expect(times.map((t) => bits(earthPosition(t)))).toEqual(golden.earth)
    expect(times.map((t) => bits(moonPosition(t)))).toEqual(golden.moon)
  })

  it("is positionsFor('system')", () => {
    const { positionAt, orbitPath } = positionsFor('system')
    expect(positionAt.earth).toBe(earthPosition)
    expect(positionAt.moon).toBe(moonPosition)
    expect(positionAt.sun(T)).toEqual([0, 0, 0])
    for (const key of PLANET_KEYS) {
      expect(bits(positionAt[key](T))).toEqual(bits(planetPosition(PLANETS[key].body)(T)))
    }
    expect(bits(orbitPath(Body.Mars, times[3], 8))).toEqual(golden.marsOrbit)
  })
})

describe('flight scale', () => {
  it('is linear at FLIGHT_UNITS_PER_AU', () => {
    expect(FLIGHT_UNITS_PER_AU).toBe(1000)
    expect(FLIGHT_KM_PER_UNIT).toBeCloseTo(KM_PER_AU / 1000, 6)
  })

  it('keeps each planet in its system-view direction, at X times its true distance', () => {
    for (const t of [T, Date.UTC(1950, 3, 1), Date.UTC(2090, 7, 15)]) {
      for (const key of PLANET_KEYS) {
        const { body } = PLANETS[key]
        const flight = flightPlanetPosition(body)(t)
        expect(angle(flight, planetPosition(body)(t))).toBeLessThan(1e-12)
        expect(len(flight) / (X * len(helioAu(body, t)))).toBeCloseTo(1, 9)
      }
    }
  })

  it('spaces planets X times their true separation', () => {
    for (const [a, b] of [
      [Body.Earth, Body.Mars],
      [Body.Venus, Body.Earth],
      [Body.Jupiter, Body.Saturn],
    ] as const) {
      const flight = dist(flightPlanetPosition(a)(T), flightPlanetPosition(b)(T))
      expect(flight / (X * dist(helioAu(a, T), helioAu(b, T)))).toBeCloseTo(1, 9)
    }
    // Earth–Mars through flightEarthPosition, as the HUD sees it.
    const earthMars = dist(flightEarthPosition(T), flightPlanetPosition(Body.Mars)(T))
    expect(earthMars / (X * dist(helioAu(Body.Earth, T), helioAu(Body.Mars, T)))).toBeCloseTo(1, 9)
  })

  it("puts Earth at its true distance, in the system Earth's direction", () => {
    for (let day = 0; day < 366; day += 7) {
      const t = T + day * DAY
      const earth = flightEarthPosition(t)
      expect(len(earth) / X).toBeGreaterThan(0.983)
      expect(len(earth) / X).toBeLessThan(1.017)
      // Within ~1″ of the ecliptic (the Earth–Moon barycentre is on it).
      expect(Math.abs(earth[1])).toBeLessThan(0.01)
      // The system Earth is placed by the Sun's apparent longitude, which
      // aberration (~20.5″) shifts off the geometric direction.
      expect(angle(earth, earthPosition(t))).toBeLessThan(30 * ARCSEC)
    }
  })

  it("offsets the Moon from Earth exactly as the system view does (~10 units)", () => {
    for (let day = 0; day < 30; day += 2) {
      const t = T + day * DAY
      const flight = sub(flightMoonPosition(t), flightEarthPosition(t))
      const system = sub(moonPosition(t), earthPosition(t))
      for (let i = 0; i < 3; i++) expect(flight[i]).toBeCloseTo(system[i], 9)
      expect(len(flight)).toBeGreaterThan(9)
      expect(len(flight)).toBeLessThan(11)
    }
  })

  it('draws orbit paths through the body, within its true perihelion and aphelion', () => {
    const segments = 64
    for (const body of [Body.Mercury, Body.Earth, Body.Mars, Body.Neptune]) {
      const path = flightOrbitPath(body, T, segments)
      // Point segments/2 sits at path time t itself.
      const mid = Array.from(path.subarray((segments / 2) * 3, (segments / 2) * 3 + 3))
      const at = flightPlanetPosition(body)(T)
      // Float32 storage: relative error ~6e-8.
      expect(dist(mid as Vec3, at) / len(at)).toBeLessThan(1e-6)

      const period = PlanetOrbitalPeriod(body) * DAY
      let q = Infinity
      let Q = 0
      for (let i = 0; i < 720; i++) {
        const r = len(helioAu(body, T + (i / 720 - 0.5) * period))
        q = Math.min(q, r)
        Q = Math.max(Q, r)
      }
      for (let i = 0; i < segments; i++) {
        const r = Math.hypot(path[i * 3], path[i * 3 + 1], path[i * 3 + 2]) / X
        expect(r).toBeGreaterThan(q * (1 - 1e-4))
        expect(r).toBeLessThan(Q * (1 + 1e-4))
      }
    }
  })

  it("is positionsFor('flight'), with stable identities", () => {
    const flight = positionsFor('flight')
    expect(positionsFor('flight')).toBe(flight)
    expect(positionsFor('system')).not.toBe(flight)
    expect(flight.positionAt.earth).toBe(flightEarthPosition)
    expect(flight.positionAt.moon).toBe(flightMoonPosition)
    expect(flight.positionAt.sun(T)).toEqual([0, 0, 0])
    for (const key of PLANET_KEYS) {
      expect(flight.positionAt[key](T)).toEqual(flightPlanetPosition(PLANETS[key].body)(T))
    }
    expect(flight.orbitPath(Body.Mars, T, 8)).toEqual(flightOrbitPath(Body.Mars, T, 8))
  })
})
