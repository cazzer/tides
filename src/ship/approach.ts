// The approach indicator (tides-2hv.12): which body the ship is closing on,
// when it will get there, and whether it is coming in too fast to stop, the
// way Elite's supercruise warns before you overshoot a station. Pure maths
// over the flight model's exports; flight.ts itself is untouched.
//
// Why a prediction. Unlocked, Flight Assist rides the velocity down a
// falling speed cap at no more than WELL_BRAKE, so diving at a light body
// faster than its well can shed carries the ship in over the cap (flight.ts,
// "overshoot"). That is decided at the well's edge, seconds before the HUD's
// speed shows anything wrong, so the HUD needs to know in advance: wouldOvershoot
// flies the same speed-share maths ahead in log gap, and safeShare is the
// throttle at which it starts to.
//
// Why a better ETA. gap / closing sticks at the well time during a locked
// approach, because the gap e-folds; approachEta follows the profile instead.

import * as THREE from 'three'
import {
  BAND_RATE,
  K_WELL,
  OVERSPEED_MAX,
  V_NORMAL,
  V_TOP,
  WELL_BRAKE,
  WELL_EDGE_SPEED,
  bandEdgeGap,
  lawCeiling,
  lawFloor,
  speedFloor,
  velocityTau,
  wellEdgeGap,
  wellFactor,
  wellSpeedOf,
  type Body,
  type GroundSpeedLaw,
} from './flight'
import { IMPACT_MIN_SPEED } from './impact'

/**
 * [TUNE] Unlocked, a body counts as "ahead" within this angle of the
 * velocity, radians (30°); the one already shown keeps its place out to
 * AHEAD_KEEP_CONE so a slow drift doesn't drop it.
 */
export const AHEAD_CONE = (30 * Math.PI) / 180
export const AHEAD_KEEP_CONE = (35 * Math.PI) / 180
/**
 * [TUNE] Another body ahead replaces the shown one only when its gap is this
 * share of the shown one's or less, so two bodies at similar range don't
 * flicker.
 */
export const AHEAD_SWITCH = 0.8
/**
 * Below this share of a body's speed floor (flight.ts speedFloor), it isn't
 * ahead (there is no heading to read) and there is no ETA to it: resting on
 * a surface the ship still creeps in by a hair each step before the
 * collision cancels it, which over a gap of a few hundredths read as hours.
 */
export const AHEAD_MIN_SHARE = 0.05

/**
 * [TUNE] "Too fast" warns this many seconds before the ship reaches the
 * subject's slowdown band (where the cap starts to fall, bandEdgeGap),
 * and all the way in. Earlier, a cruise across the system would warn about
 * every planet on the line.
 */
export const FAST_WINDOW_S = 10

/**
 * Speed over the cap, as a share of it, that reads as overshooting: the
 * share that hits the surface hard (impact.ts IMPACT_MIN_SPEED at the
 * V_NORMAL floor), so a warning means a crash. Full throttle at Earth or
 * Venus peaks at ~1.1× the cap and still lands gently; that is not one.
 * "Too fast" predicts reaching OVER_ON. Neither warns where the floor is too
 * low for any arrival to be a crash (canCrash: Earth's ground on the high
 * tier, tides-01v.8.17).
 */
export const OVER_ON = IMPACT_MIN_SPEED / V_NORMAL
/**
 * Overshooting clears once the speed is back down to about the cap. Just
 * above 1, not under it: Flight Assist settles at throttle · cap, exactly
 * the cap at full throttle, so a threshold under 1 would never clear.
 */
export const OVER_OFF = 1.02
/** "Too fast" clears once the predicted peak is this far under OVER_ON. */
export const FAST_OFF = OVER_ON - 0.1

/**
 * Whether arriving at a body with speed floor `speedFloor` (flight.ts
 * speedFloor) can be a crash. The ship never carries more than
 * OVERSPEED_MAX × the cap, which falls to the floor at the surface, so with
 * a floor under IMPACT_MIN_SPEED / OVERSPEED_MAX (0.125; Earth's ground on
 * the high tier is 0.02) even an unlocked full-throttle dive with Flight
 * Assist off touches down softly: stopping at the ground, not hitting it
 * (tides-01v.8.17). There, over and fast would warn about nothing.
 */
