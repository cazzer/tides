import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { Body, HelioVector } from 'astronomy-engine'
import { PLANET_KEYS, PLANETS, sceneRadius } from '../planets'
import { FLIGHT_UNITS_PER_AU, flightPlanetPosition } from '../flight-scale'
import { CLOUD_LAYER_TOP, TERRAIN_DISPLACEMENT } from '../cloud-layer'
import { latLonToLocal } from '../aurora'
import { applyBodyTransform } from '../body-transform'
import { earthSpin, earthTilt } from '../ephemeris'
import { ATMOSPHERE_OUTER, AURORA_SHELL_OUTER } from '../renderers/earth-shells'
import { COLLISION_MARGIN, collisionRadius, floorRadius, wellFactor } from './flight'
import { MOONS, MOON_KEYS, isMoonKey, moonPosition, moonRadius } from '../moons/moons'
import {
  BODY_MASS_KG,
  EARTH_COLLISION_RADIUS,
  EARTH_GROUND_CLEARANCE,
  EARTH_RADIUS,
  EARTH_SHELL_RADIUS,
  MOON_COLLISION_CLEARANCE,
  createShipBodies,
  updateShipBodies,
} from './ship-bodies'
import { shipNear, spawnPose } from './ship-session'
import { TERRAIN_MAP_SIZE, buildTerrainFloor, setEarthTerrain } from './terrain-floor'

const T = Date.UTC(2026, 9, 22, 12)

function byKey(t = T) {
  const bodies = createShipBodies()
  updateShipBodies(bodies, t)
  return Object.fromEntries(bodies.map((b) => [b.key, b]))
}

