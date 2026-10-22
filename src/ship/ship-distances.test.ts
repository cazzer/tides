import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { Body, GeoMoon, HelioVector, KM_PER_AU } from 'astronomy-engine'
import { collisionRadius } from './flight'
import { createShipBodies, updateShipBodies, type ShipBody } from './ship-bodies'
import { spawnPose } from './ship-session'
import {
  C_KM_PER_S,
  bodyName,
  createShipRanges,
  formatDistance,
  formatEta,
  formatSpeed,
  measureRanges,
  trueBodies,
} from './ship-distances'

const DATES = [
  Date.UTC(2026, 9, 22, 12), // Venus near inferior conjunction, crowding the spawn
  Date.UTC(2024, 0, 13, 0), // Moon near perigee
  Date.UTC(2031, 6, 4, 6),
]

const EARTH_RADIUS_KM = 6371
const MOON_RADIUS_KM = 1737.4

function setup(t: number) {
  const bodies = createShipBodies()
  updateShipBodies(bodies, t)
  const truth = trueBodies(
    bodies.map((b) => b.key),
    t
  )
  return { bodies, truth, ranges: createShipRanges(bodies.length) }
}

function find(bodies: readonly ShipBody[], key: string) {
  const index = bodies.findIndex((b) => b.key === key)
  return { index, body: bodies[index] }
}

const shellOf = collisionRadius

// On `from`'s collision shell (plus `extra`), on the line toward `to`.
function shellToward(from: ShipBody, to: ShipBody, extra = 0): THREE.Vector3 {
  const dir = new THREE.Vector3().subVectors(to.position, from.position).normalize()
  return from.position.clone().addScaledVector(dir, shellOf(from) + extra)
}

describe('trueBodies', () => {
  it('matches astronomy-engine distances', () => {
    const t = DATES[0]
    const { bodies, truth } = setup(t)
    const earth = find(bodies, 'earth').index
    const moon = find(bodies, 'moon').index
    const mars = find(bodies, 'mars').index
    const geoMoon = GeoMoon(new Date(t)).Length() * KM_PER_AU
    expect(truth.positions[earth].distanceTo(truth.positions[moon])).toBeCloseTo(geoMoon, -1)
    const e = HelioVector(Body.Earth, new Date(t))
    const m = HelioVector(Body.Mars, new Date(t))
    expect(truth.positions[earth].distanceTo(truth.positions[mars])).toBeCloseTo(
      Math.hypot(e.x - m.x, e.y - m.y, e.z - m.z) * KM_PER_AU,
      -1
    )
    expect(truth.radii[earth]).toBe(EARTH_RADIUS_KM)
  })

  it('points the same way as the scene from the Sun', () => {
    const { bodies, truth } = setup(DATES[0])
    for (const [i, body] of bodies.entries()) {
      // The Moon sits at its own scale around Earth, not at its own
      // heliocentric direction.
      if (body.key === 'sun' || body.key === 'moon') continue
      const scene = body.position.clone().normalize()
      const real = truth.positions[i].clone().normalize()
      // Earth's scene orbit is a circle at the Sun's apparent longitude.
      expect(scene.angleTo(real)).toBeLessThan(0.01)
    }
  })
})

