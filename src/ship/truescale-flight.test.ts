// Ship mode under ?truescale (tides-o39): the flag is read at load, so each
// case reloads the modules with a stubbed location.
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { MAX_TRUESCALE } from '../truescale'
import type { MainCameraPose } from '../main-camera-session'

const T = Date.UTC(2026, 9, 22, 12)
const DAY = 86_400_000

async function loadAt(search: string) {
  vi.resetModules()
  vi.stubGlobal('location', { search })
  const [bodies, distances, flight, scale, moons, truescale, session] = await Promise.all([
    import('./ship-bodies'),
    import('./ship-distances'),
    import('./flight'),
    import('../flight-scale'),
    import('../moons/moons'),
    import('../truescale'),
    import('./ship-session'),
  ])
  return { bodies, distances, flight, scale, moons, truescale, session }
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

// At the cap. Past it the Sun's anchor reads on its pair scale with Mercury
// all the way out (~4× the flight scale at 0.9), so a run in to Venus or
// Mars that passes the Sun at a few hundred units read the range backwards,
// by up to ~3–5 million km at 0.9 and on 3–4 of 120 dates at 0.8: the run-ins
// below are what tides-3ln has to keep passing to raise the cap.
const AT_MAX = `?truescale=${MAX_TRUESCALE}`

async function setup(t: number, search = AT_MAX) {
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
    const { ship, truth, find, ranges, distances, flight, scale } = await setup(T)
    const sun = find('sun')
    const earth = find('earth').body
    expect(sun.body.radius).toBe(scale.flightRadii(MAX_TRUESCALE).sun)
    expect(sun.body.radius).toBeGreaterThan(100)
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

  it.each(['venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'])(
    'falls steadily on a straight run in to %s, on 20 dates',
    async (key) => {
      let worst = 0
      for (let day = 0; day < 720; day += 36) {
        const { ship, truth, find, ranges, distances, flight } = await setup(T + day * DAY)
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

describe('?truescale=0.5: spawning from the main view', () => {
  const target: [number, number, number] = [10, -4, 7]
  const eye: [number, number, number] = [34, 8, 39]
  const quaternion = new THREE.Quaternion()
    .setFromRotationMatrix(
      new THREE.Matrix4().lookAt(new THREE.Vector3(...eye), new THREE.Vector3(...target), new THREE.Vector3(0, 1, 0))
    )
    .toArray() as [number, number, number, number]
  const pose: MainCameraPose = {
    position: eye,
    target,
    quaternion,
    up: [0, 1, 0],
    projection: 'perspective',
    fov: 30,
    zoom: 1,
  }
  const tanHalf = (fov: number) => Math.tan((fov * Math.PI) / 360)
  const angularRadius = (radius: number, distance: number, fov: number) =>
    radius / (Math.sqrt(distance ** 2 - radius ** 2) * tanHalf(fov))

  it.each(['sun', 'jupiter', 'io'] as const)(
    'keeps %s as large on screen as the main view drew it, clear of every body',
    async (key) => {
      const { bodies, scale, moons, session, flight } = await loadAt('?truescale=0.5')
      const systemRadius = moons.isMoonKey(key)
        ? moons.moonRadius(key, 'system')
        : scale.positionsFor('system').radius[key]
      const sourceDistance = new THREE.Vector3(...eye).distanceTo(new THREE.Vector3(...target))
      const pushed: number[] = []
      for (let day = 0; day < 40; day += 4) {
        const ship = bodies.createShipBodies('high', false)
        bodies.updateShipBodies(ship, T + day * DAY)
        const body = ship.find((b) => b.key === key)!
        expect(body.radius).not.toBe(systemRadius)
        const state = session.spawnPoseFromCamera(pose, key, ship)!
        const distance = state.position.distanceTo(body.position)
        const mapped = session.cameraToShipDistance(pose, systemRadius, body.radius)!
        if (Math.abs(distance / mapped - 1) < 1e-9) {
          expect(angularRadius(body.radius, distance, session.SHIP_FOV)).toBeCloseTo(
            angularRadius(systemRadius, sourceDistance, pose.fov),
            10
          )
        } else {
          // Carried on out past a grown parent standing on the line.
          pushed.push(day)
          expect(distance).toBeGreaterThan(mapped)
        }
        for (const other of ship) {
          expect(state.position.distanceTo(other.position), `${key} day ${day}: ${other.key}`).toBeGreaterThan(
            flight.collisionRadius(other)
          )
        }
      }
      // Only Io, whose parent grows round it, ever needs carrying out: on
      // day 8 the mapped point is inside Jupiter.
      if (key !== 'io') expect(pushed).toEqual([])
      else expect(pushed).toContain(8)
    }
  )
})
