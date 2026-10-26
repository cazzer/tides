// Earth carries the ship (tides-zmw.9.18, behind ?surface=1). Without this
// the ship flies in the heliocentric frame, so a ship hovering 30 m over the
// Grand Canyon watches the ground slide by at Earth's orbital speed (~430 m/s
// at the flight scale) plus its spin (up to 465 m/s).
//
// Framed as gravity and air drag, not as a fade with altitude (the user's
// decision, 2026-10-25):
//
//   • Orbit: inside Earth's sphere of influence (full out to EARTH_SOI[0],
//     none past EARTH_SOI[1]; that takes in the Moon's whole orbit) the ship
//     moves with Earth, frame by frame, by exactly the distance Earth moved.
//     Near the Moon (MOON_SOI) it moves with the Moon instead, patched-conic
//     style. Only the position is carried, never integrated, so a hover is
//     exact at any time scale and the edges are smooth: no jump on the way
//     out, the heliocentric velocity changing by Earth's own across the band.
//   • Spin: the ship carries `kappa` of Earth's spin, rotating its offset
//     from Earth's centre, its velocity and its orientation by that share of
//     the turn Earth's frame made this frame (slerp of the frame's own
//     delta: at kappa = 1 the ground under the ship doesn't move at all).
//     kappa is the air's grip. It relaxes toward λd / (λd + λr) each frame:
//     λd, drag, is the air's density times how fast the ship moves through
//     the air, so a descent is caught somewhere around 45-25 km, sooner the
//     faster it comes in ("the air catching the ship"); λr lets go above the
//     air (RELEASE_BAND_KM), where Flight Assist holds station on the stars
//     instead and a hovering ship sees Earth turn beneath it.
//
// Both keep state.velocity, the velocity relative to the carried frame,
// fixed: Flight Assist, the caps and the closing speeds all work in that
// frame, which is the air at kappa = 1 and Earth-centred inertial at 0.
// There is no Newtonian falling or orbiting: the wells stay as they are.
//
// telemetry.air (fillAir) is the ship through the air: its speed, the grip,
// the density and the dynamic pressure, the hook for entry visuals.

import * as THREE from 'three'
import { MAX_DT, type ShipState } from './flight'
import type { ShipTelemetry } from './ship-telemetry'
import { smoothstep } from './dust'
import { EARTH_KM_PER_UNIT } from '../terrain-scale'

/** Earth's sphere of influence, scene units from its centre: carried fully inside the first, not at all past the second. [TUNE] */
export const EARTH_SOI: readonly [number, number] = [14, 20]
/** The Moon's, from its centre: its Hill radius at the scene scale, out to 2.5. [TUNE] */
export const MOON_SOI: readonly [number, number] = [1.6, 2.5]
/** Scale height of the air, km: density e-folds every this much altitude. */
export const SCALE_HEIGHT_KM = 8.5
/** Seconds per e-fold of the grip at sea level, still in the air. [TUNE] */
export const DRAG_TAU = 0.1
/** Air speed, m/s, that doubles the drag rate over standing still. [TUNE] */
export const DRAG_SPEED = 100
/** The release rate above the air, 1/s. [TUNE] */
export const RELEASE_RATE = 0.5
/** Altitudes, km, over which the release takes over from the air. [TUNE] */
export const RELEASE_BAND_KM: readonly [number, number] = [70, 100]
/** Earth's spin, rad per sim second: one turn a sidereal day. */
export const SIDEREAL_RATE = (2 * Math.PI) / 86164.0905
/** Sea-level air density, kg/m³, for the dynamic pressure. */
export const SEA_LEVEL_DENSITY = 1.225

/** Below this the density stops growing (the ship can't be far under the sea). */
const LOWEST_KM = -1
const METRES_PER_UNIT = EARTH_KM_PER_UNIT * 1000

/** A body the ship rides with: Earth (with its local → world spin) or the Moon. */
export interface Carrier {
  position: THREE.Vector3
  radius: number
  /** Local → world; Earth's (ship-bodies.ts ShipBody.spin). */
  spin?: THREE.Quaternion
}

export interface FrameCarry {
  /** The share of Earth's spin the ship carries, 0..1. */
  kappa: number
  /** The running sum of every frame's carry, scene units: what the world-fixed dust subtracts. */
  carried: THREE.Vector3
  /** This frame's carry displacement. */
  last: THREE.Vector3
  /** This frame's weights: Earth's sphere, the Moon's. */
  weightEarth: number
  weightMoon: number
  // Where the carriers were at the last carry; primed once taken.
  primed: boolean
  earthAt: THREE.Vector3
  spinAt: THREE.Quaternion
  moonAt: THREE.Vector3
  moonPrimed: boolean
}