describe('measureRanges', () => {
  it.each(DATES)(
    'shows the Earth–Moon distance within 1%% at Earth facing the Moon (%i)',
    (t) => {
      const { bodies, truth, ranges } = setup(t)
      const earth = find(bodies, 'earth').body
      const moon = find(bodies, 'moon')
      measureRanges(shellToward(earth, moon.body), bodies, truth, ranges)
      // Surface to surface: astronomy-engine's centre distance less both radii.
      const geoMoon = GeoMoon(new Date(t)).Length() * KM_PER_AU
      const surfaceKm = geoMoon - EARTH_RADIUS_KM - MOON_RADIUS_KM
      expect(Math.abs(ranges.km[moon.index] / surfaceKm - 1)).toBeLessThan(0.01)
    }
  )

  it('shows the Earth–Mars distance within 1% at Earth facing Mars', () => {
    const { bodies, truth, ranges } = setup(DATES[0])
    const earth = find(bodies, 'earth')
    const mars = find(bodies, 'mars')
    measureRanges(shellToward(earth.body, mars.body), bodies, truth, ranges)
    const surfaceKm =
      truth.positions[earth.index].distanceTo(truth.positions[mars.index]) -
      truth.radii[earth.index] -
      truth.radii[mars.index]
    expect(Math.abs(ranges.km[mars.index] / surfaceKm - 1)).toBeLessThan(0.01)
  })

  it.each([16 / 9, 390 / 844])(
    'keeps Earth and the Moon on their own scale at the spawn, with Venus near (aspect %f)',
    (aspect) => {
      const t = DATES[0]
      const { bodies, truth, ranges } = setup(t)
      const earth = find(bodies, 'earth')
      const moon = find(bodies, 'moon')
      const venus = find(bodies, 'venus')
      const { position } = spawnPose(bodies, aspect)
      measureRanges(position, bodies, truth, ranges)
      const earthMoonScale =
        (truth.positions[earth.index].distanceTo(truth.positions[moon.index]) -
          EARTH_RADIUS_KM -
          MOON_RADIUS_KM) /
        (earth.body.position.distanceTo(moon.body.position) -
          shellOf(earth.body) -
          shellOf(moon.body))
      const earthGap = position.distanceTo(earth.body.position) - shellOf(earth.body)
      // Within 15% of the gap at the Earth–Moon scale: a few Moon distances,
      // not a share of an AU.
      expect(Math.abs(ranges.km[earth.index] / (earthGap * earthMoonScale) - 1)).toBeLessThan(0.15)
      expect(ranges.km[earth.index]).toBeLessThan(2.5e6)
      expect(ranges.nearest).toBe(earth.index)
      // Venus is still read at the planets' scale: tens of millions of km.
      expect(ranges.km[venus.index]).toBeGreaterThan(1e7)
    }
  )

  it('reads 0 on arrival at a shell', () => {
    const { bodies, truth, ranges } = setup(DATES[0])
    for (const key of ['moon', 'earth', 'mars', 'sun', 'saturn']) {
      const target = find(bodies, key)
      const from = find(bodies, key === 'sun' ? 'mercury' : 'sun').body
      measureRanges(shellToward(target.body, from), bodies, truth, ranges)
      expect(ranges.km[target.index]).toBeCloseTo(0, 0)
      expect(ranges.nearest).toBe(target.index)
    }
  })

  it('falls steadily toward the Moon, with no jump where the nearest body changes', () => {
    const { bodies, truth, ranges } = setup(DATES[0])
    const earth = find(bodies, 'earth').body
    const moon = find(bodies, 'moon')
    const start = shellToward(earth, moon.body)
    const end = shellToward(moon.body, earth)
    const steps = 400
    const total = truth.positions[1].distanceTo(truth.positions[2])
    let previous = Infinity
    const position = new THREE.Vector3()
    for (let i = 0; i <= steps; i++) {
      position.lerpVectors(start, end, i / steps)
      measureRanges(position, bodies, truth, ranges)
      const km = ranges.km[moon.index]
      expect(km).toBeLessThanOrEqual(previous + 1e-6)
      if (Number.isFinite(previous)) expect(previous - km).toBeLessThan((3 * total) / steps)
      previous = km
    }
  })

  it('never contradicts itself: ranges keep the triangle inequality', () => {
    const t = DATES[2]
    const { bodies, truth, ranges } = setup(t)
    const random = mulberry32(7)
    const position = new THREE.Vector3()
    for (let i = 0; i < 300; i++) {
      // Anywhere from close in to well past Neptune.
      const r = 5 + random() * 600
      position.set(random() - 0.5, (random() - 0.5) * 0.3, random() - 0.5).setLength(r)
      measureRanges(position, bodies, truth, ranges)
      for (let a = 0; a < bodies.length; a++) {
        for (let b = a + 1; b < bodies.length; b++) {
          const centres = truth.positions[a].distanceTo(truth.positions[b])
          const surfaces = centres - truth.radii[a] - truth.radii[b]
          // |ship→A surface| + |ship→B surface| spans at least the A–B gap.
          expect(ranges.km[a] + ranges.km[b]).toBeGreaterThanOrEqual(surfaces * (1 - 1e-9) - 1)
        }
      }
    }
  })

  it('reads ranges past Neptune on the planets’ scale, not the Moon’s', () => {
    const { bodies, truth, ranges } = setup(DATES[0])
    const neptune = find(bodies, 'neptune')
    const sun = find(bodies, 'sun')
    const out = neptune.body.position.clone().multiplyScalar(1.5)
    measureRanges(out, bodies, truth, ranges)
    expect(ranges.nearest).toBe(neptune.index)
    const neptuneAu = truth.positions[neptune.index].length() / KM_PER_AU
    // Beyond Neptune, further from the Sun than Neptune is.
    expect(ranges.km[sun.index] / KM_PER_AU).toBeGreaterThan(neptuneAu)
    expect(ranges.km[neptune.index] / KM_PER_AU).toBeGreaterThan(1)
  })

  it('gives a local scale near Earth set by the Earth–Moon gap, and a far larger one at Neptune', () => {
    const { bodies, truth, ranges } = setup(DATES[0])
    const earth = find(bodies, 'earth').body
    const moon = find(bodies, 'moon').body
    const neptune = find(bodies, 'neptune').body
    const sun = find(bodies, 'sun').body
    measureRanges(shellToward(earth, moon, 0.5), bodies, truth, ranges)
    const nearEarth = ranges.kmPerUnit
    // ~376 000 km over a ~6 unit shell gap.
    expect(nearEarth).toBeGreaterThan(40_000)
    expect(nearEarth).toBeLessThan(120_000)
    measureRanges(shellToward(neptune, sun, 0.5), bodies, truth, ranges)
    expect(ranges.kmPerUnit).toBeGreaterThan(100 * nearEarth)
  })
})