export function canCrash(speedFloor: number): boolean {
  return OVERSPEED_MAX * speedFloor > IMPACT_MIN_SPEED
}

/**
 * A safe-arrival throttle this close to full reads as full: the tick at the
 * end of the bar would only be noise.
 */
export const SAFE_SHARE_FULL = 0.95

/**
 * - over: above the cap now, so the well can't stop the ship (overshooting).
 * - locked: the subject is the locked target, whose approach cap means it
 *   can't be overshot.
 * - fast: on course to be over the cap inside the subject's well.
 * - closing / open: closing on it at a safe speed, or not closing.
 */
export type ApproachStatus = 'over' | 'locked' | 'fast' | 'closing' | 'open'

/** Seconds per e-fold of the gap at the cap, for a wellFactor (flight.ts wellTime). */
function wellTimeOf(factor: number): number {
  return factor / K_WELL
}

// Steps over the well's depth in log gap, its edge (WELL_EDGE_SPEED · T)
// down to V_NORMAL · T (ln 10 ≈ 2.3 e-folds; ~4.8 down to Earth's ground
// speed), and as many over the slowdown band's: enough that halving them
// moves safeShare < 0.01.
const PREDICT_STEPS = 96

// One leg of peakShare's run: the share `s` from log gap `start` down to
// `end`, where the cap is e^x / T (x the log gap, offset in the band so the
// cap there is BAND_RATE · its offset gap), the ride down limited to `brake`.
// Returns the new share and writes the peak to `run.peak`.
function rideLeg(
  run: { s: number; peak: number },
  start: number,
  end: number,
  T: number,
  brake: number,
  throttle: number,
  flightAssist: boolean
): void {
  if (!(start > end)) return
  const dLog = (start - end) / PREDICT_STEPS
  for (let i = 0; i < PREDICT_STEPS && run.s > 0; i++) {
    const cap = Math.exp(start - i * dLog) / T
    const tau = velocityTau(cap)
    let s = run.s
    // Time to fall dLog in log gap: closing / gap = s / T.
    const dt = (dLog * T) / s
    if (flightAssist) {
      s = throttle + (s - throttle) * Math.exp(-dt / tau)
      s *= Math.exp(Math.max(0, s / T - brake) * dt)
    } else {
      const thrust = s + (throttle * dt) / tau
      s = s > 1 ? s : Math.min(1, Math.max(0, thrust))
      s *= Math.exp((s / T - (s > 1 ? brake : 0)) * dt)
    }
    run.s = s
    if (!Number.isFinite(s)) {
      run.peak = Infinity
      return
    }
    run.peak = Math.max(run.peak, s)
  }
}

const peakRun = { s: 0, peak: 0 }

/**
 * The highest speed share (speed / cap) the ship reaches on a straight run
 * into a body with wellFactor `factor`, from `gap` with speed share `share`
 * of the body's cap there, holding `throttle` with Flight Assist on or off
 * and no target locked. Mirrors flight.ts per unit of log gap:
 * - FA on, the velocity eases toward throttle · cap over velocityTau, and the
 *   ride scales it down at most e^(−WELL_BRAKE·dt) while the cap falls at
 *   closing / gap = share / T, so the share grows by share / T − WELL_BRAKE
 *   when that is positive;
 * - FA off, thrust adds throttle · cap / τ up to the cap, nothing rides, and
 *   speed over the cap bleeds at WELL_BRAKE.
 * Through the slowdown band (tides-h6a) the same, in the log of the gap's
 * offset from the band's zero (where its cap would reach 0) with T = 1 /
 * BAND_RATE and BAND_RATE for WELL_BRAKE: the share grows only when over 1.
 * The run ends at the body's speed `floor` (flight.ts speedFloor), where the
 * cap stops falling.
 */
