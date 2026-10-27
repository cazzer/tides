import { describe, expect, it } from 'vitest'
import { Body, HelioVector, KM_PER_AU, PlanetOrbitalPeriod } from 'astronomy-engine'
import { MOON_UNITS_PER_KM, earthPosition, moonPosition, type Vec3 } from './ephemeris'
import {
  PLANETS,
  PLANET_KEYS,
  planetOrbitPath,
  planetPosition,
  sceneDistance,
  sceneRadius,
} from './planets'
import {
  FLIGHT_KM_PER_UNIT,
  FLIGHT_UNITS_PER_AU,
  flightDistance,
  flightEarthPosition,
  flightMoonPosition,
  flightOrbitPath,
  flightPlanetPosition,
  flightRadii,
  positionsFor,
} from './flight-scale'
import { MAX_TRUESCALE } from './truescale'
import { EARTH_KM_PER_UNIT } from './surface-handover'
import { COLLISION_MARGIN } from './ship/flight'
import { EARTH_SHELL_RADIUS } from './ship/ship-bodies'
import { MOON_PARENTS, moonOrbitRadiiAt, moonRadiiAt, moonsOf, type MoonParent } from './moons/moons'
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
  // tides-rg9 re-recorded Jupiter to Neptune for its wider log tail (the
  // same directions, only the radii moved); the rest is still ad6cfd0's.
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

  it("is positionsFor('system'), bit-for-bit", () => {
    const { positionAt, orbitPath, distance } = positionsFor('system')
    expect(distance).toBe(sceneDistance)
    expect(times.map((t) => bits(positionAt.earth(t)))).toEqual(golden.earth)
    expect(times.map((t) => bits(positionAt.moon(t)))).toEqual(golden.moon)
    expect(positionAt.sun(T)).toEqual([0, 0, 0])
    for (const key of PLANET_KEYS) {
      expect(times.map((t) => bits(positionAt[key](t)))).toEqual(
        golden.planets[key as keyof typeof golden.planets]
      )
    }
    expect(bits(orbitPath('mars', times[3], 8))).toEqual(golden.marsOrbit)
    expect(bits(orbitPath('neptune', times[1], 8))).toEqual(golden.neptuneOrbit)
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
    expect(flight.distance).toBe(flightDistance)
    expect(flight.distance(30)).toBe(30 * X)
    expect(flight.positionAt.earth(T)).toEqual(flightEarthPosition(T))
    expect(flight.positionAt.moon(T)).toEqual(flightMoonPosition(T))
    expect(flight.positionAt.sun(T)).toEqual([0, 0, 0])
    for (const key of PLANET_KEYS) {
      expect(flight.positionAt[key](T)).toEqual(flightPlanetPosition(PLANETS[key].body)(T))
      expect(flight.orbitPath(key, T, 8)).toEqual(flightOrbitPath(PLANETS[key].body, T, 8))
    }
    expect(flight.orbitPath('earth', T, 8)).toEqual(flightOrbitPath(Body.Earth, T, 8))
  })

  it('reuses the last position while t is unchanged', () => {
    for (const scale of ['system', 'flight'] as const) {
      const { positionAt } = positionsFor(scale)
      for (const key of ['earth', 'moon', 'jupiter'] as const) {
        const first = positionAt[key](T)
        // Same t: the very same array, no recompute.
        expect(positionAt[key](T)).toBe(first)
        // A new t: a new position, and the old t recomputes to equal values.
        const later = positionAt[key](T + DAY)
        expect(later).not.toBe(first)
        expect(later).not.toEqual(first)
        expect(positionAt[key](T)).toEqual(first)
      }
    }
  })
})

