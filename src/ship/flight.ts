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
//   • Speed cap v_max = clamp(K_WELL · d_eff, floor, V_TOP), Elite's
//     supercruise governed by gravity wells (tides-2hv.7). d_eff is the
//     smallest gap to a surface divided by that body's wellFactor, which
//     grows slowly with mass, so the Sun and Jupiter slow the ship from
//     further out than Mercury does. Inside a well the gap e-folds every
//     wellTime = wellFactor / K_WELL seconds at the cap; in open space the
//     cap tops out at V_TOP, which is what makes Neptune minutes away rather
//     than seconds. One continuous regime, no mode switch. The floor is
//     V_NORMAL, or the minSpeed of the body setting d_eff (speedFloor): a
//     body the ship can fly down to its ground (Earth) keeps its well
//     slowing the ship below V_NORMAL all the way down. Over the streamed
//     tiles Earth's floor follows the gap instead (groundSpeed,
//     speedFloorAt: tides-zmw.9.18), so the speed stays true to scale down
//     to the 30 m stop. Inside the air the floor follows the altitude over
//     the sea instead, constant dynamic pressure (the law's `air`,
//     tides-zmw.9.29), so level flight is steady over mountains, the gap law
//     only guarding the last stretch above the ground; climbing steeply away
//     from the body (Elite's escape vector) hands the floor back to the gap
//     law, so a climb out of the air is still quick.
//   • Holding boost (Shift, tides-zmw.25) multiplies the air's term of that
//     floor by the law's `boost` factor, spooled over BOOST_SPOOL_SECONDS,
//     so a descent from orbit takes seconds rather than a minute and a half.
//     Boosted, the gap law's guard under it reads the clearance over the
//     highest ground around the ship and ahead of it along its velocity
//     (ShipState.groundHold: a peak hold that rises at once and falls over
//     HOLD_FALL_TAU, updateGroundHold) at the air's guardRate, offset so
//     that over the last ~200 m it is the gap law's own rate · gap
//     (lawSpeed, tides-5lj). Flying level over mountains the boosted cap
//     therefore holds rather than slowing over each peak and surging over
//     each valley, as the guard straight under the ship did; over the last
//     ~100 m the boost changes nothing, and above the air (where the gap
//     law or the well sets the cap) nothing either. Tile streaming no longer
//     bounds it: the speed blur (speed-blur.ts) covers the coarse tiles.
//   • With Flight Assist on the velocity "rides" the cap: after each step it
//     is scaled by how much the cap changed over it, so speed / cap tracks
//     the throttle in steady flight however fast the cap is moving (turning
//     keys off that share; see turnRateMultiplier). With no target locked,
//     riding down a well is rate-limited to WELL_BRAKE, so diving at a light
//     body faster than its well can shed carries the ship in over the cap
//     (overshoot), up to OVERSPEED_MAX × cap. With a target locked the ride
//     down is unlimited, so speed / cap ≤ 1 holds whichever well takes over:
//     crossing a moon system on the way to a locked planet, the ship drops
//     hard as each moon's well takes over, as Elite's supercruise does,
//     rather than grazing the moon at twice its cap (tides-2hv.8). Where a
//     groundSpeed law (Earth near its ground and in its air) sets the cap,
//     the ride runs between e^(−RIDE_DOWN_RATE·dt) and e^(RIDE_UP_RATE·dt),
//     locked or not (tides-zmw.9.18).
//   • With a target locked, the speed *toward* it is also capped at
//     approachCap: the gap over the target's wellTime, which is the cap
//     itself when the target sets d_eff. A locked approach therefore never
//     overshoots. Only the closing component is limited: leaving or flying
//     past a locked target is as fast as untargeted, and the speed floor
//     means the last stretch to the surface takes seconds, not forever.
//   • Flight Assist on: velocity eases toward throttle · v_max along the nose
//     (plus strafe) and rotation eases toward the stick demand, so letting go
//     stops the spin. Off: thrust adds to velocity and spin persists; thrust
//     can't push past the cap and speed carried above it bleeds off at
//     WELL_BRAKE. Either way the velocity e-fold, velocityTau, lengthens
//     deep in a well: the throttle feels heavy near mass and free in open
//     space.
//   • Turn rates are full up to the top of BLUE_ZONE (speed as a share of
//     v_max) and ease off above it, to TURN_RATE_MIN_FACTOR at the cap.
//     Slow is never penalised, so easing off is always the way to turn tight.
//   • Bodies are hard spheres at radius · COLLISION_MARGIN: the ship is pushed
//     back out along the normal and loses its inward velocity. A body with
//     ground (Earth's terrain) also keeps the ship groundClearance above
//     that, direction by direction (floorRadius), and its gaps measure from
//     the ground under the ship rather than its sphere.
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
  /**
   * The boost's spool, 0..1: rises while ShipInput.boost is held and falls
   * after, over BOOST_SPOOL_SECONDS (AirSpeedLaw.boost at 1).
   */
  boost: number
  /**
   * While the boost spools, the highest ground around the ship and ahead of
   * it, held (updateGroundHold): the boosted guard's clearance measures from
   * it (lawSpeed, tides-5lj). None (key null, radius NaN) unboosted.
   */
  groundHold: GroundHold
}

/**
 * A peak hold of a body's ground (ShipState.groundHold): `key` the body's,
 * `radius` the held ground's distance from its centre, scene units; NaN (and
 * key null) for none.
 */
export interface GroundHold {
  key: string | null
  radius: number
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
  /**
   * How far out the drawn ground stands along `direction` (world frame, a
   * unit vector from the centre), for a body whose surface isn't its sphere:
   * Earth's displaced terrain (ship-bodies.ts). It must never read below the
   * ground drawn there, and must leave `direction` as it is. Gaps measure
   * from it in place of `radius`, and the ship stops groundClearance above
   * it as well as outside collisionRadius (floorRadius). Read over a window
   * `reach` scene units around `direction` where given (the near plane's,
   * ship-bodies.ts), else the body's own.
   */
  ground?: (direction: THREE.Vector3, reach?: number) => number
  /** How far above `ground` the ship stops; 0 when missing. */
  groundClearance?: number
  /**
   * The speed floor while this body sets d_eff, in place of V_NORMAL: the
   * cap follows the well below V_NORMAL down to this. For a body whose
   * stop is low enough that V_NORMAL would cross what is drawn there in a
   * frame or two (Earth's cloud deck over its ground). See speedFloor.
   */
  minSpeed?: number
  /**
   * A speed floor that follows the gap to this body's ground, in place of
   * minSpeed while it sets d_eff (speedFloorAt; Earth, tides-zmw.9.18, with
   * its air's, tides-zmw.9.29): the cap stays true to scale down to the ground.
   * minSpeed stays the least it can be, for what reads the body's floor as
   * one number (approach.ts canCrash, ahead).
   */
  groundSpeed?: GroundSpeedLaw
  /**
   * Mass in kg; sets the size of the body's gravity well (wellFactor).
   * Missing, non-positive or non-finite reads as the smallest well.
   */
  mass?: number
}

