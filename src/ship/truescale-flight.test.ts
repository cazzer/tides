// Ship mode under ?truescale (tides-o39): the flag is read at load, so each
// case reloads the modules with a stubbed location.
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

const T = Date.UTC(2026, 9, 22, 12)
const DAY = 86_400_000

async function loadAt(search: string) {
  vi.resetModules()
  vi.stubGlobal('location', { search })
  const [bodies, distances, flight, scale, moons, truescale] = await Promise.all([
    import('./ship-bodies'),
    import('./ship-distances'),
    import('./flight'),
    import('../flight-scale'),
    import('../moons/moons'),
    import('../truescale'),
  ])
  return { bodies, distances, flight, scale, moons, truescale }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('?truescale=0.5', () => {
  it('flies among bodies at flightRadii(0.5), Earth unchanged', async () => {
    const { bodies, scale, moons, truescale } = await loadAt('?ship=1&truescale=0.5')
    expect(truescale.TRUESCALE).toBe(0.5)
    const radius = scale.flightRadii(0.5)
    const moonRadius = moons.moonRadiiAt(0.5)
    const moonOrbit = moons.moonOrbitRadiiAt(0.5)
    const ship = bodies.createShipBodies('high', false)
    bodies.updateShipBodies(ship, T)
    const byKey = Object.fromEntries(ship.map((b) => [b.key, b]))
    for (const key of ['sun', 'moon', 'mercury', 'jupiter', 'saturn'] as const) {
      expect(byKey[key].radius).toBe(radius[key])
      expect(byKey[key].radius).not.toBe(scale.positionsFor('system').radius[key])
    }
    expect(byKey.earth.radius).toBe(bodies.EARTH_RADIUS)
    expect(byKey.earth.radius).toBe(scale.positionsFor('system').radius.earth)
    for (const key of moons.MOON_KEYS) {
      expect(byKey[key].radius).toBe(moonRadius[key])
      const parent = byKey[moons.MOONS[key].parent].position
      expect(byKey[key].position.distanceTo(parent)).toBeCloseTo(moonOrbit[key], 9)
    }
    // The system view keeps its sizes.
    expect(moons.moonRadius('titan', 'system')).not.toBe(moonRadius.titan)
    expect(scale.positionsFor('system').radius.sun).toBeCloseTo(10, 9)
  })
})

// The run-ins below hold for every planet up to a = 0.7. Past that, the
// Sun's anchor reads on its pair scale with Mercury, ~4× the flight scale at
// a = 0.9 (the scene gap between them squeezed to ~74 units), all the way
// out, so on a run in to Venus or Mars that passes the Sun at a few hundred
// units the blended range runs backwards by up to ~3–5 million km on about a
// quarter of dates (2 of 120 at 0.8). Hence the inner planets at 0.5 here.
async function setup(t: number, search = '?truescale=0.9') {
  const loaded = await loadAt(search)
  const { bodies, distances } = loaded
  const ship = bodies.createShipBodies('high', false)
  bodies.updateShipBodies(ship, t)
  const truth = distances.trueBodies(
    ship.map((b) => b.key),
    t
  )
  const find = (key: string) => {
    const index = ship.findIndex((b) => b.key === key)
    return { index, body: ship[index] }
  }
  return { ...loaded, ship, truth, find, ranges: distances.createShipRanges(ship.length) }
}

describe('?truescale: HUD ranges', () => {
  it('falls monotonically to 0 on a straight run from Earth to the Sun', async () => {
    const { ship, truth, find, ranges, distances, flight } = await setup(T)
    const sun = find('sun')
    const earth = find('earth').body
    expect(sun.body.radius).toBeGreaterThan(200)
    const dir = earth.position.clone().sub(sun.body.position).normalize()
    const shell = flight.collisionRadius(sun.body)
    const start = earth.position.distanceTo(sun.body.position) - 40
    const position = new THREE.Vector3()
    let previous = Infinity
    for (let d = start; d >= shell; d -= d > shell + 20 ? 2 : 0.05) {
      distances.measureRanges(position.copy(sun.body.position).addScaledVector(dir, d), ship, truth, ranges)
      expect(ranges.km[sun.index], `d = ${d}`).toBeLessThanOrEqual(previous + 1e-6)
      previous = ranges.km[sun.index]
    }
    distances.measureRanges(position.copy(sun.body.position).addScaledVector(dir, shell), ship, truth, ranges)
    expect(ranges.km[sun.index]).toBeCloseTo(0, 0)
    expect(ranges.nearest).toBe(sun.index)
  })

  it.each([
    ['venus', '?truescale=0.5'],
    ['mars', '?truescale=0.5'],
    ['jupiter', '?truescale=0.9'],
    ['saturn', '?truescale=0.9'],
    ['uranus', '?truescale=0.9'],
    ['neptune', '?truescale=0.9'],
  ])(
    'falls steadily on a straight run in to %s at %s, on 10 dates',
    async (key, search) => {
      let worst = 0
      for (let day = 0; day < 120; day += 12) {
        const { ship, truth, find, ranges, distances, flight } = await setup(T + day * DAY, search)
        const planet = find(key)
        const from = find('earth').body
        const dir = from.position.clone().sub(planet.body.position).normalize()
        const position = new THREE.Vector3()
        let previous = Infinity
        const shell = flight.collisionRadius(planet.body)
        for (let d = 1000; d >= shell + 0.02; d -= d > 200 ? 10 : 0.5) {
          distances.measureRanges(position.copy(planet.body.position).addScaledVector(dir, d), ship, truth, ranges)
          worst = Math.max(worst, ranges.km[planet.index] - previous)
          previous = ranges.km[planet.index]
        }
      }
      expect(worst).toBeLessThanOrEqual(1e-6)
    }
  )

  it('reads 0 on arrival at a moon, and names it nearest', async () => {
    const { ship, truth, find, ranges, distances, flight, moons } = await setup(T)
    for (const key of ['phobos', 'io', 'titan', 'miranda', 'triton'] as const) {
      const moon = find(key)
      const parent = find(moons.MOONS[key].parent).body
      const dir = parent.position.clone().sub(moon.body.position).normalize()
      const at = moon.body.position.clone().addScaledVector(dir, flight.collisionRadius(moon.body))
      distances.measureRanges(at, ship, truth, ranges)
      expect(ranges.km[moon.index], key).toBeCloseTo(0, 0)
      expect(ranges.nearest, key).toBe(moon.index)
    }
  })
})
