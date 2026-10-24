// The spheres ship mode flies among, built from the ephemeris rather than the
// scene's mesh refs: those only register in the interactive main view and go
// stale when it unmounts, and ship mode replaces that view. Positions are at
// the flight scale (flight-scale.ts), as ship mode draws them.

import * as THREE from 'three'
import { earthSpin, earthTilt, type Vec3 } from '../ephemeris'
import { qualityTier, type QualityTier } from '../quality'
import { PLANET_KEYS, PLANETS, sceneRadius, type PlanetKey } from '../planets'
import { positionsFor } from '../flight-scale'
import { MOONS, MOON_KEYS, moonPosition, moonRadius } from '../moons/moons'
import { COLLISION_MARGIN } from './flight'
import { CLOUD_FLAT_ALTITUDE, CLOUD_LAYER_TOP, TERRAIN_DISPLACEMENT } from '../cloud-layer'
import { ATMOSPHERE_OUTER, AURORA_SHELL_OUTER } from '../renderers/earth-shells'
import type { Body as FlightBody } from './flight'
import { SHIP_FOV, shipNear } from './ship-session'
import {
  earthLimbTerrain,
  earthTerrain,
  loadEarthTerrain,
  terrainFloorGreyAround,
  terrainFloorRadius,
} from './terrain-floor'
import { limbSphereInUse } from './limb-detail'

// The scene draws Sun, Earth and Moon with sceneRadius(diameter) as the sphere
// radius (solar-system.tsx), so these match what is on screen.
export const SUN_RADIUS = sceneRadius(1392700000)
export const EARTH_RADIUS = sceneRadius(12742000)
export const MOON_RADIUS = sceneRadius(3474800)

/**
 * The shells Earth draws over its ground: the cloud deck (over terrain
 * displaced up to TERRAIN_DISPLACEMENT; the low-quality path's is flat and
 * lower), the atmosphere's glow and the aurora. The ship camera's near plane
 * keeps clear of them (ship-session.ts shellGap).
 */
export const EARTH_SHELL_RADII: readonly number[] = [
  EARTH_RADIUS + CLOUD_LAYER_TOP,
  EARTH_RADIUS + CLOUD_FLAT_ALTITUDE,
  EARTH_RADIUS * ATMOSPHERE_OUTER,
  EARTH_RADIUS * AURORA_SHELL_OUTER,
]

/**
 * The outermost shell Earth draws. All of them are drawn from inside too
 * (the atmosphere and aurora: tides-01v.8.2; the cloud deck: tides-01v.8.4);
 * inside the displaced ground the whole planet vanishes (tides-3bl.7).
 */
export const EARTH_SHELL_RADIUS = Math.max(...EARTH_SHELL_RADII)

/**
 * Where the ship stops above Earth on the low quality tier: a near plane's
 * depth (shipNear's ceiling) beyond the outermost shell. That tier draws a
 * flat cloud sheet with no columns or in-cloud fog, so it stays above the
 * deck (tides-01v.8.14). Earth still fills the view from there.
 */
export const EARTH_COLLISION_RADIUS = EARTH_SHELL_RADIUS + shipNear(Infinity)

/**
 * How far above the displaced ground (terrain-floor.ts) the ship stops over
 * Earth on the high tier (tides-01v.8.7): under the cloud base
 * (CLOUD_CLEARANCE), so the ship flies below the deck. At 0.4 of it the
 * near plane stays over shipNear's 0.001 floor, and its corners stay off the
 * ground on steep slopes up to 32:9 screens at SHIP_FOV (ship-bodies.test).
 */
export const EARTH_GROUND_CLEARANCE = 0.004

/**
 * How far the near plane's corners reach from the eye at Earth's stop, on
 * screens up to 32:9 at SHIP_FOV (the FOV kick is nil that low): the
 * floor holds the ship clear of the ground that far around it
 * (terrainFloorGreyAround), not only straight down (tides-42p).
 */
export const EARTH_FLOOR_REACH =
  shipNear(EARTH_GROUND_CLEARANCE) *
  Math.sqrt(1 + Math.tan(THREE.MathUtils.degToRad(SHIP_FOV / 2)) ** 2 * (1 + (32 / 9) ** 2))

/**
 * The slowest the speed cap falls to near Earth's ground on the high tier
 * (flight.ts speedFloor), units/s: the cloud deck's few hundredths of a unit
 * take a second or two to cross, where V_NORMAL went through a column a
 * frame. [TUNE]
 */
export const EARTH_GROUND_SPEED = 0.02

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
// world → local undoes the spin after the tilt. On the high tier the ship
// stops on it: the hard sphere drops to the bare sphere's clearance, which
// the floor never reads below. On the low tier the shells' stop stays. The
// floor is the sphere EarthRenderer's ground holds: the limb sphere's (its
// radius is EARTH_RADIUS) while it does (tides-42p), else the 128 × 128
// one's, each taken over the near plane's reach. The ground swaps only far
// out, where both are far below the ship.
function earthStop(
  tier: QualityTier
): Pick<ShipBody, 'collisionRadius' | 'ground' | 'groundClearance' | 'minSpeed' | 'turnTo'> {
  const toLocal = new THREE.Quaternion()
  const euler = new THREE.Euler()
  const local = new THREE.Vector3()
  const low = tier === 'low'
  return {
    collisionRadius: low ? EARTH_COLLISION_RADIUS : EARTH_RADIUS + EARTH_GROUND_CLEARANCE,
    ground: (direction) => {
      local.copy(direction).applyQuaternion(toLocal)
      const floor = (limbSphereInUse(EARTH_RADIUS) ? earthLimbTerrain() : null) ?? earthTerrain()
      if (!floor) return terrainFloorRadius(null, EARTH_RADIUS, local)
      const grey = terrainFloorGreyAround(floor, local, EARTH_FLOOR_REACH / EARTH_RADIUS)
      return EARTH_RADIUS + (TERRAIN_DISPLACEMENT * grey) / 255
    },
    groundClearance: EARTH_GROUND_CLEARANCE,
    minSpeed: low ? undefined : EARTH_GROUND_SPEED,
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
 * until updated. `tier` sets Earth's stop (earthStop).
 */
export function createShipBodies(tier: QualityTier = qualityTier()): ShipBody[] {
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
      ...earthStop(tier),
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