export function peakShare(
  factor: number,
  gap: number,
  share: number,
  throttle: number,
  flightAssist = true,
  speedFloor = V_NORMAL
): number {
  const T = wellTimeOf(factor)
  const edge = wellEdgeGap(T)
  // The band's cap is BAND_RATE · (gap − zero).
  const zero = edge - WELL_EDGE_SPEED / BAND_RATE
  const g = Math.min(Math.max(gap, 1e-9), bandEdgeGap(T))
  peakRun.s = Math.max(0, share)
  peakRun.peak = peakRun.s
  if (g > edge) {
    rideLeg(peakRun, Math.log(g - zero), Math.log(edge - zero), 1 / BAND_RATE, BAND_RATE, throttle, flightAssist)
  }
  rideLeg(peakRun, Math.log(Math.min(g, edge)), Math.log(speedFloor * T), T, WELL_BRAKE, throttle, flightAssist)
  return peakRun.peak
}

// By wellFactor, then speed floor.
const safeShares = new Map<number, Map<number, number>>()

/**
 * The safe-arrival throttle for a body of wellFactor `factor` and speed
 * floor `speedFloor`: the highest Flight Assist throttle that rides its well
 * down without overshooting (peakShare ≤ OVER_ON) from its edge; 1 from
 * SAFE_SHARE_FULL up. Above it, unlocked, the ship overshoots. ~0.72 at the
 * Moon, ~0.85 at Mercury, ~0.92 at Mars, 1 for Venus, Earth and heavier,
 * and 1 where no arrival can crash (canCrash). The HUD's throttle bar
 * marks it.
 */
export function safeShare(factor: number, speedFloor = V_NORMAL): number {
  if (!canCrash(speedFloor)) return 1
  let byFloor = safeShares.get(factor)
  if (!byFloor) safeShares.set(factor, (byFloor = new Map()))
  const known = byFloor.get(speedFloor)
  if (known !== undefined) return known
  const edge = bandEdgeGap(wellTimeOf(factor))
  const over = (throttle: number) =>
    peakShare(factor, edge, throttle, throttle, true, speedFloor) > OVER_ON
  let result = 1
  if (over(1)) {
    let lo = 0
    let hi = 1
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2
      if (over(mid)) hi = mid
      else lo = mid
    }
    result = lo >= SAFE_SHARE_FULL ? 1 : lo
  }
  byFloor.set(speedFloor, result)
  return result
}

// approachEta's legs over a ground law. Seconds to close from gap `hi` down
// to `lo` at min(closing, share · cap),
// where the cap is k · gap (k > 0) or the constant c: holding `closing`
// while the cap allows it, then e-folding the gap every 1 / (share · k).
function leg(lo: number, hi: number, closing: number, share: number, k: number, c: number): number {
  if (!(hi > lo)) return 0
  if (k > 0) {
    const knee = closing / (share * k)
    let t = 0
    if (hi > knee) t += (hi - Math.max(lo, knee)) / closing
    const top = Math.min(hi, knee)
    if (top > lo) t += Math.log(top / lo) / (share * k)
    return t
  }
  return (hi - lo) / Math.min(closing, share * c)
}

/** A groundSpeed law (flight.ts speedFloorAt) and the gap the ship stops at over that ground. */
export interface EtaGround {
  law: Readonly<GroundSpeedLaw>
  stop: number
  /** The ground's height over the body's sphere there, for a law with air; 0 when missing. */
  base?: number
  /** The boost spool the ship flies with (flight.ts ShipState.boost); 0 when missing. */
  boost?: number
}

// updateApproach's, reused so a frame allocates nothing.
const etaGround: EtaGround = { law: { rate: 0, min: 0, max: 0 }, stop: 0, base: 0, boost: 0 }

