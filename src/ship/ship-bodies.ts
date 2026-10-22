// The spheres ship mode flies among, built from the ephemeris rather than the
// scene's mesh refs: those only register in the interactive main view and go
// stale when it unmounts, and ship mode replaces that view.

import * as THREE from 'three'
import { earthPosition, moonPosition, type Vec3 } from '../ephemeris'
import { PLANET_KEYS, PLANETS, planetPosition, sceneRadius } from '../planets'
import type { Body as FlightBody } from './flight'

// The scene draws Sun, Earth and Moon with sceneRadius(diameter) as the sphere
// radius (solar-system.tsx), so these match what is on screen.
export const SUN_RADIUS = sceneRadius(1392700000)
export const EARTH_RADIUS = sceneRadius(12742000)
export const MOON_RADIUS = sceneRadius(3474800)

export interface ShipBody extends FlightBody {
  /** Null for the Sun, which stays at the origin. */
  positionAt: ((t: number) => Vec3) | null
}

/** Sun, Earth, Moon and the seven planets, positions unset until updated. */
export function createShipBodies(): ShipBody[] {
  return [
    { key: 'sun', position: new THREE.Vector3(), radius: SUN_RADIUS, positionAt: null },
    { key: 'earth', position: new THREE.Vector3(), radius: EARTH_RADIUS, positionAt: earthPosition },
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
