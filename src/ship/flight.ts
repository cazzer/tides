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
//   • With a target locked, the speed *toward* it is also capped at
//     max(V_NORMAL, surfaceDistance / ETA_SECONDS), so the approach decays
//     exponentially with the gap (time constant ETA_SECONDS) and can't
//     overshoot. Only the closing component is limited: leaving or flying
//     past a locked target is as fast as untargeted, and the V_NORMAL floor
//     means the last stretch to the surface takes seconds, not forever.
//   • Flight Assist on: velocity eases toward throttle · v_max along the nose
//     (plus strafe) and rotation eases toward the stick demand, so letting go
//     stops the spin. Off: thrust adds to velocity and spin persists; only the
//     speed cap still applies.
//   • Turn rates are full up to the top of BLUE_ZONE (speed as a share of
//     v_max) and ease off above it, to TURN_RATE_MIN_FACTOR at the cap.
//     Slow is never penalised, so easing off is always the way to turn tight.
//   • Bodies are hard spheres at radius · COLLISION_MARGIN: the ship is pushed
//     back out along the normal and loses its inward velocity.
//
// A step allocates nothing: vector maths runs on module-level scratch vectors
// and the nearest/target scan writes into a scratch record, as elsewhere in
// the render loop (see ephemeris.ts).

import * as THREE from 'three'
import { THROTTLE_MAX, THROTTLE_MIN, type ShipInput } from './ship-input'
import type { ShipTelemetry } from './ship-telemetry'

export interface ShipState {
  position: THREE.Vector3
  /** World frame, scene units per second. */
  velocity: THREE.Vector3
  /** Body → world. Nose is local −Z, up local +Y. */
  orientation: THREE.Quaternion
  /**
   * Body frame, rad/s, right-handed about the local axes: x pitch (+ nose up),
   * y yaw (+ nose LEFT), z roll (+ rolls LEFT). Yaw and roll are the opposite
   * sign to ShipInput, whose +1 means right; rotate() does the flip.
   */
  angularVelocity: THREE.Vector3
}

/** A sphere the ship measures speed against and cannot enter. */
export interface Body {
  key: string
  position: THREE.Vector3
  /** The drawn sphere's radius; speed caps and telemetry measure from it. */
  radius: number
  /**
   * The hard sphere the ship stays outside, when the body draws shells above
   * its sphere (Earth's terrain, clouds and atmosphere; tides-3bl.7). Without
   * one, radius × COLLISION_MARGIN. See collisionRadius.
   */
  collisionRadius?: number
}

/** The closest the ship gets to `body`'s centre, scene units. */
export function collisionRadius(body: Body): number {
  return body.collisionRadius ?? body.radius * COLLISION_MARGIN
}

export interface FlightEnv {
  bodies: readonly Body[]
  /** Locked target body's key; caps the speed toward it (approachCap). */
  targetKey: string | null
}

// Frames longer than this (tab switch, GC pause, debugger) are simulated as
// this long: the world just runs slow for that frame instead of the ship
// covering seconds of flight in one jump. With K_CRUISE · MAX_DT = 0.05 a step
// can cover at most 5% of the gap to the nearest surface, so it cannot tunnel.
export const MAX_DT = 0.1

// Hard-sphere radius as a multiple of the body radius, for a body without its
// own collisionRadius. The 2% keeps the camera's near plane off the surface
// mesh. Earth's displaced terrain and shells reach further and set their own
// (ship-bodies.ts EARTH_COLLISION_RADIUS).
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

// Inward speed at the collision shell, units/s, above which a step counts as
// a hit (telemetry.colliding). Resting on a surface or holding thrust into it
// gains at most V_NORMAL · (1 − e^(−MAX_DT / VELOCITY_TAU)) ≈ 0.024 a step
// (FA off: V_NORMAL · MAX_DT / VELOCITY_TAU = 0.025) before being cancelled,
// so 0.05 never flags those, while arriving at the V_NORMAL floor always does.
export const COLLISION_SPEED = 0.05

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

// Max turn rates at turnRateMultiplier = 1, rad/s. Elite ships pitch roughly
// twice as fast as they yaw and roll faster still, so pilots learn to roll
// then pitch; the 2:1 ratio keeps that habit without making yaw useless on a
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

// Elite's blue zone, as a share of the speed cap: its top is the fastest the
// ship can fly and still turn at the full rate. Above it the rate eases down
// to TURN_RATE_MIN_FACTOR at the cap; below it there is no penalty, so
// slowing down is always the way to turn tighter. The lower edge doesn't
// enter the physics: it is where the HUD and touch throttles start drawing
// the band. They draw it on the throttle because with FA on and a steady cap
// the speed settles to throttle · cap; a cap that shrinks on the way in to a
// body leaves the speed above that (turning suffers sooner) and one that
// grows on the way out leaves it below. [TUNE] the top sets where turning
// starts to suffer.
export const BLUE_ZONE: readonly [number, number] = [0.5, 0.75]