/**
 * A speed floor `rate` · gap (1/s), never under `min` nor over `max`
 * (scene units/s): flying at a share of it, the gap to the ground e-folds
 * every 1 / (rate · share) seconds, whatever the height.
 */
export interface GroundSpeedLaw {
  rate: number
  min: number
  max: number
  /** Under the gap law, the air's (tides-zmw.9.29); see AirSpeedLaw. */
  air?: AirSpeedLaw
}

/**
 * The floor inside a body's air: `sea` · e^(altitude / `scale`), altitude
 * over the body's sphere (its sea level), wherever that is under the gap
 * law's rate · gap. With `scale` twice the air's scale height that is
 * constant dynamic pressure, so flying level the floor holds whatever the
 * ground below does, the gap law only taking over near the ground. The ship
 * climbing away from the body (the sine of its velocity's climb over
 * `escape`, smoothstep) blends the floor back to the gap law, in log:
 * Elite's escape vector. The velocity's, not the nose's: nose up in reverse
 * is a descent, and pitching over from a climb lets the cap down only as
 * fast as the motion turns, not in a flick of the stick.
 */
export interface AirSpeedLaw {
  /** Scene units/s at sea level. */
  sea: number
  /** Scene units of altitude per e-fold of the floor. */
  scale: number
  /** Sines of the velocity's climb where the escape starts and is full. */
  escape: readonly [number, number]
  /**
   * What holding boost multiplies the air's term by at full spool
   * (ShipState.boost; tides-zmw.25). Without a held ground the boosted
   * floor is still never over the gap law's rate · gap; with one it is
   * never over the boosted guard (guardRate, lawSpeed).
   */
  boost: number
  /**
   * The boosted guard's rate, 1/s (tides-5lj): boosted, the floor is never
   * over max(rate · c, guardRate · (c − guardOffset)), c the clearance over
   * the held ground (ShipState.groundHold) or the gap, whichever is less.
   * At the cap the clearance e-folds no faster than 1 / guardRate s; under
   * RIDE_DOWN_RATE, so Flight Assist rides a boosted dive's cap down.
   */
  guardRate: number
  /**
   * Scene units of clearance the boosted guard's term is offset by, so it
   * meets the gap law's rate · c at guardOffset · guardRate / (guardRate −
   * rate) and the gap law guards the last stretch over the ground as
   * unboosted.
   */
  guardOffset: number
}

/**
 * The cap's floor while `body` sets d_eff `gap` over its surface: its
 * groundSpeed law at that gap where it has one, else speedFloor. A law with
 * `air` reads `altitude` over the body's sphere (the gap when missing) and
 * the sine of the ship's `climb` away from the body (its velocity's), the
 * `boost` spool (ShipState.boost, 0..1) and `hold`, the clearance over the
 * held ground (ShipState.groundHold), which the boosted guard reads (NaN:
 * none, the boosted floor as it was, never over rate · gap; lawSpeed).
 */
export function speedFloorAt(body: Body, gap: number, altitude = gap, climb = 0, boost = 0, hold = NaN): number {
  const law = body.groundSpeed
  return law ? lawFloor(law, gap, altitude, climb, boost, hold) : speedFloor(body)
}

/** A groundSpeed law's floor at `gap`, `altitude`, `climb`, `boost` and `hold` (speedFloorAt). */
export function lawFloor(
  law: Readonly<GroundSpeedLaw>,
  gap: number,
  altitude = gap,
  climb = 0,
  boost = 0,
  hold = NaN
): number {
  return Number.isFinite(gap) ? clamp(lawSpeed(law, gap, altitude, climb, boost, hold), law.min, law.max) : law.max
}

/**
 * The most a law with air lets the well's K_WELL · d_eff raise the cap: the
 * air's speed, unclamped. The well follows the gap and outruns the air from
 * ~1 km up to ~80 km over Earth, so without this the cap would still swing
 * with the ground there. Infinity without air.
 */
export function lawCeiling(
  law: Readonly<GroundSpeedLaw>,
  gap: number,
  altitude = gap,
  climb = 0,
  boost = 0,
  hold = NaN
): number {
  return law.air && Number.isFinite(gap) ? lawSpeed(law, gap, altitude, climb, boost, hold) : Infinity
}

// Without a held ground (`hold` NaN) the air's floor under the gap law's
// rate · gap, boosted or not, as it was. With one (tides-5lj) the unboosted
// floor is the same, and the boosted one reads its guard from the clearance
// c over the held ground (or the gap, if less: the hold's window can miss
// the ground straight under the ship that the gap reads): max(rate · c,
// guardRate · (c − guardOffset)). The first term is the gap law's own, so
// near the ground (under guardOffset · guardRate / (guardRate − rate), 200 m
// over Earth) the guard is as before; above it the second, so 5 km up over
// 4 km peaks Earth's boosted cap holds at 4.4 km/s over peak and valley
// alike, where rate · gap swung it from 2 to 5.4. (max(rate · gap, …) would
// not: over each valley the raw gap still lifted it.) The spool blends the
// unboosted floor to the full one in log, so the cap moves at ln(full /
// unboosted) / BOOST_SPOOL_SECONDS while it spools, at most ln(boost) (the
// guard over the gap law's never more than guardRate / rate ≤ boost).
function lawSpeed(
  law: Readonly<GroundSpeedLaw>,
  gap: number,
  altitude: number,
  climb: number,
  boost = 0,
  hold = NaN
): number {
  const ground = law.rate * gap
  const air = law.air
  if (!air) return ground
  if (Number.isNaN(hold)) return airFloor(air, ground, altitude, climb, boost)
  const base = airFloor(air, ground, altitude, climb)
  const spool = clamp(boost || 0, 0, 1)
  if (spool === 0 || !(base > 0)) return base
  const c = Math.max(0, Math.min(hold, gap))
  const guard = Math.max(law.rate * c, air.guardRate * Math.max(0, c - air.guardOffset))
  const full = airFloor(air, guard, altitude, climb, 1)
  if (!(full > base)) return base
  return spool === 1 ? full : base * (full / base) ** spool
}