/**
 * Predicted seconds to reach the surface `gap` away, closing at `closing`,
 * for a body whose gap e-folds every `wellTime` s at the cap inside its well
 * (and whose slowdown band is a leg of its own above that, tides-h6a: the
 * gap's offset from the band's zero e-folding every 1 / BAND_RATE), with speed
 * `share` of the cap (the throttle, in steady Flight Assist flight). The
 * ship holds its closing speed until share · gap / wellTime (the cap
 * there) falls below it, then the gap e-folds every wellTime / share down to
 * the body's speed floor (gap speedFloor · wellTime), which it crosses at
 * share · speedFloor. Infinity when not closing (under AHEAD_MIN_SHARE of
 * the floor).
 *
 * With `ground` (a body whose floor follows its gap, tides-zmw.9.18) the
 * floor has regimes of its own under the well: the plateau (law.max, down
 * to gap max / rate), then the gap e-folding every 1 / (rate · share), then
 * law.min, to the stop. A law with air (tides-zmw.9.29) is summed instead
 * (airEta), its altitude the gap over the ground's `base`, its air boosted
 * by the ground's `boost` spool (tides-zmw.25) with the boosted guard on
 * the held ground (tides-5lj) read over flat ground, as flight.ts flies it.
 */
export function approachEta(
  gap: number,
  closing: number,
  wellTime: number,
  share = 1,
  speedFloor = V_NORMAL,
  ground?: EtaGround
): number {
  if (!(closing >= AHEAD_MIN_SHARE * speedFloor) || !(wellTime > 0)) return Infinity
  const g = Math.max(0, gap)
  const s = THREE.MathUtils.clamp(share, 1e-3, 1)
  // A law with air sums the whole run, the band too (its cap is wellSpeedOf).
  if (ground?.law.air) {
    const { law } = ground
    return airEta(g, Math.max(0, ground.stop), closing, wellTime, s, law, ground.base ?? 0, ground.boost ?? 0)
  }
  const edge = wellEdgeGap(wellTime)
  const zero = edge - WELL_EDGE_SPEED / BAND_RATE
  const band = g > edge ? leg(edge - zero, g - zero, closing, s, BAND_RATE, 0) : 0
  return band + innerEta(Math.min(g, edge), closing, wellTime, s, speedFloor, ground)
}

// approachEta inside the well's edge.
function innerEta(
  g: number,
  closing: number,
  wellTime: number,
  s: number,
  speedFloor: number,
  ground: EtaGround | undefined
): number {
  if (!ground) {
    const floorGap = speedFloor * wellTime
    const holdGap = Math.max(floorGap, (closing * wellTime) / s)
    let eta = 0
    if (g > holdGap) eta += (g - holdGap) / closing
    const mid = Math.min(g, holdGap)
    if (mid > floorGap) eta += (wellTime / s) * Math.log(mid / floorGap)
    eta += Math.min(g, floorGap) / Math.min(closing, s * speedFloor)
    return eta
  }
  const { law } = ground
  const stop = Math.max(0, ground.stop)
  const at = (x: number) => Math.min(g, x)
  const slowest = Math.max(stop, law.min / law.rate)
  const plateau = Math.max(slowest, law.max / law.rate)
  const well = Math.max(plateau, law.max * wellTime)
  return (
    leg(at(well), g, closing, s, 1 / wellTime, 0) +
    leg(at(plateau), at(well), closing, s, 0, law.max) +
    leg(at(slowest), at(plateau), closing, s, law.rate, 0) +
    leg(at(stop), at(slowest), closing, s, 0, law.min)
  )
}

// approachEta's steps over a law with air, in log gap: ln(gap / stop) runs
// to ~15 from the Moon's distance, so each step is under a quarter e-fold.
const AIR_ETA_STEPS = 64

// approachEta over a ground law with air (tides-zmw.9.29): seconds from
// `gap` to `stop` at min(closing, share · cap), the cap as flight.ts
// wellCap has it (the well's gap / wellTime under the law's ceiling, over
// its floor), straight down onto ground `base` over the sea (altitude =
// gap + base), not climbing. Boosted, flight.ts's guard reads the clearance
// over the held ground (tides-5lj), which over flat ground straight down is
// the gap, so the ETA reads its hold as the gap too and agrees with the
// flight. The air's leg has no closed form worth its kinks against the gap
// law's, so this sums it in log gap, each step at the cap at its geometric
// middle.
function airEta(
  gap: number,
  stop: number,
  closing: number,
  wellTime: number,
  share: number,
  law: Readonly<GroundSpeedLaw>,
  base: number,
  boost: number
): number {
  if (!(gap > stop)) return 0
  const lo = Math.max(stop, 1e-12)
  const step = Math.log(gap / lo) / AIR_ETA_STEPS
  let eta = 0
  let x0 = lo
  for (let i = 1; i <= AIR_ETA_STEPS; i++) {
    const x1 = i === AIR_ETA_STEPS ? gap : lo * Math.exp(i * step)
    const x = Math.sqrt(x0 * x1)
    const cap = Math.max(
      Math.min(wellSpeedOf(x, wellTime), lawCeiling(law, x, x + base, 0, boost, x)),
      lawFloor(law, x, x + base, 0, boost, x)
    )
    eta += (x1 - x0) / Math.min(closing, share * cap)
    x0 = x1
  }
  return eta
}