describe('ship bodies', () => {
  it('has the Sun, Earth, Moon, every planet and every major moon once', () => {
    expect(createShipBodies().map((b) => b.key)).toEqual([
      'sun',
      'earth',
      'moon',
      ...PLANET_KEYS,
      ...MOON_KEYS,
    ])
  })

  it('places and sizes the major moons as the flight scale draws them', () => {
    const b = byKey()
    for (const key of MOON_KEYS) {
      expect(b[key].radius).toBe(moonRadius(key))
      const [x, y, z] = moonPosition(key, T, 'flight')
      expect(b[key].position.distanceTo(new THREE.Vector3(x, y, z))).toBeLessThan(1e-9)
      // Near its parent, not its system-view distance from the Sun.
      expect(b[key].position.distanceTo(b[MOONS[key].parent].position)).toBeLessThan(40)
    }
  })

  it('sizes them as the scene draws them', () => {
    const b = byKey()
    expect(b.sun.radius).toBeCloseTo(10, 6)
    expect(b.moon.radius).toBeCloseTo(1, 6)
    expect(b.earth.radius).toBeCloseTo(sceneRadius(12742e3), 9)
    expect(b.earth.radius).toBeCloseTo(2.95, 2)
    for (const key of PLANET_KEYS) expect(b[key].radius).toBe(PLANETS[key].radius)
  })

  it('keeps the Sun at the origin and Earth at its true distance at the flight scale', () => {
    const b = byKey()
    expect(b.sun.position.length()).toBe(0)
    const au = HelioVector(Body.Earth, new Date(T)).Length()
    expect(b.earth.position.length() / (FLIGHT_UNITS_PER_AU * au)).toBeCloseTo(1, 9)
  })

  it('puts the Moon about 10 units from Earth', () => {
    for (let day = 0; day < 30; day += 3) {
      const b = byKey(T + day * 86_400_000)
      expect(b.moon.position.distanceTo(b.earth.position)).toBeGreaterThan(9)
      expect(b.moon.position.distanceTo(b.earth.position)).toBeLessThan(11)
    }
  })

  it('places each planet where flightPlanetPosition does', () => {
    const b = byKey()
    for (const key of PLANET_KEYS) {
      const [x, y, z] = flightPlanetPosition(PLANETS[key].body)(T)
      expect(b[key].position.x).toBeCloseTo(x, 9)
      expect(b[key].position.y).toBeCloseTo(y, 9)
      expect(b[key].position.z).toBeCloseTo(z, 9)
    }
  })

  it('gives every body its mass, with the Moon the smallest well and the Sun the biggest', () => {
    const bodies = createShipBodies()
    for (const body of bodies) {
      expect(body.mass).toBe(
        isMoonKey(body.key)
          ? MOONS[body.key].massKg
          : BODY_MASS_KG[body.key as keyof typeof BODY_MASS_KG]
      )
    }
    // Ganymede and Titan, the heaviest moons, still well inside their
    // parents' wells; the small moons floor at the Moon's.
    expect(wellFactor(MOONS.ganymede.massKg)).toBeLessThan(wellFactor(BODY_MASS_KG.jupiter))
    expect(wellFactor(MOONS.phobos.massKg)).toBe(1)
    const factors = bodies.map((b) => wellFactor(b.mass))
    expect(wellFactor(BODY_MASS_KG.moon)).toBeCloseTo(1, 12)
    expect(Math.min(...factors)).toBeCloseTo(1, 12)
    expect(Math.max(...factors)).toBe(wellFactor(BODY_MASS_KG.sun))
  })

  it('moves the same vectors in place', () => {
    const bodies = createShipBodies()
    const vectors = bodies.map((b) => b.position)
    updateShipBodies(bodies, T)
    const earth = bodies[1].position.clone()
    updateShipBodies(bodies, T + 30 * 86_400_000)
    expect(bodies.map((b) => b.position)).toEqual(vectors)
    expect(bodies.every((b, i) => b.position === vectors[i])).toBe(true)
    expect(bodies[1].position.distanceTo(earth)).toBeGreaterThan(20)
  })

  describe('collision radius (tides-3bl.7)', () => {
    it("keeps the ship outside every shell Earth draws, and a near plane's depth beyond", () => {
      const { earth } = byKey()
      expect(collisionRadius(earth)).toBe(EARTH_COLLISION_RADIUS)
      for (const shell of [
        earth.radius + CLOUD_LAYER_TOP,
        earth.radius * ATMOSPHERE_OUTER,
        earth.radius * AURORA_SHELL_OUTER,
      ]) {
        expect(EARTH_SHELL_RADIUS).toBeGreaterThanOrEqual(shell)
      }
      // From the collision sphere, whatever the near plane is it stays short
      // of the outermost shell (it is measured from the sea-level surface).
      const gap = EARTH_COLLISION_RADIUS - earth.radius
      expect(EARTH_COLLISION_RADIUS - shipNear(gap)).toBeGreaterThanOrEqual(EARTH_SHELL_RADIUS)
      // Close enough that Earth still fills the view: ~1.1 radii.
      expect(EARTH_COLLISION_RADIUS / earth.radius).toBeLessThan(1.15)
    })

    it('leaves the Moon and planets (no displaced or shelled surfaces) on the default margin', () => {
      const b = byKey()
      for (const key of ['sun', 'moon', ...PLANET_KEYS]) {
        expect(b[key].collisionRadius).toBeUndefined()
        expect(collisionRadius(b[key])).toBe(b[key].radius * COLLISION_MARGIN)
      }
    })

    it('stops the ship well clear of even the smallest moon', () => {
      const b = byKey()
      for (const key of MOON_KEYS) {
        const { radius } = b[key]
        expect(collisionRadius(b[key])).toBeGreaterThanOrEqual(radius * COLLISION_MARGIN)
        expect(collisionRadius(b[key]) - radius).toBeGreaterThanOrEqual(MOON_COLLISION_CLEARANCE - 1e-12)
      }
    })

    it('spawns outside every collision sphere', () => {
      for (let day = 0; day < 720; day += 15) {
        const bodies = createShipBodies()
        updateShipBodies(bodies, T + day * 86_400_000)
        for (const aspect of [16 / 9, 390 / 844]) {
          const { position } = spawnPose(bodies, aspect)
          for (const body of bodies) {
            expect(position.distanceTo(body.position)).toBeGreaterThan(collisionRadius(body))
          }
        }
      }
    })
  })

  describe('terrain floor (tides-01v.8.3)', () => {
    afterEach(() => setEarthTerrain(null))

    // Earth's mesh transform at `t`: a local direction in world axes.
    function toWorld(local: THREE.Vector3, t: number): THREE.Vector3 {
      const frame = new THREE.Object3D()
      applyBodyTransform(frame, { tiltAt: earthTilt, spinAt: earthSpin }, t)
      return local.clone().applyQuaternion(frame.quaternion)
    }

    it("samples the ground in Earth's tilted, spinning frame at the bodies' time", () => {
      // One white block over Tibet, sea everywhere else.
      const [width, height] = TERRAIN_MAP_SIZE
      const pooled = new Uint8Array(width * height)
      pooled[Math.floor(((90 - 32) / 180) * height) * width + Math.floor(((88 + 180) / 360) * width)] = 255
      setEarthTerrain(buildTerrainFloor(pooled))
      const tibet = latLonToLocal(32, 88)
      const { earth } = byKey()
      const high = EARTH_RADIUS + TERRAIN_DISPLACEMENT
      expect(earth.ground!(toWorld(tibet, T))).toBeCloseTo(high, 9)
      // A quarter day on, Tibet has turned away from that world direction.
      const later = T + 6 * 3_600_000
      updateShipBodies([earth], later)
      expect(earth.ground!(toWorld(tibet, T))).toBeLessThan(EARTH_RADIUS + 0.01)
      expect(earth.ground!(toWorld(tibet, later))).toBeCloseTo(high, 9)
      // Mirrored through the equator or the prime meridian: open sea.
      expect(earth.ground!(toWorld(latLonToLocal(-32, 88), later))).toBeLessThan(EARTH_RADIUS + 0.01)
      expect(earth.ground!(toWorld(latLonToLocal(32, -88), later))).toBeLessThan(EARTH_RADIUS + 0.01)
    })

    it('keeps the stop at EARTH_COLLISION_RADIUS everywhere, with the real terrain loaded', () => {
      setEarthTerrain(
        buildTerrainFloor(new Uint8Array(readFileSync(new URL('../assets/earth-terrain-max.bin', import.meta.url))))
      )
      const { earth } = byKey()
      const direction = new THREE.Vector3()
      let highest = 0
      for (let lat = -89; lat <= 89; lat += 1) {
        for (let lon = -180; lon < 180; lon += 1) {
          direction.copy(toWorld(latLonToLocal(lat, lon), T))
          highest = Math.max(highest, earth.ground!(direction))
          expect(floorRadius(earth, direction)).toBe(EARTH_COLLISION_RADIUS)
        }
      }
      expect(highest).toBeGreaterThan(EARTH_RADIUS + 0.05)
      expect(highest + EARTH_GROUND_CLEARANCE).toBeLessThan(EARTH_COLLISION_RADIUS)
    })

    it('falls back to the highest the ground can reach until the map loads', () => {
      const { earth } = byKey()
      expect(earth.ground!(new THREE.Vector3(1, 0, 0))).toBe(EARTH_RADIUS + TERRAIN_DISPLACEMENT)
      expect(floorRadius(earth, new THREE.Vector3(0, 1, 0))).toBe(EARTH_COLLISION_RADIUS)
    })

    it('gives no other body a ground', () => {
      for (const body of createShipBodies()) {
        if (body.key !== 'earth') expect(body.ground).toBeUndefined()
      }
    })
  })
})
