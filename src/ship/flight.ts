// Ship mode's flight model: pure, frame-rate independent and free of React.
// The controller calls stepShip once per frame with shipInput and the current
// body positions, copies state.position/orientation onto a PerspectiveCamera
// and passes shipTelemetry to be filled for the HUD.
//
// Frame: three's camera convention, so the camera can copy the state
// straight across. In the ship's body frame the nose is −Z, up is +Y and
// right is +X; angularVelocity is in that body frame (rad/s about local
// X = pitch, Y = yaw, Z = roll). World +Y is ecliptic north (eclipticToScene
// maps (x, y, z) → (−x, z, y)), which is what "level" rolls back to.
//
// Feel target: Elite Dangerous.
//
//   • Speed cap v_max = max(V_NORMAL, K_CRUISE · distance to the nearest body
//     surface). One continuous supercruise regime with no mode switch, and it
//     is scale-agnostic: skimming the Moon (r = 1) and crossing the 300-unit
//     gap to Neptune both take a few e-folds of 1/K_CRUISE seconds.
//   • With a target locked the cap is also surfaceDistance / ETA_SECONDS, so
//     the closing speed decays exponentially with the gap (time constant
//     ETA_SECONDS) and the ship can never overshoot.
//   • Flight Assist on: velocity eases toward throttle · v_max along the nose
//     (plus strafe) and rotation eases toward the stick demand, so letting go
//     stops the spin. Off: thrust adds to velocity and spin persists; only the
//     speed cap still applies.
//   • Bodies are hard spheres at radius · COLLISION_MARGIN: the ship is pushed
//     back out along the normal and loses its inward velocity.
//
// Vector maths runs on module-level scratch vectors, as elsewhere in the
// render loop (see ephemeris.ts), so a step allocates no three objects.

import * as THREE from 'three'
import { THROTTLE_MAX, THROTTLE_MIN, type ShipInput } from './ship-input'
import type { ShipTelemetry } from './ship-telemetry'

export interface ShipState {
  position: THREE.Vector3
  /** World frame, scene units per second. */
  velocity: THREE.Vector3
  /** Body → world. Nose is local −Z, up local +Y. */
  orientation: THREE.Quaternion
  /** Body frame, rad/s: x pitch (+ nose up), y yaw (+ nose left), z roll. */
  angularVelocity: THREE.Vector3
}

/** A sphere the ship measures speed against and cannot enter. */
export interface Body {
  key: string
  position: THREE.Vector3
  radius: number
}

export interface FlightEnv {
  bodies: readonly Body[]
  /** Locked target body's key; adds the ETA cap. */
  targetKey: string | null
}

// Frames longer than this (tab switch, GC pause, debugger) are simulated as
// this long: the world just runs slow for that frame instead of the ship
// covering seconds of flight in one jump. With K_CRUISE · MAX_DT = 0.05 a step
// can cover at most 5% of the gap to the nearest surface, so it cannot tunnel.
export const MAX_DT = 0.1

// Hard-sphere radius as a multiple of the body radius. The 2% keeps the
// camera's near plane off the surface mesh (Earth's cloud/atmosphere shells
// sit within ~1.5% of its radius).
export const COLLISION_MARGIN = 1.02

// Speed floor, scene units/s. The cap falls to this within
// V_NORMAL / K_CRUISE = 0.5 units of a surface, i.e. this is the speed for
// skimming. Crossing the Moon (diameter 2) takes ~8 s, Earth (5.9) ~24 s:
// slow enough to read the surface, fast enough not to feel stuck.
export const V_NORMAL = 0.25

// Cruise cap per unit of surface distance, 1/s. Flying straight away from a
// surface at the cap the gap grows as e^(K·t), so leaving Earth from the
// 15-unit spawn to deep space (×10 the gap) takes ln 10 / K ≈ 4.6 s; flying
// at a surface with no target the gap shrinks with a 2 s time constant,
// which still leaves time to turn away. Higher made the Earth approach from
// 15 units twitchy; lower stretched the departure past the trip budget
// (flight.test.ts: Earth → Neptune in 10–40 s).
export const K_CRUISE = 0.5