// Turn-rate multiplier at the speed cap. [TUNE] At 0.4 a 90° yaw at the cap
// takes ~8 s against ~3.4 s in the band: enough that pilots ease off for
// tight manoeuvres, not so much that a fast ship can't be steered.
export const TURN_RATE_MIN_FACTOR = 0.4

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

const { clamp, lerp } = THREE.MathUtils

// One pass over the bodies for both the nearest surface and the target, into
// a reused record so the per-frame scan allocates nothing.
interface Proximity {
  nearest: Body | null
  nearestGap: number
  target: Body | null
  targetGap: number
}

const proximity: Proximity = {
  nearest: null,
  nearestGap: Infinity,
  target: null,
  targetGap: Infinity,
}

function measure(
  position: THREE.Vector3,
  bodies: readonly Body[],
  targetKey: string | null
): Proximity {
  proximity.nearest = null
  proximity.nearestGap = Infinity
  proximity.target = null
  proximity.targetGap = Infinity
  for (const body of bodies) {
    const gap = position.distanceTo(body.position) - body.radius
    if (gap < proximity.nearestGap) {
      proximity.nearest = body
      proximity.nearestGap = gap
    }
    if (targetKey != null && body.key === targetKey) {
      proximity.target = body
      proximity.targetGap = gap
    }
  }
  return proximity
}

/** Closest surface to `position`, or null when there are no bodies. */
export function nearestBody(
  position: THREE.Vector3,
  bodies: readonly Body[]
): NearestBody | null {
  const { nearest, nearestGap } = measure(position, bodies, null)
  return nearest && { body: nearest, surfaceDistance: nearestGap }
}

function cruiseCap({ nearest, nearestGap }: Proximity): number {
  return nearest ? Math.max(V_NORMAL, K_CRUISE * Math.max(0, nearestGap)) : V_NORMAL
}

/**
 * The speed limit at `position`, scene units/s: max(V_NORMAL, K_CRUISE ·
 * nearest surface distance). With no bodies there is nothing to scale
 * against, so V_NORMAL.
 */
export function speedCap(position: THREE.Vector3, bodies: readonly Body[]): number {
  return cruiseCap(measure(position, bodies, null))
}

/**
 * The limit on speed toward a locked target `gap` from its surface.
 *
 * `dt` makes the cap exact for a discrete step: closing at gap / (ETA + dt)
 * for dt leaves the closing speed ≤ newGap / ETA, so the ETA rule holds after
 * the step as well as before it.
 */
export function approachCap(gap: number, dt = 0): number {
  return Math.max(V_NORMAL, Math.max(0, gap) / (ETA_SECONDS + dt))
}

// Inputs come from pointer maths; NaN would poison the state for good.
function axis(x: number): number {
  return Number.isFinite(x) ? clamp(x, -1, 1) : 0
}

function usableThrottle(throttle: number): number {
  return Number.isFinite(throttle) ? clamp(throttle, THROTTLE_MIN, THROTTLE_MAX) : 0
}

/**
 * `speed` as a share of `cap`, clamped to 0..1. A zero cap reads as 0 at
 * rest and 1 when moving; an infinite one as 0. Never NaN.
 */
export function speedFraction(speed: number, cap: number): number {
  const fraction = speed / Math.max(cap, 1e-9)
  return Number.isNaN(fraction) ? 0 : clamp(fraction, 0, 1)
}

/**
 * Turn-rate multiplier for a speed fraction (see speedFraction): 1 up to the
 * top of BLUE_ZONE, then a smoothstep down to TURN_RATE_MIN_FACTOR at the
 * cap. A smoothstep has no kink at either end, so accelerating out of the
 * band never jolts a turn in progress.
 */
export function turnRateMultiplier(fraction: number): number {
  const top = BLUE_ZONE[1]
  const t = Number.isNaN(fraction) ? 0 : clamp((fraction - top) / (1 - top), 0, 1)
  return 1 - (1 - TURN_RATE_MIN_FACTOR) * t * t * (3 - 2 * t)
}

const nose = new THREE.Vector3()
const right = new THREE.Vector3()
const up = new THREE.Vector3()
const levelUp = new THREE.Vector3()
const scratch = new THREE.Vector3()
const toTarget = new THREE.Vector3()
const demand = new THREE.Vector3()
const spinAxis = new THREE.Vector3()
const spin = new THREE.Quaternion()

function bodyAxes(orientation: THREE.Quaternion): void {
  nose.set(0, 0, -1).applyQuaternion(orientation)
  right.set(1, 0, 0).applyQuaternion(orientation)
  up.set(0, 1, 0).applyQuaternion(orientation)
}

// Roll rate (about body +Z) that turns the ship's up toward ecliptic north
// projected off the nose. Zero when the nose is within ~0.6° of a pole, where
// "up" is undefined.
function levelRollRate(): number {
  levelUp.copy(WORLD_UP).projectOnPlane(nose)
  if (levelUp.lengthSq() < 1e-4) return 0
  levelUp.normalize()
  // Body +Z in world is −nose; signed angle from up to levelUp about it.
  const sin = -scratch.crossVectors(up, levelUp).dot(nose)
  const error = Math.atan2(sin, up.dot(levelUp))
  return clamp(error * LEVEL_GAIN, -ROLL_RATE, ROLL_RATE)
}

