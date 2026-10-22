import { describe, expect, it } from 'vitest'
import { EARTH_ORBIT_RADIUS } from '../ephemeris'
import { PLANET_KEYS, PLANETS, planetPosition, sceneRadius } from '../planets'
import { CLOUD_LAYER_TOP } from '../cloud-layer'
import { ATMOSPHERE_OUTER, AURORA_SHELL_OUTER } from '../renderers/earth-shells'
import { COLLISION_MARGIN, collisionRadius } from './flight'
import {
  EARTH_COLLISION_RADIUS,
  EARTH_SHELL_RADIUS,
  createShipBodies,
  updateShipBodies,
} from './ship-bodies'
import { shipNear, spawnPose } from './ship-session'

const T = Date.UTC(2026, 9, 22, 12)

function byKey(t = T) {
  const bodies = createShipBodies()
  updateShipBodies(bodies, t)
  return Object.fromEntries(bodies.map((b) => [b.key, b]))
}

describe('ship bodies', () => {
  it('has the Sun, Earth, Moon and every planet once', () => {
    expect(createShipBodies().map((b) => b.key)).toEqual([
      'sun',
      'earth',
      'moon',
      ...PLANET_KEYS,
    ])
  })

  it('sizes them as the scene draws them', () => {
    const b = byKey()
    expect(b.sun.radius).toBeCloseTo(10, 6)
    expect(b.moon.radius).toBeCloseTo(1, 6)
    expect(b.earth.radius).toBeCloseTo(sceneRadius(12742e3), 9)
    expect(b.earth.radius).toBeCloseTo(2.95, 2)
    for (const key of PLANET_KEYS) expect(b[key].radius).toBe(PLANETS[key].radius)
  })

  it('keeps the Sun at the origin and Earth on its orbit', () => {
    const b = byKey()
    expect(b.sun.position.length()).toBe(0)
    expect(b.earth.position.length()).toBeCloseTo(EARTH_ORBIT_RADIUS, 6)
  })

  it('puts the Moon about 10 units from Earth', () => {
    for (let day = 0; day < 30; day += 3) {
      const b = byKey(T + day * 86_400_000)
      expect(b.moon.position.distanceTo(b.earth.position)).toBeGreaterThan(9)
      expect(b.moon.position.distanceTo(b.earth.position)).toBeLessThan(11)
    }
  })

  it('places each planet where planetPosition does', () => {
    const b = byKey()
    for (const key of PLANET_KEYS) {
      const [x, y, z] = planetPosition(PLANETS[key].body)(T)
      expect(b[key].position.x).toBeCloseTo(x, 9)
      expect(b[key].position.y).toBeCloseTo(y, 9)
      expect(b[key].position.z).toBeCloseTo(z, 9)
    }
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
})
