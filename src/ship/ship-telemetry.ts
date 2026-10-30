// What the ship is doing, written by the flight controller every frame (via
// stepShip) and read by the HUD and motion cues from their own rAF loops.
// Mutable singleton for the same reason as shipInput: per-frame values must
// not go through React state.
//
// The locked target lives here too, as a plain setter/getter: the HUD sets
// it, the controller passes it to stepShip as targetKey.

import * as THREE from 'three'
import { V_NORMAL } from './flight'

export interface ShipTelemetry {
  /** |velocity|, scene units per second. */
  speed: number
  /**
   * The speed limit where the step ended, scene units/s (the well cap in
   * flight.ts). A locked target further limits only the speed toward it
   * (see approachCap in flight.ts).
   */
  speedCap: number
  /** The throttle the step used: the input clamped to −0.25..1. */
  throttle: number
  flightAssist: boolean
  /** The boost's spool, 0..1 (flight.ts ShipState.boost). */
  boost: number
  /**
   * Whether the boost raised this step's cap (flight.ts boostRaises): the
   * spool is over 0 and the cap is over what it would be unboosted. False
   * where holding boost changes nothing (space, the Moon, the low tier, from
   * ~91 km up, the guard band near the ground), so the HUD's "Boost" is
   * honest.
   */
  boosted: boolean
  /** World-frame velocity, scene units per second. */
  velocity: THREE.Vector3
  /**
   * Closest body surface. key is null only when there are no bodies, in which
   * case surfaceDistance is Infinity.
   */
  nearest: { key: string | null; surfaceDistance: number }
  /**
   * The body whose gravity well sets speedCap (smallest d_eff, flight.ts
   * wellDistanceAt), which a heavy body far off can be rather than the nearest:
   * crawling past the Sun, it is the Sun. key is null only with no bodies;
   * factor is that body's wellFactor (1 then) and floor its speedFloor
   * (V_NORMAL then).
   */
  well: { key: string | null; factor: number; floor: number }
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
  /**
   * The ship through Earth's air (frame-carry.ts fillAir, tides-zmw.9.18):
   * speed, scene units/s (what the HUD reads); coupling, the share of
   * Earth's spin carried; density over sea level's; dynamic pressure, Pa.
   * Without the carry (?surface=0 or the low tier) speed is `speed` and
   * coupling 0; density and dynamic pressure are filled either way
   * (fillAirDensity, tides-xxg), at that speed without it. velocity is the
   * ship's world-frame velocity through the air, scene units/s, whose length
   * is speed (the falling rain and snow stream past along it, tides-bl3.3).
   */
  air: { speed: number; coupling: number; density: number; dynamicPressure: number; velocity: THREE.Vector3 }
  /**
   * Where the eye is over Earth (frame-carry.ts fillEarthEye, tides-bl3.3):
   * up, the world unit direction from Earth's centre to the ship; local, the
   * same in Earth's own frame (Y north, lon 0 at +X, east toward −Z, as
   * surface-ground.ts earthLatLon reads it); altitude over the sea-level
   * sphere, scene units, Infinity without Earth or its spin.
   */
  earthEye: { up: THREE.Vector3; local: THREE.Vector3; altitude: number }
}

export function createShipTelemetry(): ShipTelemetry {
  return {
    speed: 0,
    speedCap: 0,
    throttle: 0,
    flightAssist: true,
    boost: 0,
    boosted: false,
    velocity: new THREE.Vector3(),
    nearest: { key: null, surfaceDistance: Infinity },
    well: { key: null, factor: 1, floor: V_NORMAL },
    target: null,
    colliding: false,
    air: { speed: 0, coupling: 0, density: 0, dynamicPressure: 0, velocity: new THREE.Vector3() },
    earthEye: { up: new THREE.Vector3(0, 1, 0), local: new THREE.Vector3(0, 1, 0), altitude: Infinity },
  }
}

export const shipTelemetry: ShipTelemetry = createShipTelemetry()

/** Zero the singleton in place, keeping its velocity, nearest, well, air and earthEye objects. */
export function resetShipTelemetry(): void {
  shipTelemetry.speed = 0
  shipTelemetry.speedCap = 0
  shipTelemetry.throttle = 0
  shipTelemetry.flightAssist = true
  shipTelemetry.boost = 0
  shipTelemetry.boosted = false
  shipTelemetry.velocity.set(0, 0, 0)
  shipTelemetry.nearest.key = null
  shipTelemetry.nearest.surfaceDistance = Infinity
  shipTelemetry.well.key = null
  shipTelemetry.well.factor = 1
  shipTelemetry.well.floor = V_NORMAL
  shipTelemetry.target = null
  shipTelemetry.colliding = false
  shipTelemetry.air.speed = 0
  shipTelemetry.air.coupling = 0
  shipTelemetry.air.density = 0
  shipTelemetry.air.dynamicPressure = 0
  shipTelemetry.air.velocity.set(0, 0, 0)
  shipTelemetry.earthEye.up.set(0, 1, 0)
  shipTelemetry.earthEye.local.set(0, 1, 0)
  shipTelemetry.earthEye.altitude = Infinity
}

let shipTarget: string | null = null

export function setShipTarget(key: string | null): void {
  shipTarget = key
}

export function getShipTarget(): string | null {
  return shipTarget
}
