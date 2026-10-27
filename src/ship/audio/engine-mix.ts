// What the ship sounds like for its state (tides-a4j.2): the pure maps from
// telemetry and input to the voices' parameter targets, which ship-voices.ts
// eases the Web Audio graph toward. No Web Audio here, so all of it is
// testable in node.
//
// The engine follows the throttle and the speed's share of the cap, never
// the absolute speed: scene speeds span from walking pace by the ground to
// many times light's between planets, and a drone that tracked them would
// either never move or always scream. The wind follows the log of the
// dynamic pressure (telemetry.air), which is 0 in space.

import { clamp01, speedFraction } from '../dust'

/** [TUNE] The throttle's share of the engine's drive; the rest is speed over cap. */
export const ENGINE_THROTTLE_SHARE = 0.6
/** [TUNE] The engine's fundamental at idle and full drive, Hz. */
export const ENGINE_HZ: readonly [number, number] = [42, 96]
/** [TUNE] The two oscillators' detune either way, cents: a slow beat, not a chord. */
export const ENGINE_DETUNE_CENTS = 7
/** [TUNE] The oscillators' level at idle and full drive. */
export const ENGINE_GAIN: readonly [number, number] = [0.035, 0.09]
/** [TUNE] The engine's lowpass at idle and full drive, Hz: it opens up as it works. */
export const ENGINE_CUTOFF: readonly [number, number] = [220, 900]
/** [TUNE] The engine's brown-noise rumble at idle and full drive. */
export const ENGINE_NOISE_GAIN: readonly [number, number] = [0.02, 0.05]

/** [TUNE] The thrusters' hiss at full demand, and its band. */
export const THRUST_GAIN = 0.06
export const THRUST_HZ = 900
export const THRUST_Q = 1.2
/** [TUNE] How much strafing and changing the throttle (per second) each call for. */
const THRUST_STRAFE_SHARE = 0.7
const THRUST_THROTTLE_RATE_SHARE = 0.5

/** [TUNE] The boost's roar at full spool, and its band's centre at no and full spool, Hz. */
export const BOOST_GAIN = 0.1
export const BOOST_HZ: readonly [number, number] = [180, 1800]
export const BOOST_Q = 1
/**
 * [TUNE] The roar's share where the boost raises nothing (space, the Moon,
 * high up): it still spools, so it still sounds, but plainly less.
 */
export const BOOST_IDLE_SHARE = 0.35

/** [TUNE] No wind at or under this dynamic pressure, Pa; full at Q_FULL. */
export const WIND_Q_MIN = 20
export const WIND_Q_FULL = 100_000
/** [TUNE] The wind's level at full, and its band's centre at none and full, Hz. */
export const WIND_GAIN = 0.1
export const WIND_HZ: readonly [number, number] = [250, 1400]
export const WIND_Q = 0.8

/** [TUNE] Time constants of the eases toward the targets, seconds. */
export const ENGINE_TAU = 0.12
export const THRUST_RISE_TAU = 0.05
export const THRUST_FALL_TAU = 0.25
export const BOOST_TAU = 0.08
export const WIND_TAU = 0.3

/** [TUNE] The voices' submix into the master bus: their loudest sum stays near 0.35. */
export const VOICES_GAIN = 0.7

const lerp = ([a, b]: readonly [number, number], t: number) => a + (b - a) * t

/**
 * How hard the engine works, 0..1: the throttle's magnitude (reverse works
 * it too) and the speed's share of its cap. Idle (0) for a cap of 0 or NaN.
 */
export function engineDrive(throttle: number, speed: number, speedCap: number): number {
  const share = Number.isFinite(speedCap) ? speedFraction(speed, speedCap) : 0
  const drive = ENGINE_THROTTLE_SHARE * Math.abs(throttle) + (1 - ENGINE_THROTTLE_SHARE) * share
  return Number.isFinite(drive) ? clamp01(drive) : 0
}

export interface EngineParams {
  hz: number
  gain: number
  cutoff: number
  noiseGain: number
}

/** Fills `out` with the engine's targets for `drive` (engineDrive). */
export function engineParams(drive: number, out: EngineParams): EngineParams {
  out.hz = lerp(ENGINE_HZ, drive)
  out.gain = lerp(ENGINE_GAIN, drive)
  out.cutoff = lerp(ENGINE_CUTOFF, drive)
  out.noiseGain = lerp(ENGINE_NOISE_GAIN, drive)
  return out
}

/**
 * The thrusters' demand, 0..1: the strafe stick's deflection and how fast
 * the throttle is moving, per second. From the pilot's demand, not the
 * measured acceleration, so it answers the hand at once.
 */
export function thrustLevel(strafeX: number, strafeY: number, throttleRate: number): number {
  const level =
    THRUST_STRAFE_SHARE * Math.hypot(strafeX, strafeY) + THRUST_THROTTLE_RATE_SHARE * Math.abs(throttleRate)
  return Number.isFinite(level) ? clamp01(level) : 0
}

export interface BoostParams {
  gain: number
  hz: number
}

/**
 * Fills `out` with the roar's targets for the boost's spool (0..1): its band
 * sweeps up exponentially, so the sweep sounds even. Plainly quieter where
 * the boost raises nothing (telemetry.boosted false).
 */
export function boostParams(spool: number, boosted: boolean, out: BoostParams): BoostParams {
  const s = clamp01(spool) || 0
  out.gain = s * BOOST_GAIN * (boosted ? 1 : BOOST_IDLE_SHARE)
  out.hz = BOOST_HZ[0] * (BOOST_HZ[1] / BOOST_HZ[0]) ** s
  return out
}

/**
 * The wind's level, 0..1, from the dynamic pressure, Pa, on a log scale:
 * exactly 0 at or under WIND_Q_MIN (space, a hover) and for a non-finite
 * one; ~0.83 at sea level at the air's floor (200 m/s, 24.5 kPa).
 */
export function windLevel(dynamicPressure: number): number {
  if (!Number.isFinite(dynamicPressure) || dynamicPressure <= WIND_Q_MIN) return 0
  return clamp01(Math.log(dynamicPressure / WIND_Q_MIN) / Math.log(WIND_Q_FULL / WIND_Q_MIN))
}

export interface WindParams {
  gain: number
  hz: number
}

/** Fills `out` with the wind's targets for `level` (windLevel). */
export function windParams(level: number, out: WindParams): WindParams {
  out.gain = level * level * WIND_GAIN
  out.hz = lerp(WIND_HZ, level)
  return out
}
