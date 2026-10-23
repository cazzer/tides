import * as THREE from 'three'
import { describe, expect, test } from 'vitest'
import {
  Body,
  Ecliptic,
  HelioDistance,
  HelioVector,
  RotateVector,
  RotationAxis,
  Rotation_EQJ_ECT,
} from 'astronomy-engine'
import {
  EARTH_ORBIT_RADIUS,
  MOON_UNITS_PER_KM,
  earthPosition,
  moonOrientation,
} from './ephemeris'
import {
  PLANETS,
  PLANET_KEYS,
  bodyOrientation,
  planetOrbitPath,
  planetPosition,
  sceneDistance,
  sceneRadius,
} from './planets'

const DEG = 180 / Math.PI
const MS_PER_DAY = 86_400_000
const SUN_RADIUS = 10
const MOON_RADIUS = 1
// Largest geocentric Moon distance of the century, km.
const MOON_MAX_APOGEE_KM = 406_720
const MOON_ENVELOPE = MOON_MAX_APOGEE_KM * MOON_UNITS_PER_KM + MOON_RADIUS

const DATES = [
  '1975-03-14T06:00:00Z',
  '2000-01-01T12:00:00Z',
  '2026-10-19T00:00:00Z',
  '2061-07-28T18:30:00Z',
].map((d) => Date.parse(d))

function wrap180(deg: number): number {
  return deg - 360 * Math.round(deg / 360)
}

// Perihelion/aphelion distances over 1900–2100 (at least one full period),
// sampled every 2° of mean anomaly.
function distanceRange(body: Body, period: number): [number, number] {
  const start = Date.UTC(1900, 0, 1)
  const end = Math.max(Date.UTC(2100, 0, 1), start + period * MS_PER_DAY)
  const step = (period * MS_PER_DAY) / 180
  let q = Infinity
  let Q = -Infinity
  for (let t = start; t <= end; t += step) {
    const r = HelioDistance(body, new Date(t))
    q = Math.min(q, r)
    Q = Math.max(Q, r)
  }
  return [q, Q]
}

const bands = PLANET_KEYS.map((key) => {
  const p = PLANETS[key]
  const [q, Q] = distanceRange(p.body, p.period)
  const extent = p.radius * (p.rings?.outer ?? 1)
  return {
    key,
    min: sceneDistance(q) - extent,
    max: sceneDistance(Q) + extent,
  }
})
const band = Object.fromEntries(bands.map((b) => [b.key, b]))

describe('sceneDistance', () => {
  test('puts 1 AU exactly on the Earth’s orbit', () => {
    expect(sceneDistance(1)).toBe(EARTH_ORBIT_RADIUS)
  })

  test('is strictly increasing', () => {
    let prev = sceneDistance(0.01)
    for (let r = 0.02; r <= 40; r += 0.01) {
      const f = sceneDistance(r)
      expect(f).toBeGreaterThan(prev)
      prev = f
    }
  })

  test('is continuous where the log tail starts', () => {
    expect(sceneDistance(1.7 + 1e-9)).toBeCloseTo(sceneDistance(1.7), 6)
  })
})

describe('planet bands', () => {
  test('Mercury’s perihelion surface clears the Sun', () => {
    expect(band.mercury.min).toBeGreaterThanOrEqual(SUN_RADIUS + 1.5)
  })

  test('consecutive planets never overlap (incl. rings)', () => {
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].min).toBeGreaterThan(bands[i - 1].max)
    }
  })

  test('Venus and Mars stay off the Moon’s orbit', () => {
    expect(band.venus.max).toBeLessThan(EARTH_ORBIT_RADIUS - MOON_ENVELOPE)
    expect(band.mars.min).toBeGreaterThan(EARTH_ORBIT_RADIUS + MOON_ENVELOPE)
  })

  test('Neptune’s aphelion surface is 440–470 out', () => {
    expect(band.neptune.max).toBeLessThanOrEqual(470)
    expect(band.neptune.max).toBeGreaterThanOrEqual(440)
  })

  test('leaves 30+ units between the giant planets (tides-rg9)', () => {
    const giants = bands.slice(PLANET_KEYS.indexOf('jupiter'))
    for (let i = 1; i < giants.length; i++) {
      expect(giants[i].min - giants[i - 1].max, giants[i].key).toBeGreaterThan(30)
    }
  })
})

