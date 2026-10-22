// What the ship is doing, written by the flight controller every frame (via
// stepShip) and read by the HUD and motion cues from their own rAF loops.
// Mutable singleton for the same reason as shipInput: per-frame values must
// not go through React state.
//
// The locked target lives here too, as a plain setter/getter: the HUD sets
// it, the controller passes it to stepShip as targetKey.

import * as THREE from 'three'

export interface ShipTelemetry {
  /** |velocity|, scene units per second. */
  speed: number
  /**
   * The cruise speed limit this frame, scene units/s. A locked target further
   * limits only the speed toward it (see approachCap in flight.ts).
   */
  speedCap: number
  /** The throttle the step used: the input clamped to −0.25..1. */
  throttle: number
  flightAssist: boolean
  /** World-frame velocity, scene units per second. */
  velocity: THREE.Vector3
  /**
   * Closest body surface. key is null only when there are no bodies, in which
   * case surfaceDistance is Infinity.
   */
  nearest: { key: string | null; surfaceDistance: number }
  /**
   * The locked target, or null without one (or when its key matches no body).
   * etaSeconds is surface distance over closing speed; Infinity when not
   * closing.
   */
  target: { key: string; surfaceDistance: number; etaSeconds: number } | null
  /**
   * True when this step hit a body: pushed out of it while moving inward
   * faster than COLLISION_SPEED. Resting on or pressing into a surface is not
   * a hit.
   */
  colliding: boolean
}

export function createShipTelemetry(): ShipTelemetry {
  return {
    speed: 0,
    speedCap: 0,
    throttle: 0,
    flightAssist: true,
    velocity: new THREE.Vector3(),
    nearest: { key: null, surfaceDistance: Infinity },
    target: null,
    colliding: false,
  }
}

export const shipTelemetry: ShipTelemetry = createShipTelemetry()

/** Zero the singleton in place, keeping its velocity and nearest objects. */
export function resetShipTelemetry(): void {
  shipTelemetry.speed = 0
  shipTelemetry.speedCap = 0
  shipTelemetry.throttle = 0
  shipTelemetry.flightAssist = true
  shipTelemetry.velocity.set(0, 0, 0)
  shipTelemetry.nearest.key = null
  shipTelemetry.nearest.surfaceDistance = Infinity
  shipTelemetry.target = null
  shipTelemetry.colliding = false
}

let shipTarget: string | null = null

export function setShipTarget(key: string | null): void {
  shipTarget = key
}

export function getShipTarget(): string | null {
  return shipTarget
}