describe('?truescale radii (tides-o39)', () => {
  const KEYS = ['sun', 'earth', 'moon', ...PLANET_KEYS] as const
  const TRUE_KM: Record<(typeof KEYS)[number], number> = {
    sun: 696_350,
    earth: 6371,
    moon: 1737.4,
    ...(Object.fromEntries(PLANET_KEYS.map((key) => [key, PLANETS[key].diameter / 2000])) as Record<
      (typeof PLANET_KEYS)[number],
      number
    >),
  }

  it('is the system radii at a = 0, and in flight without the flag', () => {
    const system = positionsFor('system').radius
    expect(flightRadii(0)).toBe(system)
    expect(positionsFor('flight').radius).toBe(system)
    expect(system.sun).toBe(sceneRadius(1392700000))
    expect(system.moon).toBe(sceneRadius(3474800))
    for (const key of PLANET_KEYS) expect(system[key]).toBe(PLANETS[key].radius)
  })

  it('keeps Earth at its scene radius at every a', () => {
    for (const a of [0, 0.25, 0.5, MAX_TRUESCALE, 1]) {
      expect(flightRadii(a).earth).toBe(sceneRadius(12742000))
    }
  })

  it('moves every other radius monotonically toward true', () => {
    const steps = [0, 0.1, 0.3, 0.5, 0.7, MAX_TRUESCALE, 1]
    for (const key of KEYS) {
      const truth = TRUE_KM[key] / EARTH_KM_PER_UNIT
      const r = steps.map((a) => flightRadii(a)[key])
      for (let i = 1; i < r.length; i++) {
        expect(Math.abs(Math.log(r[i] / truth)), key).toBeLessThanOrEqual(
          Math.abs(Math.log(r[i - 1] / truth)) + 1e-12
        )
      }
      expect(r[r.length - 1], key).toBeCloseTo(truth, 9)
    }
  })

  // 1900–2100 at the flight scale: Mercury daily (its perihelion against the
  // grown Sun is the tight one), everything monthly.
  const START = Date.UTC(1900, 0, 1)
  const END = Date.UTC(2100, 0, 1)
  const { positionAt } = positionsFor('flight')
  const mercuryR: number[] = []
  for (let t = START; t <= END; t += DAY) mercuryR.push(len(positionAt.mercury(t)))
  const months: number[] = []
  for (let t = START; t <= END; t += 30 * DAY) months.push(t)
  const centres = months.map((t) =>
    Object.fromEntries(
      (['earth', ...PLANET_KEYS] as const).map((key) => [key, [...positionAt[key](t)] as Vec3])
    )
  )
  const minMercury = Math.min(...mercuryR)

  // How far each body reaches from its centre at a: its shell (the ship's
  // collision margin), its rings, its moons, Earth's Moon's apogee.
  function extents(a: number): Record<string, number> {
    const radius = flightRadii(a)
    const moonRadius = moonRadiiAt(a)
    const moonOrbit = moonOrbitRadiiAt(a)
    const systemExtent = (parent: MoonParent) =>
      Math.max(...moonsOf(parent).map((key) => moonOrbit[key] + moonRadius[key]))
    const out: Record<string, number> = {
      earth: Math.max(radius.earth * COLLISION_MARGIN, 406_700 * MOON_UNITS_PER_KM + radius.moon),
    }
    for (const key of PLANET_KEYS) {
      const own = radius[key] * Math.max(COLLISION_MARGIN, PLANETS[key].rings?.outer ?? 1)
      out[key] = (MOON_PARENTS as readonly string[]).includes(key)
        ? Math.max(own, systemExtent(key as MoonParent))
        : own
    }
    return out
  }

  it.each([0.5, MAX_TRUESCALE])('keeps the Sun 20+ units clear of Mercury at a = %f', (a) => {
    const radius = flightRadii(a)
    expect(radius.sun * COLLISION_MARGIN + radius.mercury * COLLISION_MARGIN + 20).toBeLessThan(minMercury)
  })

  it('runs Mercury into the Sun at a = 1, hence MAX_TRUESCALE', () => {
    const radius = flightRadii(1)
    expect(radius.sun * COLLISION_MARGIN + radius.mercury * COLLISION_MARGIN).toBeGreaterThan(minMercury)
  })

  it.each([0.5, MAX_TRUESCALE])('keeps every body and moon system apart at a = %f', (a) => {
    const reach = extents(a)
    const sun = flightRadii(a).sun * COLLISION_MARGIN
    const keys = Object.keys(reach)
    for (const at of centres) {
      for (let i = 0; i < keys.length; i++) {
        const p = at[keys[i]]
        expect(len(p) - reach[keys[i]] - sun, `sun–${keys[i]}`).toBeGreaterThan(0)
        for (let j = i + 1; j < keys.length; j++) {
          const gap = dist(p, at[keys[j]]) - reach[keys[i]] - reach[keys[j]]
          expect(gap, `${keys[i]}–${keys[j]}`).toBeGreaterThan(0)
        }
      }
    }
  })

  it.each([0.5, MAX_TRUESCALE])("keeps Earth's Moon off Earth's shells at a = %f", (a) => {
    const radius = flightRadii(a)
    // The Moon's perigee never passes inside ~356 400 km.
    expect(radius.earth).toBe(positionsFor('system').radius.earth)
    expect(356_400 * MOON_UNITS_PER_KM - radius.moon).toBeGreaterThan(EARTH_SHELL_RADIUS + 5)
  })
})