// The air's floor at `altitude`, never over `ground`: the gap law's rate ·
// gap, or the boosted guard (lawSpeed).
function airFloor(
  { sea, scale, escape, boost: factor }: AirSpeedLaw,
  ground: number,
  altitude: number,
  climb: number,
  boost = 0
): number {
  // A NaN altitude reads as the sea; Infinity overflows to `ground`. The
  // boost raises the air's term only, before the test below, so the floor
  // is never over `ground`: without a held ground the gap law's rate · gap
  // (the guard near the ground holds as it did), with one the boosted guard
  // on the held clearance, which still meets the gap law near the ground.
  const air = sea * factor ** clamp(boost || 0, 0, 1) * Math.exp(Math.max(0, altitude || 0) / scale)
  if (!(air < ground)) return ground
  const share = smoothstep(climb, escape[0], escape[1])
  return share > 0 ? air * (ground / air) ** share : air
}

/**
 * The cap's floor while `body` sets d_eff: its minSpeed, or V_NORMAL when
 * that is missing, not positive or above V_NORMAL.
 */
export function speedFloor(body: Body): number {
  const { minSpeed } = body
  return minSpeed !== undefined && minSpeed > 0 && minSpeed < V_NORMAL ? minSpeed : V_NORMAL
}

/**
 * The closest the ship gets to `body`'s centre in any direction, scene
 * units: its hard sphere. floorRadius adds the ground under the ship.
 */
export function collisionRadius(body: Body): number {
  return body.collisionRadius ?? body.radius * COLLISION_MARGIN
}

/**
 * The closest the ship gets to `body`'s centre along `direction` (world
 * frame, unit): groundClearance above its ground, but never inside
 * collisionRadius, so a body's hard sphere still clamps the stop.
 */
export function floorRadius(body: Body, direction: THREE.Vector3): number {
  const shell = collisionRadius(body)
  if (!body.ground) return shell
  // A NaN floor would put the ship at NaN for good.
  const floor = body.ground(direction) + (body.groundClearance ?? 0)
  return Number.isFinite(floor) ? Math.max(shell, floor) : shell
}

export interface FlightEnv {
  bodies: readonly Body[]
  /** Locked target body's key; caps the speed toward it (approachCap). */
  targetKey: string | null
}

// Frames longer than this (tab switch, GC pause, debugger) are simulated as
// this long: the world just runs slow for that frame instead of the ship
// covering seconds of flight in one jump. A step moves at most OVERSPEED_MAX ·
// K_WELL · MAX_DT = 0.15 of the mass-weighted gap (wellFactor ≥ 1, so at most
// 15% of the gap to any surface), or 0.075 units at the V_NORMAL floor (at
// most OVERSPEED_MAX · rate · MAX_DT = 0.6 of the gap under a groundSpeed
// law unboosted, whose air never raises it over that), and the collision
// clamps a step to the floor, so it cannot tunnel. Boosted (tides-5lj) the
// guard reads the held clearance at the air's guardRate, so the cap is at
// most guardRate · gap (5 · gap over Earth): 0.5 of the gap a step at the
// cap with Flight Assist, up to OVERSPEED_MAX · 5 · MAX_DT = 1.5 of it at
// 3× overspeed on a 10 fps frame. Still no step ends under the ground: it
// is a radial heightfield and collide pushes radially. The hold's windows
// (up to HOLD_REACH_SECONDS of travel at the boosted air's speed, never
// over HOLD_REACH_ALTITUDES × the altitude) mostly cover the step, so the
// ground it crosses has usually slowed the cap already; where they fall
// short low down, the guard reads the gap anyway. What remains is a 10 fps
// dive with Flight Assist off at 3× overspeed cutting a ridge's flank for
// one frame, visually, never ending inside it.
export const MAX_DT = 0.1

// Hard-sphere radius as a multiple of the body radius, for a body without its
// own collisionRadius. The 2% keeps the camera's near plane off the surface
// mesh. Earth's displaced terrain and shells reach further and set their own
// (ship-bodies.ts EARTH_COLLISION_RADIUS).
export const COLLISION_MARGIN = 1.02

// Speed floor, scene units/s. The cap falls to this within V_NORMAL ·
// wellFactor / K_WELL (0.5 units of the Moon, ~5 of the Sun), i.e. this is
// the speed for skimming, except near a body with its own minSpeed (Earth's
// ground, ship-bodies.ts). Crossing the Moon (diameter 2) takes ~8 s: slow
// enough to read the surface, fast enough not to feel stuck.
export const V_NORMAL = 0.25

// Cap per unit of mass-weighted surface distance, 1/s. [TUNE] Sets how long a
// well takes to cross: at the cap the gap e-folds every wellFactor / K_WELL
// seconds (2 s at the Moon, 3.7 s at Earth, 22 s at the Sun). Mostly moves
// the short trips: Earth → Moon (flight.test.ts, 10–15 s) is almost all well.
export const K_WELL = 0.5

// Top speed, scene units/s: ~0.15 AU/s at the flight scale (roughly 75c).
// [TUNE] Sets the long trips, which are mostly open space: Earth → Neptune
// (~29 AU, flight.test.ts 180–300 s) is ~D / V_TOP plus the wells at each
// end. The cap reaches it where the mass-weighted gap passes V_TOP / K_WELL.
export const V_TOP = 150

// The lightest well: the Moon's mass, kg. wellFactor normalises to it so
// every body's factor is ≥ 1, which keeps the MAX_DT tunnel bound.
export const WELL_REFERENCE_MASS_KG = 7.342e22

// How the well grows with mass: wellFactor = (mass / Moon)^this. [TUNE] It
// sets the middle-distance trips: higher stretches Jupiter (factor 4.15 at
// 0.14) and the Sun's leg of every interplanetary trip; 0.15 put Earth →
// Jupiter past 120 s. The Sun's 11 against Mercury's 1.2 is the "big wells
// reach further" feel.
export const WELL_MASS_EXPONENT = 0.14

// Velocity e-fold, s, in open space (cap at V_TOP) and deep in a well (cap at
// V_NORMAL); velocityTau blends them on log cap. [TUNE] The well end is the
// "heavy throttle" near mass; the open end lets the ship spool up freely.
// With FA off it is also the thrust: full throttle from rest would reach the
// cap in this long if accelerating linearly.
export const VELOCITY_TAU_OPEN = 0.5
export const VELOCITY_TAU_WELL = 2

