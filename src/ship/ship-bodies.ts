// The spheres ship mode flies among, built from the ephemeris rather than the
// scene's mesh refs: those only register in the interactive main view and go
// stale when it unmounts, and ship mode replaces that view.

import * as THREE from 'three'
import { earthPosition, moonPosition, type Vec3 } from '../ephemeris'
import { PLANET_KEYS, PLANETS, planetPosition, sceneRadius } from '../planets'
import { CLOUD_LAYER_TOP } from '../cloud-layer'
import { ATMOSPHERE_OUTER, AURORA_SHELL_OUTER } from '../renderers/earth-shells'
import type { Body as FlightBody } from './flight'
import { shipNear } from './ship-session'

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

export interface ShipBody extends FlightBody {
  /** Null for the Sun, which stays at the origin. */
  positionAt: ((t: number) => Vec3) | null
}

/** Sun, Earth, Moon and the seven planets, positions unset until updated. */
export function createShipBodies(): ShipBody[] {
  return [
    { key: 'sun', position: new THREE.Vector3(), radius: SUN_RADIUS, positionAt: null },
    {
      key: 'earth',
      position: new THREE.Vector3(),
      radius: EARTH_RADIUS,
      collisionRadius: EARTH_COLLISION_RADIUS,
      positionAt: earthPosition,
    },
    { key: 'moon', position: new THREE.Vector3(), radius: MOON_RADIUS, positionAt: moonPosition },
    ...PLANET_KEYS.map((key) => ({
      key,
      position: new THREE.Vector3(),
      radius: PLANETS[key].radius,
      positionAt: planetPosition(PLANETS[key].body),
    })),
  ]
}

/** Move `bodies` (from createShipBodies) to where they are at `t`, epoch ms. */
export function updateShipBodies(bodies: readonly ShipBody[], t: number): void {
  for (const body of bodies) {
    if (body.positionAt) body.position.fromArray(body.positionAt(t))
  }
}