// Target approach time constant, s. Elite's "7 seconds to target" rule: at
// the cap the HUD ETA stays at 7 s while the gap decays exponentially.
export const ETA_SECONDS = 7

// Flight Assist velocity e-fold, s. Reaching 63% of a new throttle setting
// takes this long at any scale, because the cap (and so the acceleration)
// scales with distance. It is also the FA-off thrust: full throttle from rest
// would reach the cap in this long if accelerating linearly.
export const VELOCITY_TAU = 1

// Rotation e-fold, s: how quickly turn rates follow the stick with FA on (and
// stop when it is released), and how long full stick takes to reach the max
// rate with FA off. Short enough to feel direct, long enough to hide frame
// jitter in mouse/touch input.
export const ROTATION_TAU = 0.2

// Max turn rates at turnRateFactor = 1, rad/s. Elite ships pitch roughly twice
// as fast as they yaw and roll faster still, so pilots learn to roll then
// pitch; the 2:1 ratio keeps that habit without making yaw useless on a
// phone stick. Pitch ≈ 57°/s turns the ship around in ~3 s.
export const PITCH_RATE = 1.0
export const YAW_RATE = 0.5
export const ROLL_RATE = 1.8

// Lateral/vertical thrusters as a share of the cap: enough to line up on a
// moon, too weak to replace turning (Elite's strafe is a fraction of main).
export const STRAFE_SHARE = 0.25

// Level roll rate per radian of roll error, 1/s. With ROTATION_TAU = 0.2 the
// loop's damping ratio is 1 / (2·√(gain·τ)) ≈ 0.71: settles in ~2 s without
// a visible overshoot.
export const LEVEL_GAIN = 2.5

// Elite's blue zone: the throttle band with the best turn rate. Turning is
// still decent at a standstill and worst at full throttle, which nudges
// pilots to ease off for tight manoeuvres.
export const BLUE_ZONE: readonly [number, number] = [0.5, 0.75]
export const TURN_FACTOR_IDLE = 0.7
export const TURN_FACTOR_FULL = 0.6

const WORLD_UP = new THREE.Vector3(0, 1, 0)

export function createShipState(): ShipState {
  return {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    orientation: new THREE.Quaternion(),
    angularVelocity: new THREE.Vector3(),
  }
}

export interface NearestBody {
  body: Body
  /** From the surface (not the collision shell); negative inside. */
  surfaceDistance: number
}

function surfaceDistance(position: THREE.Vector3, body: Body): number {
  return position.distanceTo(body.position) - body.radius
}

function findBody(bodies: readonly Body[], key: string | null): Body | null {
  if (key == null) return null
  for (const body of bodies) {
    if (body.key === key) return body
  }
  return null
}

/** Closest surface to `position`, or null when there are no bodies. */
export function nearestBody(
  position: THREE.Vector3,
  bodies: readonly Body[]
): NearestBody | null {
  let best: Body | null = null
  let bestDistance = Infinity
  for (const body of bodies) {
    const d = surfaceDistance(position, body)
    if (d < bestDistance) {
      best = body
      bestDistance = d
    }
  }
  return best && { body: best, surfaceDistance: bestDistance }
}

/**
 * The speed limit at `position`, scene units/s. With no bodies there is
 * nothing to scale against, so V_NORMAL.
 *
 * `dt` makes the target cap exact for a discrete step: moving at
 * gap / (ETA + dt) for dt leaves speed ≤ newGap / ETA, so the ETA cap holds
 * after the step as well as before it.
 */