export function createFrameCarry(): FrameCarry {
  return {
    kappa: 0,
    carried: new THREE.Vector3(),
    last: new THREE.Vector3(),
    weightEarth: 0,
    weightMoon: 0,
    primed: false,
    earthAt: new THREE.Vector3(),
    spinAt: new THREE.Quaternion(),
    moonAt: new THREE.Vector3(),
    moonPrimed: false,
  }
}

/** Starts `carry` over: the next carry takes the carriers where they are and moves nothing. */
export function resetFrameCarry(carry: FrameCarry): FrameCarry {
  carry.kappa = 0
  carry.carried.set(0, 0, 0)
  carry.last.set(0, 0, 0)
  carry.weightEarth = 0
  carry.weightMoon = 0
  carry.primed = false
  carry.moonPrimed = false
  return carry
}

/** ShipController's carry, which SpaceDust reads (`carried`). */
export const shipCarry: FrameCarry = createFrameCarry()

/** Earth's spin rate, rad per real second, at `timeScale` sim seconds per second. */
export function earthSpinRate(timeScale: number): number {
  return Number.isFinite(timeScale) ? SIDEREAL_RATE * timeScale : 0
}

/** Altitude over the sea, km, `distance` scene units from the centre of a body of `radius`. */
export function altitudeKm(distance: number, radius: number): number {
  return (distance - radius) * EARTH_KM_PER_UNIT
}

/** Air density over sea level's, at `km` up. */
export function airDensity(km: number): number {
  return Number.isFinite(km) ? Math.exp(-Math.max(km, LOWEST_KM) / SCALE_HEIGHT_KM) : 0
}

/** How far the release has taken over at `km` up: 0 in the air, 1 above it. */
export function releaseShare(km: number): number {
  return smoothstep(RELEASE_BAND_KM[0], RELEASE_BAND_KM[1], km)
}

/** The drag rate, 1/s, at `km` up moving `airSpeed` m/s through the air. */
export function dragRate(km: number, airSpeed: number): number {
  const speed = Number.isFinite(airSpeed) ? Math.max(0, airSpeed) : 0
  return (airDensity(km) * (1 + speed / DRAG_SPEED)) / DRAG_TAU
}

/** The release rate, 1/s, at `km` up. */
export function releaseRate(km: number): number {
  return RELEASE_RATE * releaseShare(km)
}

/** The grip the air settles to: λd / (λd + λr); NaN when neither acts. */
export function equilibriumKappa(drag: number, release: number): number {
  return drag / (drag + release)
}

/**
 * `kappa` after `h` seconds of relaxing toward equilibriumKappa at rate
 * λd + λr: exact, so stable for any h. Unchanged where neither acts.
 */
export function relaxKappa(kappa: number, drag: number, release: number, h: number): number {
  const rate = drag + release
  if (!(rate > 0) || !(h > 0)) return kappa
  const eq = drag / rate
  return THREE.MathUtils.clamp(eq + (kappa - eq) * Math.exp(-rate * h), 0, 1)
}

const offset = new THREE.Vector3()
const omega = new THREE.Vector3()
const slip = new THREE.Vector3()
const air = new THREE.Vector3()
const before = new THREE.Vector3()
const move = new THREE.Vector3()
const earthMove = new THREE.Vector3()
const moonMove = new THREE.Vector3()
const turn = new THREE.Quaternion()
const share = new THREE.Quaternion()
const IDENTITY = new THREE.Quaternion()
const AXIS = new THREE.Vector3(0, 1, 0)

/**
 * Into `out`: the ship's velocity through Earth's air, scene units/s:
 * its frame velocity less the air's own motion in that frame,
 * (1 − kappa) of the spin's ω × r, which thins out above the air.
 */
export function airVelocity(
  out: THREE.Vector3,
  state: ShipState,
  earth: Carrier,
  kappa: number,
  spinRate: number
): THREE.Vector3 {
  return airVelocityAbout(out, state, earth.position, earth.radius, earth.spin, kappa, spinRate)
}

// airVelocity about Earth's centre `centre` and spin `spin` (the carry's
// last ones, which the ship's position is still relative to).
function airVelocityAbout(
  out: THREE.Vector3,
  state: ShipState,
  centre: THREE.Vector3,
  radius: number,
  spin: THREE.Quaternion | undefined,
  kappa: number,
  spinRate: number
): THREE.Vector3 {
  out.copy(state.velocity)
  if (!spin || !(spinRate !== 0)) return out
  offset.subVectors(state.position, centre)
  const km = altitudeKm(offset.length(), radius)
  const thin = 1 - releaseShare(km)
  if (!(thin > 0)) return out
  omega.copy(AXIS).applyQuaternion(spin).multiplyScalar(spinRate)
  slip.crossVectors(omega, offset).multiplyScalar(thin * (1 - kappa))
  return Number.isFinite(slip.x + slip.y + slip.z) ? out.sub(slip) : out
}