// Fastest the velocity rides a falling cap down, 1/s (an e-fold every 4 s).
// [TUNE] Diving into a well with FA on, speed / cap stays at the throttle as
// long as throttle · K_WELL / wellFactor ≤ this: below half throttle at the
// Moon, ~0.7 at Mars, any throttle at Earth or heavier. Faster than that and
// the ship arrives over the cap: unlocked, that is the overshoot. With a
// target locked the ride isn't limited (rideWell), so this only applies
// unlocked.
export const WELL_BRAKE = 0.25

// How fast the velocity rides the cap while a groundSpeed law's floor sets
// it (the cap is rate · gap there), 1/s (tides-zmw.9.18). [TUNE]
//   • Up, RIDE_UP_RATE: flying off a cliff the gap, and with it the cap, can
//     jump tenfold in a frame, which would throw the ship forward as hard.
//     Above the law's own rate (a steady climb's, 2/s), so it never slows one.
//   • Down, RIDE_DOWN_RATE in place of WELL_BRAKE: the cap falls at rate ·
//     share in a steady descent (2/s at full throttle), which WELL_BRAKE's
//     0.25/s would turn into a dive at OVERSPEED_MAX × the cap all the way
//     to the ground. Three times that, so a descent rides its cap, while a
//     ridge passing under the ship (the gap 100 m → 30 m in a frame) eases
//     the speed down over a fraction of a second rather than braking it
//     3.3× in one frame; OVERSPEED_MAX and the collision still bound it.
//     Boosted, a dive at the cap sheds it at the air's guardRate (5/s over
//     Earth, tides-5lj) from ~1 km down to 200 m, still under this, so Flight
//     Assist rides it down rather than clamping.
// Off the law (Earth's well above the plateau, every other body) the ride
// is as before: WELL_BRAKE unlocked, free locked.
export const RIDE_UP_RATE = 3
export const RIDE_DOWN_RATE = 6

// Hard ceiling on speed as a multiple of the cap, applied before and after
// the move. [TUNE] Bounds overshoot and, with K_WELL · MAX_DT, the step size.
export const OVERSPEED_MAX = 3

// Inward speed at the collision shell, units/s, above which a step counts as
// a hit (telemetry.colliding). Resting on a surface or holding thrust into it
// gains at most V_NORMAL · (1 − e^(−MAX_DT / VELOCITY_TAU_WELL)) ≈ 0.012 a
// step (FA off: V_NORMAL · MAX_DT / VELOCITY_TAU_WELL = 0.0125) before being
// cancelled, so 0.05 never flags those, while arriving at the V_NORMAL floor
// always does. Arriving at a lower floor (Earth's ground, at most
// OVERSPEED_MAX × 0.02) rarely does and is never an impact (impact.ts):
// touching down there is landing, and the approach panel doesn't warn of it
// either (approach.ts canCrash, tides-01v.8.17).
export const COLLISION_SPEED = 0.05

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
// the band. They draw it on the throttle because with FA on the speed settles
// to throttle · cap whether the cap is steady or moving (rideWell); only
// diving unlocked at a light body faster than WELL_BRAKE can shed leaves it
// above (overshoot: turning suffers sooner). [TUNE] the top sets where
// turning starts to suffer.
export const BLUE_ZONE: readonly [number, number] = [0.5, 0.75]

// Turn-rate multiplier at the speed cap. [TUNE] At 0.4 a 90° yaw at the cap
// takes ~8 s against ~3.4 s in the band: enough that pilots ease off for
// tight manoeuvres, not so much that a fast ship can't be steered.
export const TURN_RATE_MIN_FACTOR = 0.4

// Seconds the boost takes to spool fully up, and back down on release
// (ShipState.boost, tides-zmw.25). [TUNE] The cap moves at
// ln(AirSpeedLaw.boost) / this in log while it spools, which must stay
// within RIDE_UP_RATE (ship-bodies.test): then in level flight Flight
// Assist's ride keeps speed / cap at the throttle both ways, and with FA off
// the OVERSPEED_MAX clamp brings a release's speed down no faster than that,
// never a snap. With a held ground (tides-5lj) the spool blends the
// unboosted floor to the full one in log, and the full one is never more
// than max(boost, guardRate / rate) = 20 times it (ship-bodies.test), so
// the same bound holds. Climbing, the air's rise stacks on the spool's and
// the ride clamps at RIDE_UP_RATE (the headroom is ln 20 = 2.996 against
// 3), so FA's share lags the throttle briefly until the spool is full. A
// boolean boost would drop the cap 20× in a frame on every release; the
// held ground can still do that, but only as terrain comes into its window
// (HOLD_AHEAD_SECONDS).
export const BOOST_SPOOL_SECONDS = 1

// The boosted guard's ground hold (ShipState.groundHold, updateGroundHold;
// tides-5lj). [TUNE] While the boost spools it reads the highest ground in
// windows of radius HOLD_REACH_SECONDS of travel centred on where the ship
// is and will be HOLD_AHEAD_SECONDS on along its velocity: a corridor from
// 1.5 s behind to 3.5 s ahead, ~27 km 5 km up, so ridges every 16 km always
// have a peak in it and the held clearance holds steady over peak and
// valley. Ahead so the cap is down before a peak arrives; behind so a ridge
// just passed keeps it down while the next comes into the window. Seconds
// of travel at holdSpeed, the full boost's air floor where the ship is, not
// at its own speed: a window that grew with the speed fed back on it (a
// ridge beside the track came into the window, the cap fell, the speed
// with it, the window shrank, the ridge dropped out, the cap rose: a
// sawtooth at ~13 Hz; review 1). A peak coming into the window at once can
// cut the cap many times over in a frame (up to the boost's 20×), and
// rideWell's OVERSPEED_MAX clamp then brakes the speed to 3× the new cap at
// once: a hard brake, accepted, which now comes seconds before the peak
// rather than over it. Ascending, and the windows overlap at full reach.
export const HOLD_AHEAD_SECONDS: readonly number[] = [0, 1, 2]
export const HOLD_REACH_SECONDS = 1.5
// The windows' radius never exceeds this many times the altitude over the
// sea, which bounds the ground's scan (tiles, the globe's floor), with
// holdSpeed's own bound at the law's max (1.5 · 43 km/s ≈ 64 km over Earth).
// Low down, where that leaves the windows narrower than holdSpeed's stride
// (under ~1 km over Earth), the centres close up to a window's diameter
// apart (HOLD_AHEAD_STEP), so the windows still touch and the corridor has
// no gaps for a hill to slip through: from 2 altitudes behind to 10 ahead,
// 1 to 5 km at 500 m up, still seconds of warning at the cap there
// (review 2).
export const HOLD_REACH_ALTITUDES = 2
// The widest step between HOLD_AHEAD_SECONDS, seconds: the centres are
// never more than a window's diameter apart over it.
const HOLD_AHEAD_STEP = HOLD_AHEAD_SECONDS.reduce((step, t, i, all) => (i > 0 ? Math.max(step, t - all[i - 1]) : step), 0)
// The share of the law's least speed (GroundSpeedLaw.min; 5 m/s over Earth)
// over which the ahead offset fades in from rest, so a drift (what collide
// leaves while hovering) doesn't swing the windows 2 strides out in any
// direction. It reads the ship's speed only for that fade: above it the
// offset is fixed, so it cannot feed back on the cap (review 1).
export const HOLD_DRIFT_SHARE = 0.1
// Seconds per e-fold the held ground falls toward lower ground in the
// windows, once the peak has passed out of them: past the last ridge of a
// range the cap rises back over a few seconds rather than at once.
export const HOLD_FALL_TAU = 3

