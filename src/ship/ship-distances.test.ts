import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { GeoMoon, HelioVector, Body, KM_PER_AU } from 'astronomy-engine'
import { COLLISION_MARGIN } from './flight'
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
  trueSeparations,
} from './ship-distances'

const DATES = [
  Date.UTC(2026, 9, 22, 12),
  Date.UTC(2024, 0, 13, 0), // Moon near perigee
  Date.UTC(2031, 6, 4, 6),
]

function setup(t: number) {
  const bodies = createShipBodies()
  updateShipBodies(bodies, t)
  const separations = trueSeparations(
    bodies.map((b) => b.key),
    t
  )
  return { bodies, separations, ranges: createShipRanges(bodies.length) }
}

function find(bodies: readonly ShipBody[], key: string) {
  const index = bodies.findIndex((b) => b.key === key)
  return { index, body: bodies[index] }
}

// On `from`'s collision shell, on the line toward `to`.
function shellToward(from: ShipBody, to: ShipBody, extra = 0): THREE.Vector3 {
  const dir = new THREE.Vector3().subVectors(to.position, from.position).normalize()
  return from.position.clone().addScaledVector(dir, from.radius * COLLISION_MARGIN + extra)
}

describe('trueSeparations', () => {
  it('matches astronomy-engine', () => {
    const t = DATES[0]
    const { bodies, separations } = setup(t)
    const n = bodies.length
    const earth = find(bodies, 'earth').index
    const moon = find(bodies, 'moon').index
    const mars = find(bodies, 'mars').index
    const geoMoon = GeoMoon(new Date(t)).Length() * KM_PER_AU
    expect(separations[earth * n + moon]).toBeCloseTo(geoMoon, -1)
    expect(separations[moon * n + earth]).toBe(separations[earth * n + moon])
    const e = HelioVector(Body.Earth, new Date(t))
    const m = HelioVector(Body.Mars, new Date(t))
    expect(separations[earth * n + mars]).toBeCloseTo(
      Math.hypot(e.x - m.x, e.y - m.y, e.z - m.z) * KM_PER_AU,
      -1
    )
  })
})

describe('measureRanges', () => {
  it.each(DATES)('shows the Earth–Moon distance within 1%% at Earth facing the Moon (%i)', (t) => {
    const { bodies, separations, ranges } = setup(t)
    const earth = find(bodies, 'earth').body
    const moon = find(bodies, 'moon')
    measureRanges(shellToward(earth, moon.body), bodies, separations, ranges)
    const geoMoon = GeoMoon(new Date(t)).Length() * KM_PER_AU
    expect(Math.abs(ranges.km[moon.index] / geoMoon - 1)).toBeLessThan(0.01)
  })

  it('shows the Earth–Mars distance within 1% at Earth facing Mars', () => {
    const t = DATES[0]
    const { bodies, separations, ranges } = setup(t)
    const earth = find(bodies, 'earth')
    const mars = find(bodies, 'mars')
    const n = bodies.length
    measureRanges(shellToward(earth.body, mars.body), bodies, separations, ranges)
    const trueKm = separations[earth.index * n + mars.index]
    expect(Math.abs(ranges.km[mars.index] / trueKm - 1)).toBeLessThan(0.01)
  })

  it.each([16 / 9, 390 / 844])('keeps Earth and the Moon on their own scale at the spawn, with Venus near (aspect %f)', (aspect) => {
    // 2026-10-22: Venus near inferior conjunction crowds the spawn, about as
    // near as Earth's surface.
    const t = DATES[0]
    const { bodies, separations, ranges } = setup(t)
    const earth = find(bodies, 'earth')
    const moon = find(bodies, 'moon')
    const venus = find(bodies, 'venus')
    const { position } = spawnPose(bodies, aspect)
    measureRanges(position, bodies, separations, ranges)
    const n = bodies.length
    const earthMoonScale =
      separations[earth.index * n + moon.index] /
      (earth.body.position.distanceTo(moon.body.position) -
        (earth.body.radius + moon.body.radius) * COLLISION_MARGIN)
    const earthGap = position.distanceTo(earth.body.position) - earth.body.radius * COLLISION_MARGIN
    expect(ranges.km[earth.index] / (earthGap * earthMoonScale)).toBeCloseTo(1, 6)
    // A few Moon distances, not a share of an AU.
    expect(ranges.km[earth.index]).toBeLessThan(2.5e6)
    // Venus is still read at the planets' scale: tens of millions of km.
    expect(ranges.km[venus.index]).toBeGreaterThan(1e7)
  })

  it('reads 0 on arrival at a shell', () => {
    const { bodies, separations, ranges } = setup(DATES[0])
    const earth = find(bodies, 'earth')
    const moon = find(bodies, 'moon')
    measureRanges(shellToward(moon.body, earth.body), bodies, separations, ranges)
    expect(ranges.km[moon.index]).toBeCloseTo(0, 6)
  })

  it('falls steadily toward the Moon, with no jump where the nearest body changes', () => {
    const { bodies, separations, ranges } = setup(DATES[0])
    const { index: earthIndex, body: earth } = find(bodies, 'earth')
    const moon = find(bodies, 'moon')
    const gapKm = separations[earthIndex * bodies.length + moon.index]
    const start = shellToward(earth, moon.body)
    const end = shellToward(moon.body, earth)
    const steps = 400
    let previous = Infinity
    const position = new THREE.Vector3()
    for (let i = 0; i <= steps; i++) {
      position.lerpVectors(start, end, i / steps)
      measureRanges(position, bodies, separations, ranges)
      const km = ranges.km[moon.index]
      expect(km).toBeLessThanOrEqual(previous)
      // A step is 1/400 of the way; allow 3× that of the whole for curvature.
      if (Number.isFinite(previous)) {
        expect(previous - km).toBeLessThan((3 * gapKm) / steps)
      }
      previous = km
    }
  })

  it('gives a local scale near Earth set by the Earth–Moon gap, and a far larger one at Neptune', () => {
    const { bodies, separations, ranges } = setup(DATES[0])
    const earth = find(bodies, 'earth').body
    const moon = find(bodies, 'moon').body
    const neptune = find(bodies, 'neptune').body
    const sun = find(bodies, 'sun').body
    measureRanges(shellToward(earth, moon, 0.5), bodies, separations, ranges)
    const nearEarth = ranges.kmPerUnit
    // ~384 400 km over a ~6 unit shell gap.
    expect(nearEarth).toBeGreaterThan(40_000)
    expect(nearEarth).toBeLessThan(120_000)
    measureRanges(shellToward(neptune, sun, 0.5), bodies, separations, ranges)
    expect(ranges.kmPerUnit).toBeGreaterThan(100 * nearEarth)
  })
})

describe('formatting', () => {
  it('formats distances as km under a million, AU above', () => {
    expect(formatDistance(384_400.4)).toMatch(/^384.400 km$/)
    expect(formatDistance(999)).toBe('999 km')
    expect(formatDistance(1.52 * KM_PER_AU)).toBe('1.52 AU')
    expect(formatDistance(30.07 * KM_PER_AU)).toBe('30.1 AU')
    expect(formatDistance(2e6)).toBe('0.0134 AU')
    expect(formatDistance(NaN)).toBe('—')
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