function remember(carry: FrameCarry, earth: Carrier, moon: Carrier | null): void {
  carry.earthAt.copy(earth.position)
  if (earth.spin) carry.spinAt.copy(earth.spin)
  carry.moonPrimed = moon != null
  if (moon) carry.moonAt.copy(moon.position)
  carry.primed = true
}

/**
 * Carries `state` with Earth (and the Moon) over the frame since the last
 * call: call it once per frame after the bodies have moved to this frame's
 * time and before stepShip. `dt` (real seconds, clamped to MAX_DT as the
 * step is) relaxes the grip; `spinRate` is earthSpinRate. The first call
 * only takes the carriers where they are and sets the grip to where the air
 * would hold it.
 */
export function carryShip(
  carry: FrameCarry,
  state: ShipState,
  earth: Carrier,
  moon: Carrier | null,
  dt: number,
  spinRate: number
): void {
  const h = Number.isFinite(dt) ? THREE.MathUtils.clamp(dt, 0, MAX_DT) : 0
  carry.last.set(0, 0, 0)
  const centre = carry.primed ? carry.earthAt : earth.position
  const spin = carry.primed && earth.spin ? carry.spinAt : earth.spin
  const distance = state.position.distanceTo(centre)
  const km = altitudeKm(distance, earth.radius)
  const speed = airVelocityAbout(air, state, centre, earth.radius, spin, carry.kappa, spinRate).length() * METRES_PER_UNIT
  const drag = dragRate(km, speed)
  const release = releaseRate(km)
  if (!carry.primed) {
    const eq = equilibriumKappa(drag, release)
    carry.kappa = Number.isFinite(eq) ? THREE.MathUtils.clamp(eq, 0, 1) : 0
    remember(carry, earth, moon)
    return
  }
  carry.kappa = relaxKappa(carry.kappa, drag, release, h)
  before.copy(state.position)

  // The orbit: Earth's whole move inside its sphere, the Moon's inside its own.
  const weightEarth = Number.isFinite(distance) ? 1 - smoothstep(EARTH_SOI[0], EARTH_SOI[1], distance) : 0
  earthMove.subVectors(earth.position, carry.earthAt)
  move.copy(earthMove).multiplyScalar(weightEarth)
  let weightMoon = 0
  if (moon && carry.moonPrimed) {
    const fromMoon = state.position.distanceTo(carry.moonAt)
    weightMoon = Number.isFinite(fromMoon) ? 1 - smoothstep(MOON_SOI[0], MOON_SOI[1], fromMoon) : 0
    if (weightMoon > 0) {
      // (ΔM − ΔE) · wM on top of ΔE · wE: ΔM where both are whole.
      moonMove.subVectors(moon.position, carry.moonAt).sub(earthMove)
      move.addScaledVector(moonMove, weightMoon)
    }
  }
  if (Number.isFinite(move.x + move.y + move.z)) state.position.add(move)

  // The spin: kappa of the turn Earth's frame made, about its centre now.
  const grip = carry.kappa * weightEarth
  if (earth.spin && grip > 0) {
    turn.copy(carry.spinAt).invert().premultiply(earth.spin)
    share.slerpQuaternions(IDENTITY, turn, grip)
    offset.subVectors(state.position, earth.position).applyQuaternion(share)
    if (Number.isFinite(offset.x + offset.y + offset.z)) {
      state.position.copy(earth.position).add(offset)
      state.velocity.applyQuaternion(share)
      state.orientation.premultiply(share).normalize()
    }
  }

  carry.weightEarth = weightEarth
  carry.weightMoon = weightMoon
  carry.last.subVectors(state.position, before)
  carry.carried.add(carry.last)
  remember(carry, earth, moon)
}

/**
 * Fills telemetry.air after stepShip: the speed through the air (the HUD's
 * speed), the grip, the density over sea level's and the dynamic pressure,
 * Pa. stepShip's fillTelemetry leaves them as the frame speed and zeros.
 */
export function fillAir(
  carry: FrameCarry,
  telemetry: ShipTelemetry,
  state: ShipState,
  earth: Carrier,
  spinRate: number
): void {
  const speed = airVelocity(air, state, earth, carry.kappa, spinRate).length()
  const km = altitudeKm(state.position.distanceTo(earth.position), earth.radius)
  const density = airDensity(km)
  const metresPerSecond = speed * METRES_PER_UNIT
  telemetry.air.speed = speed
  telemetry.air.coupling = carry.kappa
  telemetry.air.density = density
  telemetry.air.dynamicPressure = 0.5 * SEA_LEVEL_DENSITY * density * metresPerSecond * metresPerSecond
}