const WORLD_UP = new THREE.Vector3(0, 1, 0)

export function createShipState(): ShipState {
  return {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    orientation: new THREE.Quaternion(),
    angularVelocity: new THREE.Vector3(),
    boost: 0,
    groundHold: { key: null, radius: NaN },
  }
}

export interface NearestBody {
  body: Body
  /** From the surface (not the collision shell); negative inside. */
  surfaceDistance: number
}

const { clamp, lerp, smoothstep } = THREE.MathUtils

/**
 * How much bigger `mass`'s gravity well is than the Moon's: (mass / Moon)^
 * WELL_MASS_EXPONENT, at least 1. Missing, non-positive or non-finite masses
 * read as 1. The cap counts a body's gap divided by this, so a factor of 11
 * (the Sun) slows the ship from 11 times further out.
 */
export function wellFactor(mass: number | undefined): number {
  if (mass === undefined || !Number.isFinite(mass) || mass <= 0) return 1
  return Math.max(1, (mass / WELL_REFERENCE_MASS_KG) ** WELL_MASS_EXPONENT)
}

/**
 * Seconds per e-fold of the gap to `body` when closing at the cap it sets:
 * wellFactor / K_WELL. 2 s at the Moon, 3.7 s at Earth, 8.3 s at Jupiter.
 */
export function wellTime(body: Body): number {
  return wellFactor(body.mass) / K_WELL
}

/**
 * Velocity e-fold for a speed cap, s: VELOCITY_TAU_OPEN at V_TOP rising to
 * VELOCITY_TAU_WELL at V_NORMAL, linear in log cap so each halving of the cap
 * weighs the same. Out-of-range caps clamp; never NaN.
 */
export function velocityTau(cap: number): number {
  const depth = Math.log(V_TOP / cap) / Math.log(V_TOP / V_NORMAL)
  return lerp(VELOCITY_TAU_OPEN, VELOCITY_TAU_WELL, Number.isNaN(depth) ? 1 : clamp(depth, 0, 1))
}

// One pass over the bodies for the nearest surface, the target and the
// mass-weighted well distance, into a reused record so the per-frame scan
// allocates nothing.
interface Proximity {
  nearest: Body | null
  nearestGap: number
  target: Body | null
  targetGap: number
  /** The target's speedFloorAt its gap, altitude and the ship's climb. */
  targetFloor: number
  targetAltitude: number
  targetClimb: number
  /** The boost spool measure() read the target's floor with. */
  targetBoost: number
  /** The clearance over the held ground measure() read the target's floor with; NaN for none. */
  targetHold: number
  /** min over bodies of max(0, gap) / wellFactor; Infinity with no bodies. */
  wellDistance: number
  /** The body that sets wellDistance (d_eff), its wellFactor and speedFloor (speedFloorAt its gap). */
  wellKey: string | null
  wellBody: Body | null
  wellBodyFactor: number
  wellFloor: number
  /** Its lawCeiling: the most the well raises the cap; Infinity without air. */
  wellCeiling: number
  /** Whether that body has a groundSpeed law (wellCap: whether its floor sets the cap). */
  wellGround: boolean
  /**
   * That body's groundSpeed law (null without one) and the gap, altitude
   * and climb measure() read it at, so boostRaises can read it again at
   * spool 0 without a second pass over the bodies.
   */
  wellLaw: Readonly<GroundSpeedLaw> | null
  wellGap: number
  wellAltitude: number
  wellClimb: number
}

const proximity: Proximity = {
  nearest: null,
  nearestGap: Infinity,
  target: null,
  targetGap: Infinity,
  targetFloor: V_NORMAL,
  targetAltitude: Infinity,
  targetClimb: 0,
  targetBoost: 0,
  targetHold: NaN,
  wellDistance: Infinity,
  wellKey: null,
  wellBody: null,
  wellBodyFactor: 1,
  wellFloor: V_NORMAL,
  wellCeiling: Infinity,
  wellGround: false,
  wellLaw: null,
  wellGap: Infinity,
  wellAltitude: Infinity,
  wellClimb: 0,
}

const outward = new THREE.Vector3()
// surfaceGap's distance from the centre, for the air's altitude.
let centreDistance = 0

// From `position` to `body`'s surface below it; negative inside.
function surfaceGap(position: THREE.Vector3, body: Body): number {
  const d = outward.subVectors(position, body.position).length()
  centreDistance = d
  if (!body.ground) return d - body.radius
  if (d > 0) outward.divideScalar(d)
  else outward.copy(WORLD_UP)
  return d - body.ground(outward)
}

// The sine of `heading`'s climb away from `body`'s centre, from `position`.
function climbSine(position: THREE.Vector3, body: Body, heading: THREE.Vector3 | null): number {
  if (!heading || !(centreDistance > 0)) return 0
  return outward.subVectors(position, body.position).dot(heading) / centreDistance
}