describe('catalog', () => {
  test('uses the Sun/Earth/Moon diameter scale', () => {
    expect(sceneRadius(3474800)).toBeCloseTo(1, 12)
    expect(sceneRadius(1392700000)).toBeCloseTo(10, 12)
    for (const key of PLANET_KEYS) {
      const p = PLANETS[key]
      expect(p.key).toBe(key)
      expect(p.radius).toBe(sceneRadius(p.diameter))
    }
    expect(PLANETS.jupiter.radius).toBeLessThan(SUN_RADIUS)
    expect(PLANETS.mercury.radius).toBeGreaterThan(1)
  })

  test('periods are sidereal years', () => {
    expect(PLANETS.mercury.period).toBeCloseTo(87.97, 1)
    expect(PLANETS.neptune.period / 365.25).toBeCloseTo(164.8, 0)
  })
})

function sceneLonLat(p: ArrayLike<number>): [number, number] {
  const [x, y, z] = [p[0], p[1], p[2]]
  const lon = Math.atan2(-z, x) * DEG + 180
  const lat = Math.atan2(y, Math.hypot(x, z)) * DEG
  return [lon, lat]
}

describe('planetPosition', () => {
  test.each(PLANET_KEYS)(
    '%s matches heliocentric ecliptic-of-date lon/lat within 0.01°',
    (key) => {
      const { body } = PLANETS[key]
      const at = planetPosition(body)
      for (const t of DATES) {
        const pos = at(t)
        const ecl = Ecliptic(HelioVector(body, new Date(t)))
        const [lon, lat] = sceneLonLat(pos)
        expect(Math.abs(wrap180(lon - ecl.elon))).toBeLessThan(0.01)
        expect(Math.abs(lat - ecl.elat)).toBeLessThan(0.01)
        expect(Math.hypot(...pos)).toBeCloseTo(
          sceneDistance(ecl.vec.Length()),
          9
        )
      }
    }
  )
})

describe('planetOrbitPath', () => {
  test('samples one period centred on t through the same map', () => {
    const { body } = PLANETS.mars
    const t = DATES[2]
    const segments = 64
    const path = planetOrbitPath(body, t, segments)
    expect(path).toHaveLength(segments * 3)
    const now = planetPosition(body)(t)
    const mid = segments / 2
    for (let k = 0; k < 3; k++) {
      expect(path[mid * 3 + k]).toBeCloseTo(now[k], 3)
    }
    // Longitudes sweep a full turn.
    let swept = 0
    for (let i = 1; i <= segments; i++) {
      const [a] = sceneLonLat(path.subarray(((i - 1) % segments) * 3))
      const [b] = sceneLonLat(path.subarray((i % segments) * 3))
      swept += wrap180(b - a)
    }
    expect(swept).toBeCloseTo(360, 0)
  })
})