describe('formatting', () => {
  it('formats distances as km, million km, then AU', () => {
    expect(formatDistance(765_622)).toMatch(/^766.000 km$/)
    expect(formatDistance(999)).toBe('999 km')
    expect(formatDistance(6_371.4)).toMatch(/^6.370 km$/)
    expect(formatDistance(2_030_400)).toBe('2.03 million km')
    expect(formatDistance(0.099 * KM_PER_AU)).toBe('14.8 million km')
    expect(formatDistance(0.1 * KM_PER_AU)).toBe('0.1 AU')
    expect(formatDistance(1.52 * KM_PER_AU)).toBe('1.52 AU')
    expect(formatDistance(30.07 * KM_PER_AU)).toBe('30.1 AU')
    expect(formatDistance(NaN)).toBe('—')
  })

  it('never shows a tiny share of an AU', () => {
    for (let km = 1; km < 1e12; km *= 1.7) {
      expect(formatDistance(km)).not.toMatch(/^0\.0/)
    }
  })

  it('formats speed as km/s below 0.1 c, c above', () => {
    expect(formatSpeed(15_543)).toMatch(/^15.500 km\/s$/)
    expect(formatSpeed(0)).toBe('0 km/s')
    expect(formatSpeed(1.34 * C_KM_PER_S)).toBe('1.3c')
    expect(formatSpeed(0.2 * C_KM_PER_S)).toBe('0.2c')
  })

  it('formats ETA', () => {
    expect(formatEta(7.2)).toBe('7 s')
    expect(formatEta(150)).toBe('3 min')
    expect(formatEta(4 * 3600)).toBe('4 h')
    expect(formatEta(Infinity)).toBe('—')
  })

  it('names bodies', () => {
    expect(bodyName('moon')).toBe('Moon')
    expect(bodyName('saturn')).toBe('Saturn')
  })
})

// Small seeded PRNG so the sampled positions are the same every run.
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