export interface ApproachInput {
  /** |velocity| and the cap where the ship is (shipTelemetry). */
  speed: number
  cap: number
  /** Speed toward the subject's centre, units/s; ≤ 0 when not closing. */
  closing: number
  /** To the subject's surface, scene units. */
  gap: number
  /** The subject's wellFactor and speed floor (flight.ts speedFloor). */
  factor: number
  speedFloor?: number
  /**
   * The speed floor of the body whose well sets `cap` (telemetry.well),
   * which need not be the subject: whether over the cap can end in a crash.
   */
  capFloor?: number
  locked: boolean
  throttle: number
  flightAssist: boolean
}

/**
 * The subject's approach state, in priority order (see ApproachStatus).
 * `previous` gives over and fast their hysteresis. Never over where the
 * well setting the cap can't be hit hard, nor fast where the subject can't
 * (canCrash): over measures against that well's cap, fast against the
 * subject's. Skimming Earth's ground after a dive with Flight Assist off,
 * still over its cap, is not overshooting whatever lies ahead.
 */
export function approachStatus(a: ApproachInput, previous: ApproachStatus | null): ApproachStatus {
  const floor = a.speedFloor ?? V_NORMAL
  const ratio = a.speed / Math.max(a.cap, 1e-9)
  if (canCrash(a.capFloor ?? V_NORMAL) && ratio > (previous === 'over' ? OVER_OFF : OVER_ON)) {
    return 'over'
  }
  if (a.locked) return 'locked'
  if (!(a.closing > 0)) return 'open'
  if (!canCrash(floor)) return 'closing'
  const T = wellTimeOf(a.factor)
  if ((a.gap - bandEdgeGap(T)) / a.closing > FAST_WINDOW_S) return 'closing'
  // As a share of the subject's own cap where the ship is; the run starts
  // at the band's edge if it is still outside.
  const subjectCap = THREE.MathUtils.clamp(wellSpeedOf(a.gap, T), floor, V_TOP)
  const peak = peakShare(a.factor, a.gap, a.closing / subjectCap, a.throttle, a.flightAssist, floor)
  return peak > (previous === 'fast' ? FAST_OFF : OVER_ON) ? 'fast' : 'closing'
}

/** What ShipTargeting hands the HUD each frame. */
export interface ShipApproach {
  /** The subject: the locked target, or the body ahead; null for none. */
  key: string | null
  locked: boolean
  /** True range to the subject, km (ship-distances.ts); NaN until measured. */
  km: number
  /** Predicted seconds to arrive (approachEta); Infinity when not closing. */
  eta: number
  status: ApproachStatus
  /** The subject's safe-arrival throttle (safeShare); 1 for none. */
  safeShare: number
}

export const shipApproach: ShipApproach = {
  key: null,
  locked: false,
  km: NaN,
  eta: Infinity,
  status: 'open',
  safeShare: 1,
}

export function resetShipApproach(): void {
  shipApproach.key = null
  shipApproach.locked = false
  shipApproach.km = NaN
  shipApproach.eta = Infinity
  shipApproach.status = 'open'
  shipApproach.safeShare = 1
}

const toBody = new THREE.Vector3()
const fromBody = new THREE.Vector3()

function gapTo(body: Body, position: THREE.Vector3): number {
  return position.distanceTo(body.position) - body.radius
}