describe('bodyOrientation', () => {
  const pole = new THREE.Vector3()
  const meridian = new THREE.Vector3()
  const later = new THREE.Vector3()

  test.each(PLANET_KEYS)('%s local +Y is its IAU north pole', (key) => {
    const { body } = PLANETS[key]
    const at = bodyOrientation(body)
    for (const t of DATES) {
      const date = new Date(t)
      const n = RotateVector(
        Rotation_EQJ_ECT(date),
        RotationAxis(body, date).north
      )
      const expected = new THREE.Vector3(-n.x, n.z, n.y)
      pole.set(0, 1, 0).applyQuaternion(at(t))
      expect(pole.angleTo(expected) * DEG).toBeLessThan(0.01)
    }
  })

  // Spin sense against the orbital angular momentum (scene +Y, ecliptic
  // north): Venus and Uranus rotate retrograde, the rest prograde.
  test.each(PLANET_KEYS)('%s spins in the expected sense', (key) => {
    const { body } = PLANETS[key]
    const at = bodyOrientation(body)
    const t = DATES[2]
    meridian.set(1, 0, 0).applyQuaternion(at(t))
    later.set(1, 0, 0).applyQuaternion(at(t + 60_000))
    const spinY = meridian.cross(later).y
    const retrograde = key === 'venus' || key === 'uranus'
    expect(Math.sign(spinY)).toBe(retrograde ? -1 : 1)
  })

  test('closures keep separate quaternions', () => {
    const mars = bodyOrientation(Body.Mars)(DATES[0])
    const venus = bodyOrientation(Body.Venus)(DATES[0])
    expect(mars).not.toBe(venus)
    expect(mars.angleTo(venus)).toBeGreaterThan(0.1)
  })
})

// Oppositions and conjunctions line planets up with the Earth's own scene
// position, so the two share one frame. Times from astronomy-engine's
// SearchRelativeLongitude (Saturn: 2025-09-21T05:30Z).
describe('shares the Earth’s frame', () => {
  test.each([
    ['mars', '2025-01-16T02:38:00Z', 0],
    ['jupiter', '2024-12-07T21:00:00Z', 0],
    ['saturn', '2025-09-21T05:30:00Z', 0],
    ['venus', '2025-03-23T01:00:00Z', 0],
    ['jupiter', '2025-06-24T15:20:00Z', 180],
  ] as const)('%s at %s is %i° from the Earth', (key, iso, separation) => {
    const t = Date.parse(iso)
    const planet = planetPosition(PLANETS[key].body)(t)
    const [planetLon] = sceneLonLat(planet)
    const [earthLon] = sceneLonLat(earthPosition(t))
    expect(Math.abs(wrap180(planetLon - earthLon - separation))).toBeLessThan(
      0.05
    )
    const r = Math.hypot(...planet)
    if (key === 'venus') expect(r).toBeLessThan(EARTH_ORBIT_RADIUS)
    else expect(r).toBeGreaterThan(EARTH_ORBIT_RADIUS)
  })
})

// The IAU north pole is on the north side of the invariable plane, so for
// Venus and Uranus the spin vector is −Y; obliquity is measured from the spin
// vector (right-hand rule) to the orbit normal.
describe('obliquity', () => {
  const OBLIQUITY = {
    mercury: 0.03,
    venus: 177.36,
    mars: 25.19,
    jupiter: 3.13,
    saturn: 26.73,
    uranus: 97.77,
    neptune: 28.32,
  }
  const spin = new THREE.Vector3()
  const meridian = new THREE.Vector3()
  const later = new THREE.Vector3()

  test.each(PLANET_KEYS)('%s spin axis is tilted as measured', (key) => {
    const { body } = PLANETS[key]
    const t = DATES[2]
    const at = bodyOrientation(body)
    spin.set(0, 1, 0).applyQuaternion(at(t))
    meridian.set(1, 0, 0).applyQuaternion(at(t))
    later.set(1, 0, 0).applyQuaternion(at(t + 60_000))
    if (meridian.cross(later).dot(spin) < 0) spin.negate()
    // Remapping lengths keeps directions, so r × v's direction survives.
    const position = planetPosition(body)
    const r = new THREE.Vector3(...position(t))
    const normal = r.cross(new THREE.Vector3(...position(t + MS_PER_DAY)))
    expect(Math.abs(spin.angleTo(normal) * DEG - OBLIQUITY[key])).toBeLessThan(
      0.5
    )
  })
})

describe('orientation buffers', () => {
  test('bodyOrientation does not write into moonOrientation’s quaternion', () => {
    const t = DATES[1]
    const moon = moonOrientation(t)
    const before = moon.clone()
    bodyOrientation(Body.Mars)(t)
    expect(moon.equals(before)).toBe(true)
    expect(moonOrientation(t).equals(before)).toBe(true)
  })
})
