// The spheres ship mode flies among, built from the ephemeris rather than the
// scene's mesh refs: those only register in the interactive main view and go
// stale when it unmounts, and ship mode replaces that view. Positions are at
// the flight scale (flight-scale.ts), as ship mode draws them.

import * as THREE from 'three'
import { earthSpin, earthTilt, type Vec3 } from '../ephemeris'
import { PLANET_KEYS, PLANETS, sceneRadius, type PlanetKey } from '../planets'
import { positionsFor } from '../flight-scale'
import { MOONS, MOON_KEYS, moonPosition, moonRadius } from '../moons/moons'
import { COLLISION_MARGIN } from './flight'
import { CLOUD_LAYER_TOP } from '../cloud-layer'
import { ATMOSPHERE_OUTER, AURORA_SHELL_OUTER } from '../renderers/earth-shells'
import type { Body as FlightBody } from './flight'
import { shipNear } from './ship-session'
import { earthTerrain, loadEarthTerrain, terrainFloorRadius } from './terrain-floor'

// The scene draws Sun, Earth and Moon with sceneRadius(diameter) as the sphere
// radius (solar-system.tsx), so these match what is on screen.
export const SUN_RADIUS = sceneRadius(1392700000)
export const EARTH_RADIUS = sceneRadius(12742000)
export const MOON_RADIUS = sceneRadius(3474800)

/**
 * The outermost shell Earth draws: the cloud deck (over terrain displaced up
 * to TERRAIN_DISPLACEMENT), the atmosphere's glow and the aurora. Each is a
 * front-faced sphere, so from inside it is culled; inside the displaced
 * ground the whole planet vanishes (tides-3bl.7).
 */
export const EARTH_SHELL_RADIUS = Math.max(
  EARTH_RADIUS + CLOUD_LAYER_TOP,
  EARTH_RADIUS * ATMOSPHERE_OUTER,
  EARTH_RADIUS * AURORA_SHELL_OUTER
)

/**
 * Where the ship stops above Earth: a near plane's depth (shipNear's
 * ceiling) beyond the outermost shell, so no shell is ever clipped by the
 * camera's near plane either. Earth still fills the view from there.
 */
export const EARTH_COLLISION_RADIUS = EARTH_SHELL_RADIUS + shipNear(Infinity)

/**
 * How far above the displaced ground (terrain-floor.ts) the ship stops over
 * Earth. EARTH_COLLISION_RADIUS still clamps the stop, far above it, until
 * the ship can fly below the cloud deck (tides-01v.8.7).
 */
export const EARTH_GROUND_CLEARANCE = 0.004

/**
 * Masses, kg, for the flight model's gravity wells (flight.ts wellFactor).
 * The other planets' moons (tides-2hv.8) take theirs from moons.ts' MOONS.
 */
export const BODY_MASS_KG: Readonly<Record<'sun' | 'earth' | 'moon' | PlanetKey, number>> = {
  sun: 1.989e30,
  earth: 5.972e24,
  moon: 7.342e22,
  mercury: 3.301e23,
  venus: 4.867e24,
  mars: 6.417e23,
  jupiter: 1.898e27,
  saturn: 5.683e26,
  uranus: 8.681e25,
  neptune: 1.024e26,
}

export interface ShipBody extends FlightBody {
  /** Null for the Sun, which stays at the origin. */
  positionAt: ((t: number) => Vec3) | null
  /** Turns a body whose ground is sampled in its own frame (Earth) to `t`. */
  turnTo?: (t: number) => void
}

const DEG = Math.PI / 180

// Earth's ground: its terrain floor, read in its own spinning frame. The
// mesh tilts about X, then spins about the tilted Y (body-transform.ts), so
// world → local undoes the spin after the tilt.
function earthGround(): Pick<ShipBody, 'ground' | 'groundClearance' | 'turnTo'> {
  const toLocal = new THREE.Quaternion()
  const euler = new THREE.Euler()
  const local = new THREE.Vector3()
  return {
    ground: (direction) =>
      terrainFloorRadius(earthTerrain(), EARTH_RADIUS, local.copy(direction).applyQuaternion(toLocal)),
    groundClearance: EARTH_GROUND_CLEARANCE,
    turnTo: (t) => {
      toLocal.setFromEuler(euler.set(earthTilt(t) * DEG, earthSpin(t), 0, 'XYZ')).invert()
    },
  }
}

/**
 * The ship's stop above a major moon (tides-2hv.8). COLLISION_MARGIN's 2%
 * of Deimos' 0.23 is ~0.005 units, the near plane's own floor, so a moon's
 * shell stands at least MOON_COLLISION_CLEARANCE off its sphere. [TUNE]
 */
export const MOON_COLLISION_CLEARANCE = 0.02

/**
 * Sun, Earth, Moon, the seven planets and their major moons, positions unset
 * until updated.
 */
export function createShipBodies(): ShipBody[] {
  const { positionAt } = positionsFor('flight')
  loadEarthTerrain()
  return [
    {
      key: 'sun',
      position: new THREE.Vector3(),
      radius: SUN_RADIUS,
      mass: BODY_MASS_KG.sun,
      positionAt: null,
    },
    {
      key: 'earth',
      position: new THREE.Vector3(),
      radius: EARTH_RADIUS,
      collisionRadius: EARTH_COLLISION_RADIUS,
      ...earthGround(),
      mass: BODY_MASS_KG.earth,
      positionAt: positionAt.earth,
    },
    {
      key: 'moon',
      position: new THREE.Vector3(),
      radius: MOON_RADIUS,
      mass: BODY_MASS_KG.moon,
      positionAt: positionAt.moon,
    },
    ...PLANET_KEYS.map((key) => ({
      key,
      position: new THREE.Vector3(),
      radius: PLANETS[key].radius,
      mass: BODY_MASS_KG[key],
      positionAt: positionAt[key],
    })),
    ...MOON_KEYS.map((key) => {
      const radius = moonRadius(key)
      return {
        key,
        position: new THREE.Vector3(),
        radius,
        collisionRadius: Math.max(radius * COLLISION_MARGIN, radius + MOON_COLLISION_CLEARANCE),
        mass: MOONS[key].massKg,
        positionAt: (t: number) => moonPosition(key, t, 'flight'),
      }
    }),
  ]
}

/**
 * Move and turn `bodies` (from createShipBodies) to where they are at `t`,
 * epoch ms.
 */
export function updateShipBodies(bodies: readonly ShipBody[], t: number): void {
  for (const body of bodies) {
    if (body.positionAt) body.position.fromArray(body.positionAt(t))
    body.turnTo?.(t)
  }
}