// `fraction` is the speed as a share of the cap (speedFraction). Turning keys
// off how fast the ship is going, not where the throttle sits, so with FA off
// a ship coasting at the cap still turns wide.
function rotate(
  state: ShipState,
  input: Readonly<ShipInput>,
  dt: number,
  fraction: number
): void {
  const factor = turnRateMultiplier(fraction)
  // Input +1 is nose up / nose right / roll right; in the body frame that is
  // +X, −Y, −Z (see ShipState.angularVelocity).
  demand.set(
    axis(input.pitch) * PITCH_RATE * factor,
    -axis(input.yaw) * YAW_RATE * factor,
    -axis(input.roll) * ROLL_RATE * factor
  )
  bodyAxes(state.orientation)
  // Level is unscaled: it is a recovery assist, and should right the ship as
  // quickly at the cap as at rest.
  if (input.level) demand.z = levelRollRate()

  const w = state.angularVelocity
  const ease = 1 - Math.exp(-dt / ROTATION_TAU)
  if (input.flightAssist) {
    w.lerp(demand, ease)
  } else {
    // Full stick reaches the max rate in ROTATION_TAU; nothing damps it. The
    // clamp is the raw max rate, deliberately not × turnRateMultiplier:
    // speeding up with FA off must not brake a spin the pilot built up.
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
  cap: number,
  target: Body | null,
  targetGap: number
): void {
  bodyAxes(state.orientation)
  // Thrust as a share of the cap, world frame.
  scratch
    .copy(nose)
    .multiplyScalar(usableThrottle(input.throttle))
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

  if (!target) return
  toTarget.subVectors(target.position, state.position)
  const distance = toTarget.length()
  if (distance === 0) return
  toTarget.divideScalar(distance)
  const closing = v.dot(toTarget)
  const limit = approachCap(targetGap, dt)
  if (closing > limit) v.addScaledVector(toTarget, limit - closing)
}

// Push the ship out of any body it ended inside and drop the velocity
// component into it, so it slides along the surface. Bodies in the scene
// never overlap, so one pass leaves the ship outside all of them. Returns
// whether the step hit something faster than COLLISION_SPEED.
function collide(state: ShipState, bodies: readonly Body[]): boolean {
  let hit = false
  for (const body of bodies) {
    const shell = collisionRadius(body)
    const normal = scratch.subVectors(state.position, body.position)
    const d = normal.length()
    if (d >= shell) continue
    if (d > 1e-9) normal.divideScalar(d)
    else normal.copy(WORLD_UP)
    state.position.copy(body.position).addScaledVector(normal, shell)
    const inward = state.velocity.dot(normal)
    if (inward < 0) state.velocity.addScaledVector(normal, -inward)
    if (-inward > COLLISION_SPEED) hit = true
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
  out.throttle = usableThrottle(input.throttle)
  out.flightAssist = input.flightAssist
  out.velocity.copy(state.velocity)
  out.colliding = colliding

  // End-of-step distances, so the HUD matches where the camera now is.
  const { nearest, nearestGap, target, targetGap } = measure(
    state.position,
    env.bodies,
    env.targetKey
  )
  out.nearest.key = nearest ? nearest.key : null
  out.nearest.surfaceDistance = nearestGap

  if (!target) {
    out.target = null
    return
  }
  const closing = state.velocity.dot(
    toTarget.subVectors(target.position, state.position).normalize()
  )
  if (!out.target) out.target = { key: target.key, surfaceDistance: 0, etaSeconds: 0 }
  out.target.key = target.key
  out.target.surfaceDistance = targetGap
  out.target.etaSeconds = closing > 0 ? Math.max(0, targetGap) / closing : Infinity
}

/**
 * Advance the ship by `dt` seconds (clamped to MAX_DT; non-finite or negative
 * dt is a zero step). Mutates and returns `state`; fills `telemetry` when
 * given. Caps are taken at the start of the step, so a step can never carry
 * the ship further than they allow from where it was.
 */
export function stepShip(
  state: ShipState,
  input: Readonly<ShipInput>,
  dt: number,
  env: FlightEnv,
  telemetry?: ShipTelemetry
): ShipState {
  const h = Number.isFinite(dt) ? clamp(dt, 0, MAX_DT) : 0
  const here = measure(state.position, env.bodies, env.targetKey)
  const cap = cruiseCap(here)
  const { target, targetGap } = here
  let colliding = false
  if (h > 0) {
    rotate(state, input, h, speedFraction(state.velocity.length(), cap))
    translate(state, input, h, cap, target, targetGap)
    state.position.addScaledVector(state.velocity, h)
    colliding = collide(state, env.bodies)
  }
  if (telemetry) fillTelemetry(telemetry, state, input, env, cap, colliding)
  return state
}