function measure(
  position: THREE.Vector3,
  bodies: readonly Body[],
  targetKey: string | null,
  heading: THREE.Vector3 | null = null,
  boost = 0,
  hold: Readonly<GroundHold> | null = null
): Proximity {
  proximity.nearest = null
  proximity.nearestGap = Infinity
  proximity.target = null
  proximity.targetGap = Infinity
  proximity.targetFloor = V_NORMAL
  proximity.targetAltitude = Infinity
  proximity.targetClimb = 0
  proximity.targetBoost = boost
  proximity.targetHold = NaN
  proximity.wellDistance = Infinity
  proximity.wellKey = null
  proximity.wellBody = null
  proximity.wellBodyFactor = 1
  proximity.wellFloor = V_NORMAL
  proximity.wellCeiling = Infinity
  proximity.wellGround = false
  proximity.wellLaw = null
  proximity.wellGap = Infinity
  proximity.wellAltitude = Infinity
  proximity.wellClimb = 0
  for (const body of bodies) {
    const gap = surfaceGap(position, body)
    // A NaN gap never wins the nearest or well comparisons, so it can't
    // poison the cap.
    if (gap < proximity.nearestGap) {
      proximity.nearest = body
      proximity.nearestGap = gap
    }
    const altitude = centreDistance - body.radius
    const climb = climbSine(position, body, heading)
    // The clearance over this body's held ground, if the hold is its.
    const held = hold && hold.key === body.key ? centreDistance - hold.radius : NaN
    const floor = speedFloorAt(body, gap, altitude, climb, boost, held)
    const factor = wellFactor(body.mass)
    const well = Math.max(0, gap) / factor
    if (well < proximity.wellDistance) {
      proximity.wellDistance = well
      proximity.wellKey = body.key
      proximity.wellBody = body
      proximity.wellBodyFactor = factor
      proximity.wellFloor = floor
      proximity.wellCeiling = body.groundSpeed ? lawCeiling(body.groundSpeed, gap, altitude, climb, boost, held) : Infinity
      proximity.wellGround = body.groundSpeed !== undefined
      proximity.wellLaw = body.groundSpeed ?? null
      proximity.wellGap = gap
      proximity.wellAltitude = altitude
      proximity.wellClimb = climb
    }
    if (targetKey != null && body.key === targetKey) {
      proximity.target = body
      proximity.targetGap = gap
      proximity.targetFloor = floor
      proximity.targetAltitude = altitude
      proximity.targetClimb = climb
      proximity.targetHold = held
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

// Whether a groundSpeed law, not the well, sets the cap: under Earth's
// plateau, or in its air (rideWell). A supercruise arrival in Earth's well
// rides it with WELL_BRAKE as before.
function groundLawSets({ wellGround, wellFloor, wellCeiling, wellDistance }: Proximity): boolean {
  const well = K_WELL * wellDistance
  return wellGround && (wellFloor > well || wellCeiling < well)
}

// wellDistance is Infinity with no bodies (or none with a usable gap).
function wellCap({ wellDistance, wellFloor, wellCeiling }: Proximity): number {
  return capAt(wellDistance, wellFloor, wellCeiling)
}

function capAt(wellDistance: number, floor: number, ceiling: number): number {
  return Number.isFinite(wellDistance) ? clamp(Math.min(K_WELL * wellDistance, ceiling), floor, V_TOP) : V_NORMAL
}

// The least relative rise over the unboosted cap that counts as the boost
// raising it (boostRaises), well clear of rounding: where the boost changes
// nothing both caps come from the same expressions and match exactly.
const BOOST_RAISES_BY = 1e-6

// Whether the boost raised `cap`, wellCap(p) for a measure() read with the
// spool over 0, over the cap the same measure gives at spool 0: the well
// body's law read again at its gap, altitude and climb. False without an
// air law (space, the Moon, the low tier), where the air already meets the
// gap law or the plateau (~91 km up), and in the guard band near the ground
// (the last ~100 m over Earth) where the gap law binds either way, the
// boosted guard on the held ground (tides-5lj) being the gap law's own
// there. The HUD's "Boost" (tides-zmw.25) reads it, so it never claims a
// boost that changes nothing.
function boostRaises(p: Proximity, cap: number): boolean {
  const law = p.wellLaw
  if (!law?.air) return false
  const { wellGap: gap, wellAltitude: altitude, wellClimb: climb } = p
  const unboosted = capAt(p.wellDistance, lawFloor(law, gap, altitude, climb), lawCeiling(law, gap, altitude, climb))
  return cap > unboosted * (1 + BOOST_RAISES_BY)
}

/**
 * The speed limit at `position`, scene units/s: clamp(K_WELL · d_eff,
 * floor, V_TOP), with d_eff the smallest gap / wellFactor over `bodies` and
 * floor the speedFloor of the body that sets it (speedFloorAt, with the
 * ship's `heading`, its direction of travel, world frame, unit, for an air
 * law's escape; none reads as level, the `boost` spool, ShipState.boost,
 * and the held ground, ShipState.groundHold, which the boosted guard reads;
 * none reads the gap). With no bodies there is nothing to scale against, so
 * V_NORMAL.
 */
export function speedCap(
  position: THREE.Vector3,
  bodies: readonly Body[],
  heading: THREE.Vector3 | null = null,
  boost = 0,
  hold: Readonly<GroundHold> | null = null
): number {
  return wellCap(measure(position, bodies, null, heading, boost, hold))
}

/**
 * The limit on speed toward a locked target `gap` from its surface, whose
 * gap should e-fold every `eta` seconds (its wellTime): max(floor, gap / eta),
 * with `floor` its speedFloor. When the target sets d_eff this is the cap
 * itself, so it only binds on speed carried in above the cap: a locked
 * approach can't overshoot.
 *
 * `dt` makes the cap exact for a discrete step: closing at gap / (eta + dt)
 * for dt leaves the closing speed ≤ newGap / eta, so the rule holds after
 * the step as well as before it.
 */
export function approachCap(gap: number, eta: number, dt = 0, floor = V_NORMAL): number {
  return Math.max(floor, Math.max(0, gap) / (eta + dt))
}

// approachCap over a law with air: the cap (wellCap's, the target setting
// d_eff) a step closer, gap, altitude and the held clearance (`hold`, NaN
// for none) all less by the cap here · dt. The air's floor and ceiling fall
// with each of them much as the well's gap / eta falls with the gap, so
// closing at the cap where the step ends leaves the ship under it there: a
// locked approach still can't overshoot.
function airApproachCap(
  law: Readonly<GroundSpeedLaw>,
  gap: number,
  altitude: number,
  climb: number,
  eta: number,
  dt: number,
  boost: number,
  hold: number
): number {
  const ahead = airCapAt(law, gap, altitude, climb, eta, boost, hold) * dt
  return airCapAt(law, gap - ahead, altitude - ahead, climb, eta, boost, hold - ahead)
}

// wellCap with the target setting d_eff, for airApproachCap.
function airCapAt(
  law: Readonly<GroundSpeedLaw>,
  gap: number,
  altitude: number,
  climb: number,
  eta: number,
  boost: number,
  hold: number
): number {
  return Math.max(
    lawFloor(law, gap, altitude, climb, boost, hold),
    Math.min(Math.max(0, gap) / eta, lawCeiling(law, gap, altitude, climb, boost, hold))
  )
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
  { target, targetGap, targetFloor, targetAltitude, targetClimb, targetBoost, targetHold }: Proximity
): void {
  bodyAxes(state.orientation)
  // Thrust as a share of the cap, world frame.
  scratch
    .copy(nose)
    .multiplyScalar(usableThrottle(input.throttle))
    .addScaledVector(right, STRAFE_SHARE * axis(input.strafeX))
    .addScaledVector(up, STRAFE_SHARE * axis(input.strafeY))

  const v = state.velocity
  const tau = velocityTau(cap)
  if (input.flightAssist) {
    scratch.multiplyScalar(cap).clampLength(0, cap)
    v.lerp(scratch, 1 - Math.exp(-dt / tau))
  } else {
    // Thrust can't push past the cap; speed already above it (carried down
    // a well) bleeds off at WELL_BRAKE instead of snapping to it.
    const carried = v.length() * Math.exp(-WELL_BRAKE * dt)
    v.addScaledVector(scratch, (cap / tau) * dt)
    v.clampLength(0, Math.max(cap, carried))
  }
  v.clampLength(0, OVERSPEED_MAX * cap)

  if (!target) return
  toTarget.subVectors(target.position, state.position)
  const distance = toTarget.length()
  if (distance === 0) return
  toTarget.divideScalar(distance)
  const closing = v.dot(toTarget)
  const law = target.groundSpeed
  const limit = law?.air
    ? airApproachCap(law, targetGap, targetAltitude, targetClimb, wellTime(target), dt, targetBoost, targetHold)
    : approachCap(targetGap, wellTime(target), dt, targetFloor)
  if (closing > limit) v.addScaledVector(toTarget, limit - closing)
}

// After the move, with FA on, scale the velocity by how much the cap changed
// (capAfter / capBefore), so the ease in translate works on speed / cap and
// that share settles at the throttle even while the cap moves. Without this
// the share lags a moving cap by ~K·τ / wellFactor: departing at full
// throttle it sat at ~0.73 (no wide-turn penalty), arriving it hit 1 at half
// throttle (tides-2hv.4). Unlocked, riding down is rate-limited to
// WELL_BRAKE, which is where overshoot comes from; locked, it follows the cap
// all the way, so no well (the target's or one on the way) is overshot. FA
// off doesn't ride: the pilot owns the speed. Where a groundSpeed law sets
// the cap (`groundLaw`: its floor, or its air's ceiling under the well) the
// ride is clamped to RIDE_DOWN_RATE and RIDE_UP_RATE, locked or not: in
// Earth's air that is all the way up to ~91 km, so a locked ride there is
// rate-limited too.
function rideWell(
  state: ShipState,
  input: Readonly<ShipInput>,
  dt: number,
  capBefore: number,
  capAfter: number,
  locked: boolean,
  groundLaw: boolean
): void {
  const v = state.velocity
  if (input.flightAssist) {
    const ratio = capAfter / capBefore
    if (groundLaw) v.multiplyScalar(clamp(ratio, Math.exp(-RIDE_DOWN_RATE * dt), Math.exp(RIDE_UP_RATE * dt)))
    else v.multiplyScalar(locked ? ratio : Math.max(ratio, Math.exp(-WELL_BRAKE * dt)))
  }
  v.clampLength(0, OVERSPEED_MAX * capAfter)
}

// Push the ship out of any body it ended inside and drop the velocity
// component into it, so it slides along the surface. The push is radial,
// also over a ground: climbing rising terrain lifts the ship straight up to
// the floor, which keeps the tangential speed. Bodies in the scene never
// overlap, so one pass leaves the ship outside all of them. Returns whether
// the step hit something faster than COLLISION_SPEED.
function collide(state: ShipState, bodies: readonly Body[]): boolean {
  let hit = false
  for (const body of bodies) {
    const normal = scratch.subVectors(state.position, body.position)
    const d = normal.length()
    // A sphere needs no direction; a ground is sampled under the ship.
    if (!body.ground && d >= collisionRadius(body)) continue
    if (d > 1e-9) normal.divideScalar(d)
    else normal.copy(WORLD_UP)
    const shell = floorRadius(body, normal)
    if (d >= shell) continue
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
  { nearest, nearestGap, target, targetGap, wellKey, wellBodyFactor, wellFloor }: Proximity,
  cap: number,
  colliding: boolean,
  boosted: boolean
): void {
  out.speed = state.velocity.length()
  out.speedCap = cap
  out.throttle = usableThrottle(input.throttle)
  out.flightAssist = input.flightAssist
  out.boost = state.boost
  out.boosted = boosted
  out.velocity.copy(state.velocity)
  out.colliding = colliding
  // The carry (frame-carry.ts fillAir) overwrites these after the step, or,
  // without it, ShipController's fillAirDensity fills the density and pressure.
  out.air.speed = out.speed
  out.air.coupling = 0
  out.air.density = 0
  out.air.dynamicPressure = 0

  out.nearest.key = nearest ? nearest.key : null
  out.nearest.surfaceDistance = nearestGap
  out.well.key = wellKey
  out.well.factor = wellBodyFactor
  out.well.floor = wellFloor

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

const heading = new THREE.Vector3()

// The boost spool after `dt` with boost `held`: toward 1 or 0 at
// 1 / BOOST_SPOOL_SECONDS. A NaN spool restarts from 0.
function spoolBoost(spool: number, held: boolean, dt: number): number {
  const s = Number.isFinite(spool) ? clamp(spool, 0, 1) : 0
  const step = dt / BOOST_SPOOL_SECONDS
  return held ? Math.min(1, s + step) : Math.max(0, s - step)
}

// The ship's direction of travel (unit), or null when still.
function headingOf(state: ShipState): THREE.Vector3 | null {
  const speed = state.velocity.length()
  return speed > 1e-12 ? heading.copy(state.velocity).divideScalar(speed) : null
}

const holdAt = new THREE.Vector3()
const holdAlong = new THREE.Vector3()

/**
 * The speed the ground hold sizes its windows by `altitude` over the sea
 * under `law` (HOLD_AHEAD_SECONDS): the full boost's air floor flying
 * level, with no guard under it, never over law.max. It depends on neither
 * the hold nor the ship's speed, so the window can't feed back on the cap
 * it sets. NaN without air.
 */
export function holdSpeed(law: Readonly<GroundSpeedLaw>, altitude: number): number {
  const air = law.air
  if (!air) return NaN
  return Math.min(airFloor(air, Infinity, altitude, 0, 1), law.max)
}

/**
 * Updates `hold` (ShipState.groundHold) over `body` for a step of `dt` s
 * ending at `position` with `velocity` and boost `spool` (tides-5lj): the
 * highest of body.ground in windows of radius HOLD_REACH_SECONDS ·
 * holdSpeed (never over HOLD_REACH_ALTITUDES × the altitude over the
 * body's sphere) centred on the points HOLD_AHEAD_SECONDS of holdSpeed on
 * along the velocity, closed up so the windows touch where the reach is
 * clamped, and faded in from on the ship over the first HOLD_DRIFT_SHARE of
 * the law's least speed, as a distance from the body's centre. Higher ground than held is taken at once; lower, the hold
 * falls toward it over HOLD_FALL_TAU. A new body, or no hold yet, starts at
 * the peak. None (key null, radius NaN) with the spool at 0, without a body,
 * ground or air law, where the boost changes nothing (the unboosted air
 * already at law.max, ~91 km up over Earth: no scan all the way to the
 * Moon), or where no window reads a ground (a NaN window never wins).
 * Allocates nothing.
 */
export function updateGroundHold(
  hold: GroundHold,
  body: Body | null,
  position: THREE.Vector3,
  velocity: THREE.Vector3,
  spool: number,
  dt: number
): void {
  const ground = body?.ground
  const law = body?.groundSpeed
  const altitude = body ? position.distanceTo(body.position) - body.radius : NaN
  if (!body || !ground || !law?.air || !(spool > 0) || !(airFloor(law.air, Infinity, altitude, 0) < law.max)) {
    hold.key = null
    hold.radius = NaN
    return
  }
  const speed = holdSpeed(law, altitude)
  const reach = Math.min(speed * HOLD_REACH_SECONDS, HOLD_REACH_ALTITUDES * Math.max(0, altitude))
  const stride = HOLD_AHEAD_STEP > 0 ? Math.min(speed, (2 * reach) / HOLD_AHEAD_STEP) : speed
  const moving = velocity.length()
  const fade = Math.min(1, moving / (HOLD_DRIFT_SHARE * law.min))
  if (moving > 0 && fade > 0) holdAlong.copy(velocity).multiplyScalar((stride * fade) / moving)
  else holdAlong.set(0, 0, 0)
  let peak = -Infinity
  for (let i = 0; i < HOLD_AHEAD_SECONDS.length; i++) {
    holdAt.copy(position).addScaledVector(holdAlong, HOLD_AHEAD_SECONDS[i]).sub(body.position)
    const d = holdAt.length()
    if (!(d > 0)) continue
    const top = ground(holdAt.divideScalar(d), reach)
    if (top > peak) peak = top
  }
  if (!Number.isFinite(peak)) {
    hold.key = null
    hold.radius = NaN
    return
  }
  const h = Number.isFinite(dt) ? Math.max(0, dt) : 0
  if (hold.key !== body.key || !Number.isFinite(hold.radius) || peak >= hold.radius) hold.radius = peak
  else hold.radius = peak + (hold.radius - peak) * Math.exp(-h / HOLD_FALL_TAU)
  hold.key = body.key
}

/**
 * Puts the ship back over the ground after it moved under it between steps
 * (tides-zmw.9.8: the surface tiles update after the step, and the ground
 * the frame draws is theirs): stepShip's collision alone, no thrust, turn
 * or ride. Returns whether that was a hit (COLLISION_SPEED).
 */
export function settleShip(state: ShipState, env: Pick<FlightEnv, 'bodies'>): boolean {
  return collide(state, env.bodies)
}

/**
 * Advance the ship by `dt` seconds (clamped to MAX_DT; non-finite or negative
 * dt is a zero step). Mutates and returns `state`; fills `telemetry` when
 * given. Thrust and the approach cap use the caps at the start of the step,
 * so a step can never carry the ship further than they allow from where it
 * was; the ride and telemetry use the cap where it ends.
 */
export function stepShip(
  state: ShipState,
  input: Readonly<ShipInput>,
  dt: number,
  env: FlightEnv,
  telemetry?: ShipTelemetry
): ShipState {
  const h = Number.isFinite(dt) ? clamp(dt, 0, MAX_DT) : 0
  // measure() reuses one record, so take what this step needs before the
  // end-of-step measure overwrites it.
  const here = measure(state.position, env.bodies, env.targetKey, headingOf(state), state.boost, state.groundHold)
  const capBefore = wellCap(here)
  const { target } = here
  // The body whose ground the boosted guard holds: the well's, with air.
  const holdBody = here.wellLaw?.air ? here.wellBody : null
  // The spool this step ends on, ahead of the move: a locked approach
  // closes at the cap where the step ends, so while the boost spools down
  // it reads the lower of the two (airApproachCap).
  const spool = h > 0 ? spoolBoost(state.boost, input.boost, h) : state.boost
  here.targetBoost = Math.min(here.targetBoost, spool)
  if (h > 0) {
    rotate(state, input, h, speedFraction(state.velocity.length(), capBefore))
    translate(state, input, h, capBefore, here)
    state.position.addScaledVector(state.velocity, h)
  }
  // Even on a zero step: the ground can rise under a still ship (the live
  // terrain scale follows the altitude, tides-zmw.9.5; tiles load).
  const colliding = collide(state, env.bodies)
  // Spooled after the move and before the end-of-step measure, so the ride's
  // capAfter / capBefore carries the boost's change with the gap's, and the
  // held ground's.
  state.boost = spool
  updateGroundHold(state.groundHold, holdBody, state.position, state.velocity, state.boost, h)
  // End-of-step distances, so the ride and the HUD match where the camera
  // now is.
  const there = measure(state.position, env.bodies, env.targetKey, headingOf(state), state.boost, state.groundHold)
  const capAfter = wellCap(there)
  if (h > 0) rideWell(state, input, h, capBefore, capAfter, target !== null, groundLawSets(there))
  if (telemetry) {
    const boosted = state.boost > 0 && boostRaises(there, capAfter)
    fillTelemetry(telemetry, state, input, there, capAfter, colliding, boosted)
  }
  return state
}