/**
 * Index of the approach subject in `bodies`, or −1: the locked target when it
 * is among them, else the body ahead. Ahead is within AHEAD_CONE of the
 * velocity, by smallest surface gap: the body the ship reaches first. Not
 * by well distance: diving at the Moon from beyond it, Earth's heavier well
 * is the "nearer" one, but the Moon is what fills the view and gets hit.
 * `current` keeps its place out to AHEAD_KEEP_CONE until another is
 * AHEAD_SWITCH nearer.
 */
export function approachSubject(
  bodies: readonly Body[],
  position: THREE.Vector3,
  velocity: THREE.Vector3,
  targetKey: string | null,
  current: string | null
): number {
  if (targetKey != null) {
    const index = bodies.findIndex((b) => b.key === targetKey)
    if (index >= 0) return index
  }
  const speed = velocity.length()
  const cosCone = Math.cos(AHEAD_CONE)
  const cosKeep = Math.cos(AHEAD_KEEP_CONE)
  let best = -1
  let bestScore = Infinity
  let kept = -1
  let keptScore = Infinity
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i]
    const distance = toBody.subVectors(body.position, position).length()
    if (!(distance > 0) || !(speed > AHEAD_MIN_SHARE * speedFloor(body))) continue
    const cos = toBody.dot(velocity) / (distance * speed)
    const score = Math.max(0, gapTo(body, position))
    if (body.key === current && cos >= cosKeep) {
      kept = i
      keptScore = score
    }
    if (cos >= cosCone && score < bestScore) {
      best = i
      bestScore = score
    }
  }
  if (kept >= 0 && !(bestScore < AHEAD_SWITCH * keptScore)) return kept
  return best
}

export interface ApproachFrame {
  bodies: readonly Body[]
  position: THREE.Vector3
  velocity: THREE.Vector3
  speed: number
  cap: number
  /** The speed floor of the well setting `cap` (telemetry.well.floor). */
  capFloor: number
  throttle: number
  flightAssist: boolean
  /** The boost spool (telemetry.boost), for the ETA. */
  boost: number
  targetKey: string | null
  /** True range per body, km, in `bodies` order (ship-distances.ts). */
  km: ArrayLike<number>
}

/** Fill `out` (shipApproach) for this frame. Allocates nothing. */
export function updateApproach(frame: ApproachFrame, out: ShipApproach = shipApproach): void {
  const index = approachSubject(
    frame.bodies,
    frame.position,
    frame.velocity,
    frame.targetKey,
    out.key
  )
  if (index < 0) {
    resetShipApproach()
    return
  }
  const body = frame.bodies[index]
  const previous = out.key === body.key ? out.status : null
  const distance = toBody.subVectors(body.position, frame.position).length()
  const closing = distance > 0 ? frame.velocity.dot(toBody) / distance : 0
  // From the ground under the ship where the body has one, as the cap.
  const gap = body.ground && distance > 0
    ? distance - body.ground(fromBody.copy(toBody).divideScalar(-distance))
    : distance - body.radius
  const factor = wellFactor(body.mass)
  const floor = speedFloor(body)
  const locked = body.key === frame.targetKey
  out.key = body.key
  out.locked = locked
  out.km = frame.km[index]
  out.safeShare = safeShare(factor, floor)
  out.status = approachStatus(
    {
      speed: frame.speed,
      cap: frame.cap,
      closing,
      gap,
      factor,
      speedFloor: floor,
      capFloor: frame.capFloor,
      locked,
      throttle: frame.throttle,
      flightAssist: frame.flightAssist,
    },
    previous
  )
  // With Flight Assist on the speed settles at throttle · cap however the
  // cap moves (flight.ts rideWell), so the throttle is the steady share; the
  // measured one dips for a frame each time the cap starts to fall.
  const share = frame.flightAssist
    ? frame.throttle
    : frame.speed / Math.max(frame.cap, 1e-9)
  let ground: EtaGround | undefined
  if (body.groundSpeed) {
    etaGround.law = body.groundSpeed
    etaGround.stop = body.groundClearance ?? 0
    etaGround.base = distance - body.radius - gap
    etaGround.boost = frame.boost
    ground = etaGround
  }
  out.eta = approachEta(gap, closing, wellTimeOf(factor), share, floor, ground)
}