export function speedCap(
  position: THREE.Vector3,
  bodies: readonly Body[],
  targetKey: string | null,
  dt = 0
): number {
  const nearest = nearestBody(position, bodies)
  let cap = nearest
    ? Math.max(V_NORMAL, K_CRUISE * Math.max(0, nearest.surfaceDistance))
    : V_NORMAL
  const target = findBody(bodies, targetKey)
  if (target) {
    const gap = Math.max(0, surfaceDistance(position, target))
    cap = Math.min(cap, gap / (ETA_SECONDS + dt))
  }
  return cap
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

// Inputs come from pointer maths; NaN would poison the state for good.
function axis(x: number): number {
  return Number.isFinite(x) ? clamp(x, -1, 1) : 0
}

/**
 * Turn-rate multiplier for a throttle setting: 1 across BLUE_ZONE, falling
 * linearly to TURN_FACTOR_IDLE at 0 and TURN_FACTOR_FULL at 1. Reverse
 * throttle uses its magnitude.
 */
export function turnRateFactor(throttle: number): number {
  const t = Number.isFinite(throttle) ? clamp(Math.abs(throttle), 0, 1) : 0
  const [lo, hi] = BLUE_ZONE
  if (t < lo) return lerp(TURN_FACTOR_IDLE, 1, t / lo)
  if (t <= hi) return 1
  return lerp(1, TURN_FACTOR_FULL, (t - hi) / (1 - hi))
}

const nose = new THREE.Vector3()
const right = new THREE.Vector3()
const up = new THREE.Vector3()
const levelUp = new THREE.Vector3()
const scratch = new THREE.Vector3()
const demand = new THREE.Vector3()
const spinAxis = new THREE.Vector3()
const spin = new THREE.Quaternion()

function bodyAxes(orientation: THREE.Quaternion): void {
  nose.set(0, 0, -1).applyQuaternion(orientation)
  right.set(1, 0, 0).applyQuaternion(orientation)
  up.set(0, 1, 0).applyQuaternion(orientation)
}

// Roll rate (about body +Z) that turns the ship's up toward ecliptic north
// projected off the nose. Zero when the nose is within ~0.8° of a pole, where
// "up" is undefined.
function levelRollRate(): number {
  levelUp.copy(WORLD_UP).addScaledVector(nose, -nose.y)
  if (levelUp.lengthSq() < 1e-4) return 0
  levelUp.normalize()
  // Body +Z in world is −nose; signed angle from up to levelUp about it.
  const sin = scratch.crossVectors(up, levelUp).dot(nose) * -1
  const error = Math.atan2(sin, up.dot(levelUp))
  return clamp(error * LEVEL_GAIN, -ROLL_RATE, ROLL_RATE)
}

function rotate(state: ShipState, input: Readonly<ShipInput>, dt: number): void {
  const factor = turnRateFactor(input.throttle)
  // Body-frame signs: +X pitches the nose up, +Y yaws it left, +Z rolls left.
  demand.set(
    axis(input.pitch) * PITCH_RATE * factor,
    -axis(input.yaw) * YAW_RATE * factor,
    -axis(input.roll) * ROLL_RATE * factor
  )
  bodyAxes(state.orientation)
  if (input.level) demand.z = levelRollRate()

  const w = state.angularVelocity
  const ease = 1 - Math.exp(-dt / ROTATION_TAU)
  if (input.flightAssist) {
    w.lerp(demand, ease)
  } else {
    // Full stick reaches the max rate in ROTATION_TAU; nothing damps it.
    w.x = clamp(w.x + (demand.x * dt) / ROTATION_TAU, -PITCH_RATE, PITCH_RATE)
    w.y = clamp(w.y + (demand.y * dt) / ROTATION_TAU, -YAW_RATE, YAW_RATE)
    // Level is an assist of its own, so it damps roll even with FA off.
    w.z = input.level
      ? lerp(w.z, demand.z, ease)
      : clamp(w.z + (demand.z * dt) / ROTATION_TAU, -ROLL_RATE, ROLL_RATE)
  }

  const rate = w.length()
  if (rate > 0) {
    spin.setFromAxisAngle(spinAxis.copy(w).divideScalar(rate), rate * dt)
    state.orientation.multiply(spin).normalize()
  }
}

function translate(
  state: ShipState,
  input: Readonly<ShipInput>,
  dt: number,
  cap: number
): void {
  bodyAxes(state.orientation)
  const throttle = Number.isFinite(input.throttle)
    ? clamp(input.throttle, THROTTLE_MIN, THROTTLE_MAX)
    : 0
  // Thrust as a share of the cap, world frame.
  scratch
    .copy(nose)
    .multiplyScalar(throttle)
    .addScaledVector(right, STRAFE_SHARE * axis(input.strafeX))
    .addScaledVector(up, STRAFE_SHARE * axis(input.strafeY))

  const v = state.velocity
  if (input.flightAssist) {
    scratch.multiplyScalar(cap).clampLength(0, cap)
    v.lerp(scratch, 1 - Math.exp(-dt / VELOCITY_TAU))
  } else {
    v.addScaledVector(scratch, (cap / VELOCITY_TAU) * dt)
  }
  v.clampLength(0, cap)
}

// Push the ship out of any body it ended inside and drop the velocity
// component into it, so it slides along the surface. Bodies in the scene
// never overlap, so one pass leaves the ship outside all of them.
function collide(state: ShipState, bodies: readonly Body[]): boolean {
  let hit = false
  for (const body of bodies) {
    const shell = body.radius * COLLISION_MARGIN
    const normal = scratch.subVectors(state.position, body.position)
    const d = normal.length()
    if (d >= shell) continue
    hit = true
    if (d > 1e-9) normal.divideScalar(d)
    else normal.copy(WORLD_UP)
    state.position.copy(body.position).addScaledVector(normal, shell)
    const inward = state.velocity.dot(normal)
    if (inward < 0) state.velocity.addScaledVector(normal, -inward)
  }
  return hit
}

function fillTelemetry(
  out: ShipTelemetry,
  state: ShipState,
  input: Readonly<ShipInput>,
  env: FlightEnv,
  cap: number,
  colliding: boolean
): void {
  out.speed = state.velocity.length()
  out.speedCap = cap
  out.throttle = input.throttle
  out.flightAssist = input.flightAssist
  out.velocity.copy(state.velocity)
  out.colliding = colliding

  const nearest = nearestBody(state.position, env.bodies)
  out.nearest.key = nearest ? nearest.body.key : null
  out.nearest.surfaceDistance = nearest ? nearest.surfaceDistance : Infinity

  const target = findBody(env.bodies, env.targetKey)
  if (!target) {
    out.target = null
    return
  }
  const gap = surfaceDistance(state.position, target)
  const closing = state.velocity.dot(
    scratch.subVectors(target.position, state.position).normalize()
  )
  if (!out.target) out.target = { key: target.key, surfaceDistance: 0, etaSeconds: 0 }
  out.target.key = target.key
  out.target.surfaceDistance = gap
  out.target.etaSeconds = closing > 0 ? Math.max(0, gap) / closing : Infinity
}

/**
 * Advance the ship by `dt` seconds (clamped to MAX_DT; non-finite or negative
 * dt is a zero step). Mutates and returns `state`; fills `telemetry` when
 * given. The cap is taken at the start of the step, so a step can never
 * carry the ship further than the cap allows from where it was.
 */
export function stepShip(
  state: ShipState,
  input: Readonly<ShipInput>,
  dt: number,
  env: FlightEnv,
  telemetry?: ShipTelemetry
): ShipState {
  const h = Number.isFinite(dt) ? clamp(dt, 0, MAX_DT) : 0
  const cap = speedCap(state.position, env.bodies, env.targetKey, h)
  let colliding = false
  if (h > 0) {
    rotate(state, input, h)
    translate(state, input, h, cap)
    state.position.addScaledVector(state.velocity, h)
    colliding = collide(state, env.bodies)
  }
  if (telemetry) fillTelemetry(telemetry, state, input, env, cap, colliding)
  return state
}
