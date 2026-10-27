import * as THREE from 'three'
import { describe, expect, test } from 'vitest'
import { PLANETS, sceneRadius } from '../planets'
import {
  BLUE_ZONE,
  BOOST_SPOOL_SECONDS,
  COLLISION_MARGIN,
  HOLD_DRIFT_SHARE,
  HOLD_FALL_TAU,
  HOLD_REACH_ALTITUDES,
  HOLD_REACH_SECONDS,
  K_WELL,
  MAX_DT,
  OVERSPEED_MAX,
  PITCH_RATE,
  RIDE_DOWN_RATE,
  RIDE_UP_RATE,
  ROLL_RATE,
  TURN_RATE_MIN_FACTOR,
  V_NORMAL,
  V_TOP,
  VELOCITY_TAU_OPEN,
  VELOCITY_TAU_WELL,
  WELL_BRAKE,
  YAW_RATE,
  approachCap,
  collisionRadius,
  createShipState,
  floorRadius,
  lawCeiling,
  lawFloor,
  nearestBody,
  settleShip,
  speedCap,
  speedFloor,
  speedFloorAt,
  speedFraction,
  stepShip,
  turnRateMultiplier,
  holdSpeed,
  updateGroundHold,
  velocityTau,
  wellFactor,
  wellTime,
  type Body,
  type GroundHold,
  type GroundSpeedLaw,
  type FlightEnv,
  type ShipState,
} from './flight'
import {
  BODY_MASS_KG,
  EARTH_AIR_BOOST,
  EARTH_BOOST_GUARD_OFFSET,
  EARTH_BOOST_GUARD_RATE,
  EARTH_COLLISION_RADIUS,
  EARTH_GAP_RATE,
  EARTH_GROUND_CLEARANCE,
  EARTH_GROUND_SPEED,
  EARTH_GROUND_SPEED_LAW,
  EARTH_RADIUS,
  EARTH_SLOWEST,
  EARTH_UNITS_PER_METRE,
  FINE_GROUND_CLEARANCE,
  createShipBodies,
  updateShipBodies,
  updateShipBody,
} from './ship-bodies'
import type { QualityTier } from '../quality'
import { CLOUD_LAYER_TOP, TERRAIN_DISPLACEMENT, TERRAIN_MAX_GREY } from '../cloud-layer'
import type { ShipInput } from './ship-input'
import { createShipTelemetry, type ShipTelemetry } from './ship-telemetry'
import { carryShip, createFrameCarry, earthSpinRate } from './frame-carry'
import { EARTH_KM_PER_UNIT } from '../surface-handover'
import { approachEta } from './approach'

const FRAME = 1 / 60
const Y = new THREE.Vector3(0, 1, 0)

// A frozen, plausible layout: Earth on its r = 50 orbit, the Moon 10 units off
// it (behind the departure line), Neptune at the outer edge, and Mars and
// Jupiter near enough the route to take a turn as the nearest body.
const SUN: Body = { key: 'sun', position: new THREE.Vector3(0, 0, 0), radius: 10 }
const EARTH: Body = {
  key: 'earth',
  position: new THREE.Vector3(50, 0, 0),
  radius: sceneRadius(12_742_000),
}
const MOON: Body = { key: 'moon', position: new THREE.Vector3(50, 0, 10), radius: 1 }
const MARS: Body = {
  key: 'mars',
  position: new THREE.Vector3(75, 0, -50),
  radius: PLANETS.mars.radius,
}
const JUPITER: Body = {
  key: 'jupiter',
  position: new THREE.Vector3(-60, 0, -170),
  radius: PLANETS.jupiter.radius,
}
const NEPTUNE: Body = {
  key: 'neptune',
  position: new THREE.Vector3(0, 0, -320),
  radius: PLANETS.neptune.radius,
}
const BODIES = [SUN, EARTH, MOON, MARS, JUPITER, NEPTUNE]

function input(overrides: Partial<ShipInput> = {}): ShipInput {
  return {
    throttle: 0,
    strafeX: 0,
    strafeY: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    level: false,
    flightAssist: true,
    boost: false,
    ...overrides,
  }
}

function env(bodies: readonly Body[], targetKey: string | null = null): FlightEnv {
  return { bodies, targetKey }
}

// The ticket's trip-time targets are set at this instant.
const TRIP_DATE = '2026-10-22T12:00:00Z'

/** Ship mode's real bodies (masses, flight scale), frozen at `date`. */
function flightBodies(date = TRIP_DATE, tier: QualityTier = 'high'): Body[] {
  const bodies = createShipBodies(tier)
  updateShipBodies(bodies, Date.parse(date))
  return bodies
}

// A ship at `position` with its nose on `target` and up as close to +Y as
// the heading allows (three's lookAt puts −Z on the target for cameras).
function shipAt(position: THREE.Vector3, target: THREE.Vector3): ShipState {
  const state = createShipState()
  state.position.copy(position)
  state.orientation.setFromRotationMatrix(
    new THREE.Matrix4().lookAt(position, target, Y)
  )
  return state
}

function noseOf(state: ShipState): THREE.Vector3 {
  return new THREE.Vector3(0, 0, -1).applyQuaternion(state.orientation)
}

function upOf(state: ShipState): THREE.Vector3 {
  return new THREE.Vector3(0, 1, 0).applyQuaternion(state.orientation)
}

function fly(
  state: ShipState,
  seconds: number,
  shipInput: ShipInput,
  flightEnv: FlightEnv,
  dt = FRAME
): ShipState {
  for (let t = 0; t < seconds - 1e-9; t += dt) stepShip(state, shipInput, dt, flightEnv)
  return state
}

describe('speedCap', () => {
  const body: Body = { key: 'b', position: new THREE.Vector3(), radius: 3 }
  const at = (gap: number) => new THREE.Vector3(body.radius + gap, 0, 0)

  test('is V_NORMAL close to a surface', () => {
    expect(speedCap(at(0.06), [body])).toBe(V_NORMAL)
    expect(speedCap(at(V_NORMAL / K_WELL), [body])).toBeCloseTo(V_NORMAL, 12)
  })

  test('grows with distance to the nearest surface, up to V_TOP', () => {
    const gaps = [1, 2, 5, 10, 50, 250]
    const caps = gaps.map((g) => speedCap(at(g), [body]))
    for (let i = 1; i < caps.length; i++) expect(caps[i]).toBeGreaterThan(caps[i - 1])
    expect(caps[caps.length - 1]).toBeCloseTo(K_WELL * 250, 9)
    expect(speedCap(at(V_TOP / K_WELL), [body])).toBeCloseTo(V_TOP, 9)
    expect(speedCap(at(2000), [body])).toBe(V_TOP)
  })

  test('uses the nearest body, not the first', () => {
    const near: Body = { key: 'near', position: new THREE.Vector3(10, 0, 0), radius: 1 }
    const p = new THREE.Vector3(14, 0, 0)
    expect(nearestBody(p, [body, near])?.body.key).toBe('near')
    expect(speedCap(p, [body, near])).toBeCloseTo(K_WELL * 3, 12)
  })

  test('weights each gap by its well: a heavy body slows the ship from further out', () => {
    // 100 units off a Sun-mass body against 20 off a Moon-mass one: the Sun's
    // gap counts as 100 / 11 ≈ 9, so the Sun sets the cap, not the nearer Moon.
    const sun: Body = { ...body, key: 'sun', mass: BODY_MASS_KG.sun }
    const moon: Body = {
      key: 'moon',
      position: new THREE.Vector3(103 + 21, 0, 0),
      radius: 1,
      mass: BODY_MASS_KG.moon,
    }
    const p = at(100)
    expect(nearestBody(p, [sun, moon])?.body.key).toBe('moon')
    expect(speedCap(p, [sun, moon])).toBeCloseTo((K_WELL * 100) / wellFactor(BODY_MASS_KG.sun), 9)
    expect(speedCap(p, [{ ...sun, mass: undefined }, moon])).toBeCloseTo(K_WELL * 20, 9)
  })

  test('is V_NORMAL with no bodies', () => {
    expect(nearestBody(new THREE.Vector3(), [])).toBeNull()
    expect(speedCap(new THREE.Vector3(1e6, 0, 0), [])).toBe(V_NORMAL)
  })
})

describe('wellFactor and wellTime', () => {
  test('is 1 at the Moon and for missing or unusable masses', () => {
    expect(wellFactor(BODY_MASS_KG.moon)).toBeCloseTo(1, 12)
    for (const mass of [undefined, 0, -1, NaN, Infinity, 1]) expect(wellFactor(mass)).toBe(1)
  })

  test('grows with mass: the Sun and Jupiter have the biggest wells, Mercury a small one', () => {
    const order = ['moon', 'mercury', 'mars', 'earth', 'neptune', 'saturn', 'jupiter', 'sun'] as const
    const factors = order.map((key) => wellFactor(BODY_MASS_KG[key]))
    for (let i = 1; i < factors.length; i++) expect(factors[i]).toBeGreaterThan(factors[i - 1])
    expect(wellFactor(BODY_MASS_KG.sun)).toBeCloseTo(11, 0)
    expect(wellFactor(BODY_MASS_KG.jupiter)).toBeCloseTo(4.15, 1)
    expect(wellFactor(BODY_MASS_KG.mercury)).toBeLessThan(1.3)
  })

  test('wellTime is wellFactor / K_WELL', () => {
    const jupiter: Body = { key: 'j', position: new THREE.Vector3(), radius: 6, mass: BODY_MASS_KG.jupiter }
    expect(wellTime(jupiter)).toBeCloseTo(wellFactor(BODY_MASS_KG.jupiter) / K_WELL, 12)
    expect(wellTime({ ...jupiter, mass: undefined })).toBe(1 / K_WELL)
  })
})

describe('velocityTau', () => {
  test('is quick in open space and heavy deep in a well', () => {
    expect(velocityTau(V_TOP)).toBeCloseTo(VELOCITY_TAU_OPEN, 12)
    expect(velocityTau(V_NORMAL)).toBeCloseTo(VELOCITY_TAU_WELL, 12)
    let previous = velocityTau(V_TOP)
    for (let cap = V_TOP / 2; cap > V_NORMAL; cap /= 2) {
      expect(velocityTau(cap)).toBeGreaterThan(previous)
      previous = velocityTau(cap)
    }
  })

  test('clamps out-of-range caps and never returns NaN', () => {
    expect(velocityTau(1e9)).toBe(VELOCITY_TAU_OPEN)
    expect(velocityTau(0)).toBe(VELOCITY_TAU_WELL)
    expect(velocityTau(-1)).toBe(VELOCITY_TAU_WELL)
    expect(velocityTau(NaN)).toBe(VELOCITY_TAU_WELL)
  })
})

describe('approachCap', () => {
  test('is surface distance over the ETA, floored at V_NORMAL', () => {
    expect(approachCap(195, 7)).toBeCloseTo(195 / 7, 12)
    expect(approachCap(195, 7, 1)).toBeCloseTo(195 / 8, 12)
    expect(approachCap(0.01, 2)).toBe(V_NORMAL)
    expect(approachCap(-1, 2)).toBe(V_NORMAL)
    expect(approachCap(0.01, 2, 0, 0.02)).toBe(0.02)
  })

  test("equals the cap when the target sets the well, at its wellTime", () => {
    const neptune: Body = {
      key: 'neptune',
      position: new THREE.Vector3(),
      radius: 5,
      mass: BODY_MASS_KG.neptune,
    }
    for (const gap of [10, 100, 400]) {
      const p = new THREE.Vector3(5 + gap, 0, 0)
      expect(approachCap(gap, wellTime(neptune))).toBeCloseTo(speedCap(p, [neptune]), 9)
    }
  })
})

describe('speedFraction', () => {
  test('is speed over cap, clamped to 0..1', () => {
    expect(speedFraction(0.3, 1.2)).toBeCloseTo(0.25, 12)
    expect(speedFraction(2, 1)).toBe(1)
    expect(speedFraction(0, 1)).toBe(0)
  })

  test('a zero or infinite cap gives a number, never NaN', () => {
    expect(speedFraction(0, 0)).toBe(0)
    expect(speedFraction(1, 0)).toBe(1)
    expect(speedFraction(1, Infinity)).toBe(0)
    expect(speedFraction(Infinity, Infinity)).toBe(0)
    expect(speedFraction(Infinity, 1)).toBe(1)
    expect(speedFraction(NaN, 1)).toBe(0)
  })
})

describe('turnRateMultiplier', () => {
  test('is 1 from rest to the top of the blue zone: no low-speed penalty', () => {
    for (let f = 0; f <= BLUE_ZONE[1] + 1e-9; f += 0.01) {
      expect(turnRateMultiplier(f)).toBe(1)
    }
  })

  test('falls to TURN_RATE_MIN_FACTOR at the cap, strictly decreasing above the band', () => {
    expect(turnRateMultiplier(1)).toBeCloseTo(TURN_RATE_MIN_FACTOR, 12)
    let previous = turnRateMultiplier(BLUE_ZONE[1])
    for (let f = BLUE_ZONE[1] + 0.005; f <= 1 + 1e-9; f += 0.005) {
      const m = turnRateMultiplier(f)
      expect(m).toBeLessThan(previous)
      expect(m).toBeGreaterThanOrEqual(TURN_RATE_MIN_FACTOR - 1e-12)
      previous = m
    }
  })

  test('is continuous with no kink at either end of the fall-off', () => {
    const h = 1e-6
    for (const edge of [BLUE_ZONE[1], 1]) {
      const below = turnRateMultiplier(edge - h)
      const above = turnRateMultiplier(edge + h)
      expect(Math.abs(above - below)).toBeLessThan(1e-9)
      // Slopes either side of the edge agree (both ~0 for a smoothstep).
      const left = (turnRateMultiplier(edge) - turnRateMultiplier(edge - h)) / h
      const right = (turnRateMultiplier(edge + h) - turnRateMultiplier(edge)) / h
      expect(Math.abs(left - right)).toBeLessThan(1e-4)
    }
    // No jumps anywhere in between.
    for (let f = 0; f < 1; f += 0.001) {
      expect(Math.abs(turnRateMultiplier(f + 0.001) - turnRateMultiplier(f))).toBeLessThan(0.01)
    }
  })

  test('out-of-range and non-finite fractions stay within the curve', () => {
    expect(turnRateMultiplier(-1)).toBe(1)
    expect(turnRateMultiplier(2)).toBeCloseTo(TURN_RATE_MIN_FACTOR, 12)
    expect(turnRateMultiplier(Infinity)).toBeCloseTo(TURN_RATE_MIN_FACTOR, 12)
    expect(turnRateMultiplier(NaN)).toBe(1)
  })
})

describe('Flight Assist on', () => {
  test('velocity converges to throttle × cap along the nose with a velocityTau e-fold', () => {
    // No bodies: the cap is V_NORMAL everywhere, so the target is fixed.
    const state = shipAt(new THREE.Vector3(), new THREE.Vector3(1, 2, -3))
    const target = noseOf(state).multiplyScalar(0.6 * V_NORMAL)

    fly(state, velocityTau(V_NORMAL), input({ throttle: 0.6 }), env([]))
    const remaining = state.velocity.distanceTo(target) / target.length()
    expect(remaining).toBeCloseTo(Math.exp(-1), 2)

    fly(state, 30, input({ throttle: 0.6 }), env([]))
    expect(state.velocity.distanceTo(target)).toBeLessThan(1e-4)
  })

  test('spools up freely in open space and heavily near mass', () => {
    // Time to 63% of full throttle from rest, far from a body (cap V_TOP)
    // and close to one (cap near V_NORMAL), flying tangentially so the cap
    // barely moves.
    const body: Body = { key: 'b', position: new THREE.Vector3(0, -1e4, 0), radius: 1 }
    const spoolTime = (height: number) => {
      const state = shipAt(new THREE.Vector3(0, height - 1e4, 0), new THREE.Vector3(0, height - 1e4, -1))
      const telemetry = createShipTelemetry()
      let t = 0
      do {
        stepShip(state, input({ throttle: 1 }), FRAME, env([body]), telemetry)
        t += FRAME
      } while (telemetry.speed / telemetry.speedCap < 1 - Math.exp(-1))
      return t
    }
    expect(spoolTime(1e4)).toBeCloseTo(VELOCITY_TAU_OPEN, 1)
    expect(spoolTime(2)).toBeGreaterThan(1.5)
  })

  test('cutting the throttle brings the ship to rest', () => {
    const state = shipAt(new THREE.Vector3(), new THREE.Vector3(0, 0, -1))
    fly(state, 5, input({ throttle: 1 }), env([]))
    fly(state, 40, input({ throttle: 0 }), env([]))
    expect(state.velocity.length()).toBeLessThan(1e-6)
  })

  test('rotation follows the stick and stops when it is released', () => {
    const state = createShipState()
    fly(state, 2, input({ pitch: 1, throttle: 0.6 }), env([]))
    expect(state.angularVelocity.x).toBeCloseTo(PITCH_RATE, 3)
    fly(state, 3, input({ throttle: 0.6 }), env([]))
    expect(state.angularVelocity.length()).toBeLessThan(1e-4)
  })

  test('strafe and reverse: +X moves right, +Y moves up, negative throttle backs up', () => {
    // Default orientation: nose −Z, right +X, up +Y.
    const right = fly(createShipState(), 3, input({ strafeX: 1 }), env([]))
    expect(right.velocity.x).toBeGreaterThan(0)
    expect(right.position.x).toBeGreaterThan(0)
    expect(Math.abs(right.velocity.y) + Math.abs(right.velocity.z)).toBeLessThan(1e-12)

    const raised = fly(createShipState(), 3, input({ strafeY: 1 }), env([]))
    expect(raised.velocity.y).toBeGreaterThan(0)
    expect(raised.position.y).toBeGreaterThan(0)

    const reversing = fly(createShipState(), 30, input({ throttle: -0.25 }), env([]))
    expect(reversing.velocity.z).toBeCloseTo(0.25 * V_NORMAL, 4)
    expect(reversing.position.z).toBeGreaterThan(0)
  })

  test('stick signs: pitch up, yaw right, roll right', () => {
    const pitched = fly(createShipState(), 0.5, input({ pitch: 1 }), env([]))
    expect(noseOf(pitched).y).toBeGreaterThan(0.1)
    const yawed = fly(createShipState(), 0.5, input({ yaw: 1 }), env([]))
    expect(noseOf(yawed).x).toBeGreaterThan(0.1)
    const rolled = fly(createShipState(), 0.5, input({ roll: 1 }), env([]))
    expect(upOf(rolled).x).toBeGreaterThan(0.1)
  })
})

describe('Flight Assist off', () => {
  // Far from everything, so the cap (~5000) never binds.
  const open = env([{ key: 'far', position: new THREE.Vector3(0, 1e4, 0), radius: 1 }])

  test('conserves momentum and spin with zero input', () => {
    const state = createShipState()
    state.velocity.set(3, -1, 2)
    state.angularVelocity.set(0.2, -0.1, 0.3)
    fly(state, 5, input({ flightAssist: false }), open)
    expect(state.velocity.toArray()).toEqual([3, -1, 2])
    expect(state.angularVelocity.toArray()).toEqual([0.2, -0.1, 0.3])
    expect(state.position.distanceTo(new THREE.Vector3(15, -5, 10))).toBeLessThan(1e-9)
  })

  test('thrust accelerates and the speed cap still applies', () => {
    const near = env([SUN])
    const state = shipAt(new THREE.Vector3(30, 0, 0), new THREE.Vector3(1000, 0, 0))
    const telemetry = createShipTelemetry()
    let previous = 0
    for (let i = 0; i < 600; i++) {
      stepShip(state, input({ throttle: 1, flightAssist: false }), FRAME, near, telemetry)
      expect(telemetry.speed).toBeLessThanOrEqual(telemetry.speedCap + 1e-9)
      if (i < 30) expect(telemetry.speed).toBeGreaterThan(previous)
      previous = telemetry.speed
    }
  })
})

describe('turn rates', () => {
  test('full stick turns further in pitch and roll than in yaw', () => {
    const turned = (stick: Partial<ShipInput>) => {
      const state = fly(createShipState(), 1, input({ ...stick, throttle: 0.6 }), env([]))
      return 2 * Math.acos(Math.min(1, Math.abs(state.orientation.w)))
    }
    const yaw = turned({ yaw: 1 })
    expect(turned({ pitch: 1 })).toBeGreaterThan(yaw)
    expect(turned({ roll: 1 })).toBeGreaterThan(yaw)
  })

  // Settle at `throttle` (FA on, no bodies, so the cap is V_NORMAL), then hold
  // full stick on `stick` and read the steady body rate.
  function settledRates(throttle: number, stick: Partial<ShipInput>): THREE.Vector3 {
    const state = fly(createShipState(), 20, input({ throttle }), env([]))
    fly(state, 2, input({ ...stick, throttle }), env([]))
    return state.angularVelocity.clone()
  }

  test('full rate from rest through the blue zone, TURN_RATE_MIN_FACTOR at full throttle', () => {
    for (const throttle of [0, 0.25, BLUE_ZONE[0], 0.7]) {
      expect(Math.abs(settledRates(throttle, { yaw: 1 }).y)).toBeCloseTo(YAW_RATE, 3)
    }
    // Yawing at the cap swings the velocity off the nose, so the speed (and
    // with it the penalty) sits a hair under the cap's: within 2%.
    const full = Math.abs(settledRates(1, { yaw: 1 }).y)
    expect(full / YAW_RATE).toBeGreaterThan(TURN_RATE_MIN_FACTOR - 1e-9)
    expect(full / YAW_RATE).toBeLessThan(TURN_RATE_MIN_FACTOR + 0.02)
    expect(Math.abs(settledRates(1, { pitch: 1 }).x) / PITCH_RATE).toBeLessThan(
      TURN_RATE_MIN_FACTOR + 0.02
    )
    expect(Math.abs(settledRates(1, { roll: 1 }).z) / ROLL_RATE).toBeCloseTo(
      TURN_RATE_MIN_FACTOR,
      3
    )
  })

  test('keys off speed, not throttle: FA off, coasting at the cap turns slowly', () => {
    const coasting = (speed: number) => {
      const state = createShipState()
      state.velocity.set(0, 0, -speed)
      // A tenth of a second of full yaw from still, FA off: the rate builds
      // at demand / ROTATION_TAU, well short of the raw clamp.
      fly(state, 0.1, input({ yaw: 1, throttle: 0, flightAssist: false }), env([]))
      return Math.abs(state.angularVelocity.y)
    }
    expect(coasting(V_NORMAL) / coasting(0)).toBeCloseTo(TURN_RATE_MIN_FACTOR, 6)
  })

  test('FA off still clamps to the raw max rate, so speeding up never brakes a spin', () => {
    const state = createShipState()
    fly(state, 3, input({ yaw: 1, flightAssist: false }), env([]))
    expect(state.angularVelocity.y).toBeCloseTo(-YAW_RATE, 12)
    fly(state, 10, input({ throttle: 1, flightAssist: false }), env([]))
    expect(state.angularVelocity.y).toBeCloseTo(-YAW_RATE, 12)
  })
})

describe('level', () => {
  function rolledShip(): ShipState {
    const state = shipAt(new THREE.Vector3(), new THREE.Vector3(3, 2, -4))
    // Roll 130° about the nose.
    state.orientation.multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 2.27)
    )
    return state
  }

  function levelError(state: ShipState): number {
    const nose = noseOf(state)
    const want = Y.clone().addScaledVector(nose, -nose.y).normalize()
    return upOf(state).angleTo(want)
  }

  test.each([true, false])('rolls up to +Y projected off the nose (FA %s)', (fa) => {
    const state = rolledShip()
    const nose = noseOf(state)
    expect(levelError(state)).toBeGreaterThan(2)
    fly(state, 4, input({ level: true, flightAssist: fa }), env([]))
    expect(levelError(state)).toBeLessThan(0.01)
    // Roll only: the nose has not moved.
    expect(noseOf(state).angleTo(nose)).toBeLessThan(1e-6)
  })

  test('at full throttle it rolls exactly as at rest: no wide-turn penalty', () => {
    const atRest = fly(rolledShip(), 0.5, input({ level: true }), env([]))
    // Up to the cap first (no bodies: V_NORMAL), so the speed fraction is ~1.
    const fast = fly(rolledShip(), 20, input({ throttle: 1 }), env([]))
    expect(fast.velocity.length() / V_NORMAL).toBeGreaterThan(0.999)
    fly(fast, 0.5, input({ level: true, throttle: 1 }), env([]))
    expect(levelError(fast)).toBeCloseTo(levelError(atRest), 9)
    fly(fast, 3.5, input({ level: true, throttle: 1 }), env([]))
    expect(levelError(fast)).toBeLessThan(0.01)
  })

  test('is a no-op with the nose on the pole', () => {
    const state = shipAt(new THREE.Vector3(), new THREE.Vector3(0, 1, 0))
    fly(state, 1, input({ level: true }), env([]))
    expect(state.angularVelocity.length()).toBe(0)
    expect(Number.isFinite(state.orientation.w)).toBe(true)
  })
})

function closingSpeed(state: ShipState, body: Body): number {
  return state.velocity.dot(body.position.clone().sub(state.position).normalize())
}

describe('target approach', () => {
  test('speed toward the target never exceeds max(V_NORMAL, gap / wellTime) and it lands without passing inside', () => {
    const start = EARTH.position.clone().add(new THREE.Vector3(-40, 0, 0))
    const state = shipAt(start, EARTH.position)
    const telemetry = createShipTelemetry()
    const shell = EARTH.radius * COLLISION_MARGIN
    let previous = Infinity
    let hits = 0
    for (let i = 0; i < 60 * 60; i++) {
      stepShip(state, input({ throttle: 1 }), FRAME, env(BODIES, 'earth'), telemetry)
      const gap = telemetry.target!.surfaceDistance
      expect(closingSpeed(state, EARTH)).toBeLessThanOrEqual(
        Math.max(V_NORMAL, gap / wellTime(EARTH)) + 1e-12
      )
      expect(gap).toBeLessThanOrEqual(previous + 1e-12)
      expect(state.position.distanceTo(EARTH.position)).toBeGreaterThanOrEqual(shell - 1e-9)
      if (telemetry.colliding) hits++
      previous = gap
    }
    expect(telemetry.target!.surfaceDistance).toBeCloseTo(shell - EARTH.radius, 9)
    // Touchdown counts once; pressing into the surface afterwards does not.
    expect(hits).toBe(1)
  })

  test.each([EARTH, MOON])('leaving a locked $key is as fast as leaving it untargeted', (body) => {
    // From rest on the collision shell, nose straight up (away from the
    // body), to a 15-unit gap.
    const departure = (targetKey: string | null) => {
      const start = body.position.clone().add(new THREE.Vector3(0, body.radius * COLLISION_MARGIN, 0))
      const state = shipAt(start, start.clone().add(Y))
      let t = 0
      while (state.position.distanceTo(body.position) - body.radius < 15 && t < 120) {
        stepShip(state, input({ throttle: 1 }), FRAME, env(BODIES, targetKey))
        t += FRAME
      }
      return t
    }
    const untargeted = departure(null)
    const targeted = departure(body.key)
    console.log(
      `Leave ${body.key} to a 15-unit gap: ${targeted.toFixed(2)} s targeted, ${untargeted.toFixed(2)} s untargeted`
    )
    expect(untargeted).toBeLessThan(15)
    expect(targeted).toBeCloseTo(untargeted, 6)
  })

  test("reports the target's wellTime as the ETA while at its cap", () => {
    // Alone with a Neptune-mass body, inside its well (cap below V_TOP).
    const neptune: Body = { ...NEPTUNE, mass: BODY_MASS_KG.neptune }
    const start = neptune.position.clone().add(new THREE.Vector3(0, 0, 700))
    const state = shipAt(start, neptune.position)
    const telemetry = createShipTelemetry()
    for (let i = 0; i < 10 * 60; i++) {
      stepShip(state, input({ throttle: 1 }), FRAME, env([neptune], 'neptune'), telemetry)
    }
    expect(telemetry.speedCap).toBeLessThan(V_TOP)
    expect(telemetry.target!.etaSeconds).toBeGreaterThan(wellTime(neptune) - 0.1)
    expect(telemetry.target!.etaSeconds).toBeLessThan(wellTime(neptune) + 0.1)
  })
})

describe('collision', () => {
  // Deterministic LCG so failures reproduce.
  function random(seed: number): () => number {
    let s = seed
    return () => {
      s = (s * 1664525 + 1013904223) % 2 ** 32
      return s / 2 ** 32
    }
  }

  test.each([
    ['test layout', BODIES, ['earth', 'moon', 'sun']],
    ['flight bodies', flightBodies(), ['earth', 'moon', 'sun', 'jupiter']],
  ] as const)('the ship never ends a step inside any body, for any input or dt (%s)', (_, bodies, keys) => {
    const rand = random(7)
    const dts = [FRAME, 0.05, MAX_DT, 0.5, 5, 1e6, Infinity, NaN, -1, 0]
    const telemetry = createShipTelemetry()
    for (const key of keys) {
      const body = bodies.find((b) => b.key === key)!
      for (let run = 0; run < 20; run++) {
        const start = body.position
          .clone()
          .add(
            new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5)
              .normalize()
              .multiplyScalar(Math.max(collisionRadius(body), body.radius * (1.05 + 3 * rand())))
          )
        const state = shipAt(start, body.position)
        // Some runs start already moving absurdly fast at the body.
        if (run % 2) state.velocity.subVectors(body.position, start).setLength(1e6)
        for (let i = 0; i < 400; i++) {
          const fa = rand() < 0.5
          stepShip(
            state,
            input({
              throttle: rand() < 0.7 ? 1 : -0.25,
              strafeX: rand() * 2 - 1,
              strafeY: rand() * 2 - 1,
              pitch: rand() * 2 - 1,
              yaw: rand() * 2 - 1,
              roll: rand() * 2 - 1,
              flightAssist: fa,
            }),
            dts[i % dts.length],
            env(bodies),
            telemetry
          )
          for (const b of bodies) {
            expect(state.position.distanceTo(b.position)).toBeGreaterThanOrEqual(
              collisionRadius(b) * (1 - 1e-12)
            )
          }
          expect(state.position.toArray().every(Number.isFinite)).toBe(true)
          expect(telemetry.speed).toBeLessThanOrEqual(OVERSPEED_MAX * telemetry.speedCap + 1e-9)
        }
      }
    }
    // ~2 s alone with the moons' wells; the parallel suite can push it past 5 s.
  }, 20_000)

  test('a step covers at most 20% of the mass-weighted gap, so it cannot tunnel', () => {
    // |v| ≤ OVERSPEED_MAX · cap and cap ≤ K_WELL · gap / wellFactor (≥ 1).
    expect(OVERSPEED_MAX * K_WELL * MAX_DT).toBeLessThanOrEqual(0.2)
    expect(wellFactor(undefined)).toBeGreaterThanOrEqual(1)
  })

  test('defaults the hard sphere to radius × COLLISION_MARGIN', () => {
    expect(collisionRadius(MOON)).toBe(MOON.radius * COLLISION_MARGIN)
    expect(collisionRadius({ ...MOON, collisionRadius: 1.5 })).toBe(1.5)
  })

  test("stops at a body's own collisionRadius, flying straight in at full throttle", () => {
    const shelled: Body = { ...EARTH, collisionRadius: EARTH.radius * 1.2 }
    const start = shelled.position.clone().add(new THREE.Vector3(0, 0, 30))
    for (const targetKey of [null, 'earth']) {
      const state = shipAt(start, shelled.position)
      const telemetry = createShipTelemetry()
      for (let i = 0; i < 60 * 60; i++) {
        stepShip(state, input({ throttle: 1 }), FRAME, env([shelled], targetKey), telemetry)
        expect(state.position.distanceTo(shelled.position)).toBeGreaterThanOrEqual(
          shelled.collisionRadius! * (1 - 1e-12)
        )
      }
      expect(state.position.distanceTo(shelled.position)).toBeCloseTo(shelled.collisionRadius!, 9)
    }
  })

  test('pushes out along the normal, drops inward velocity and flags colliding', () => {
    const state = createShipState()
    state.position.set(EARTH.position.x - EARTH.radius, 0, 0.5)
    state.velocity.set(0.1, 0, 0.05)
    const telemetry = createShipTelemetry()
    stepShip(state, input({ flightAssist: false }), FRAME, env([EARTH]), telemetry)
    expect(telemetry.colliding).toBe(true)
    const normal = state.position.clone().sub(EARTH.position).normalize()
    expect(state.position.distanceTo(EARTH.position)).toBeCloseTo(
      EARTH.radius * COLLISION_MARGIN,
      9
    )
    expect(state.velocity.dot(normal)).toBeGreaterThanOrEqual(-1e-12)
    expect(state.velocity.length()).toBeGreaterThan(0)
  })

  test.each([FRAME, MAX_DT])('resting on or thrusting into a surface is not a hit (dt %s)', (dt) => {
    // Nose straight at Earth's centre, so thrust is purely into the surface.
    const start = EARTH.position.clone().add(new THREE.Vector3(0, 0, EARTH.radius * COLLISION_MARGIN))
    for (const throttle of [0, 1]) {
      const state = shipAt(start, EARTH.position)
      const telemetry = createShipTelemetry()
      for (let i = 0; i < 300; i++) {
        stepShip(state, input({ throttle }), dt, env([EARTH]), telemetry)
        expect(telemetry.colliding).toBe(false)
      }
      expect(state.position.distanceTo(start)).toBeLessThan(1e-9)
    }
    for (const throttle of [0, 1]) {
      const state = shipAt(start, EARTH.position)
      const telemetry = createShipTelemetry()
      for (let i = 0; i < 300; i++) {
        stepShip(state, input({ throttle, flightAssist: false }), dt, env([EARTH]), telemetry)
        expect(telemetry.colliding).toBe(false)
      }
    }
  })
})

describe('ground (tides-01v.8.3)', () => {
  // A unit rock at the origin whose ground rises `rise` over `width` radians
  // of longitude east of φ = 0 (a cliff when width is 0).
  const CLEARANCE = 0.01
  function rock(rise: number, width: number, collision = 1): Body {
    return {
      key: 'rock',
      position: new THREE.Vector3(),
      radius: 1,
      collisionRadius: collision,
      ground: (direction) => {
        const phi = Math.atan2(direction.z, direction.x)
        return 1 + rise * (width > 0 ? THREE.MathUtils.clamp(phi / width, 0, 1) : phi >= 0 ? 1 : 0)
      },
      groundClearance: CLEARANCE,
    }
  }
  const along = (phi: number) => new THREE.Vector3(Math.cos(phi), 0, Math.sin(phi))
  const longitude = (p: THREE.Vector3) => Math.atan2(p.z, p.x)

  test('the stop is groundClearance above the ground, clamped to collisionRadius', () => {
    const body = rock(0.2, 0.5)
    expect(floorRadius(body, along(-0.3))).toBeCloseTo(1 + CLEARANCE, 12)
    expect(floorRadius(body, along(0.25))).toBeCloseTo(1.1 + CLEARANCE, 12)
    const clamped = rock(0.2, 0.5, 1.5)
    for (const phi of [-0.3, 0.25, 1]) expect(floorRadius(clamped, along(phi))).toBe(1.5)
    expect(floorRadius(MOON, along(0))).toBe(collisionRadius(MOON))
    expect(floorRadius({ ...body, ground: () => NaN }, along(0))).toBe(1)
  })

  test.each([
    ['a slope', 0.1, 0.2],
    ['a cliff', 0.05, 0],
  ])('slides up %s at the speed floor without entering it', (_, rise, width) => {
    const body = rock(rise, width)
    // Pressed 30° into the ground and heading east across the rise.
    const start = along(-0.1).multiplyScalar(floorRadius(body, along(-0.1)))
    const tangent = new THREE.Vector3(-Math.sin(0.05), 0, Math.cos(0.05))
    const nose = tangent.clone().addScaledVector(along(0.05), -Math.tan(Math.PI / 6))
    const state = shipAt(start, start.clone().add(nose))
    const telemetry = createShipTelemetry()
    const direction = new THREE.Vector3()
    for (let i = 0; i < 40 / MAX_DT; i++) {
      stepShip(state, input({ throttle: 1 }), MAX_DT, env([body]), telemetry)
      direction.copy(state.position).normalize()
      expect(state.position.length()).toBeGreaterThanOrEqual(floorRadius(body, direction) * (1 - 1e-12))
      expect(telemetry.speed).toBeLessThanOrEqual(OVERSPEED_MAX * V_NORMAL + 1e-9)
      if (longitude(state.position) > 0.3) break
    }
    // Over the top and resting on it, not stuck at the foot.
    expect(longitude(state.position)).toBeGreaterThan(0.3)
    expect(state.position.length()).toBeCloseTo(1 + rise + CLEARANCE, 6)
    expect(telemetry.speedCap).toBe(V_NORMAL)
  })

  test('diving straight in stops on the floor and flags the hit', () => {
    const body = rock(0.1, 0.2)
    const start = along(0.3).multiplyScalar(3)
    const state = shipAt(start, body.position)
    const telemetry = createShipTelemetry()
    let hit = false
    for (let i = 0; i < 60 * 60; i++) {
      stepShip(state, input({ throttle: 1 }), FRAME, env([body]), telemetry)
      expect(state.position.length()).toBeGreaterThanOrEqual((1.1 + CLEARANCE) * (1 - 1e-12))
      hit ||= telemetry.colliding
    }
    expect(state.position.length()).toBeCloseTo(1.1 + CLEARANCE, 9)
    expect(hit).toBe(true)
  })

  test.each([0, NaN, -1])('clamps to ground that rose under a still ship even on a %s step (tides-zmw.9.8)', (dt) => {
    let rise = 0
    const body: Body = { ...rock(0, 0), ground: () => 1 + rise }
    const state = shipAt(along(0.1).multiplyScalar(1 + CLEARANCE), new THREE.Vector3())
    rise = 0.05
    const velocity = state.velocity.set(0.01, 0, 0).clone()
    const orientation = state.orientation.clone()
    stepShip(state, input({ throttle: 1, pitch: 1 }), dt, env([body]))
    expect(state.position.length()).toBeCloseTo(1.05 + CLEARANCE, 12)
    // Nothing else moved: no thrust, turn or ride on a zero step.
    expect(state.orientation.equals(orientation)).toBe(true)
    expect(state.velocity.equals(velocity)).toBe(true)
  })

  test('settleShip only puts the ship back over the ground', () => {
    let rise = 0
    const body: Body = { ...rock(0, 0), ground: () => 1 + rise }
    const state = shipAt(along(0.1).multiplyScalar(1.2), new THREE.Vector3())
    state.velocity.set(0, -0.3, 0)
    const before = state.position.clone()
    expect(settleShip(state, env([body]))).toBe(false)
    expect(state.position.equals(before)).toBe(true)
    rise = 0.3
    // Moving into it faster than COLLISION_SPEED: a hit, the inward speed dropped.
    state.velocity.copy(along(0.1).multiplyScalar(-0.3))
    expect(settleShip(state, env([body]))).toBe(true)
    expect(state.position.length()).toBeCloseTo(1.3 + CLEARANCE, 12)
    expect(state.velocity.length()).toBeCloseTo(0, 12)
  })

  test('gaps and the speed cap measure from the ground under the ship', () => {
    const body = rock(0.3, 0.2)
    const position = along(0.5).multiplyScalar(4)
    const sphere: Body = { key: 'sphere', position: new THREE.Vector3(), radius: 1.3 }
    expect(nearestBody(position, [body])!.surfaceDistance).toBeCloseTo(4 - 1.3, 12)
    expect(speedCap(position, [body])).toBe(speedCap(position, [sphere]))
    const telemetry = createShipTelemetry()
    stepShip(shipAt(position, body.position), input(), 0, env([body], 'rock'), telemetry)
    expect(telemetry.nearest.surfaceDistance).toBeCloseTo(4 - 1.3, 12)
    expect(telemetry.target!.surfaceDistance).toBeCloseTo(4 - 1.3, 12)
  })
})

describe("Earth's floor (tides-01v.8.7)", () => {
  test('speedFloor is minSpeed when it is a usable speed under V_NORMAL, else V_NORMAL', () => {
    expect(speedFloor(MOON)).toBe(V_NORMAL)
    expect(speedFloor({ ...MOON, minSpeed: 0.02 })).toBe(0.02)
    for (const minSpeed of [0, -1, NaN, 2 * V_NORMAL]) expect(speedFloor({ ...MOON, minSpeed })).toBe(V_NORMAL)
  })

  // Straight down at Earth from `gap` over its ground, unlocked, until it
  // rests on the floor; then straight back up for `climb` seconds.
  function dive(tier: QualityTier, throttle: number, gap = 3, climb = 0) {
    const bodies = flightBodies(TRIP_DATE, tier)
    const earth = bodies.find((b) => b.key === 'earth')!
    const up = new THREE.Vector3(0.3, 1, -0.2).normalize()
    const start = earth.position.clone().addScaledVector(up, earth.ground!(up) + gap)
    const state = shipAt(start, earth.position)
    const telemetry = createShipTelemetry()
    let seconds = 0
    let peakShare = 0
    let peakSpeed = 0
    let lowest = Infinity
    const direction = new THREE.Vector3()
    for (; seconds < 600; seconds += FRAME) {
      stepShip(state, input({ throttle }), FRAME, env(bodies), telemetry)
      const d = direction.subVectors(state.position, earth.position).length()
      direction.divideScalar(d)
      lowest = Math.min(lowest, d - floorRadius(earth, direction))
      peakShare = Math.max(peakShare, telemetry.speed / telemetry.speedCap)
      peakSpeed = Math.max(peakSpeed, telemetry.speed)
      if (telemetry.speed < 1e-3 && d - floorRadius(earth, direction) < 1e-9) break
    }
    const altitude = state.position.distanceTo(earth.position) - earth.radius
    // Predicted from rest at the cap all the way (the spool-up aside).
    const ground = { law: earth.groundSpeed!, stop: earth.groundClearance!, base: altitude - telemetry.nearest.surfaceDistance }
    const eta = approachEta(gap, 1e9, wellTime(earth), throttle, speedFloor(earth), ground)
    const landed = { seconds, gap: telemetry.nearest.surfaceDistance, altitude, cap: telemetry.speedCap, eta }
    state.orientation.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI))
    fly(state, climb, input({ throttle }), env(bodies))
    const height = state.position.distanceTo(earth.position) - earth.ground!(direction.subVectors(state.position, earth.position).normalize())
    return { landed, peakShare, peakSpeed, lowest, height }
  }

  test.each([1, 0.3])('a dive at throttle %s from orbit comes to rest on the floor, never under it', (throttle) => {
    const { landed, peakShare, lowest } = dive('high', throttle)
    expect(lowest).toBeGreaterThanOrEqual(-1e-9)
    expect(landed.gap).toBeCloseTo(EARTH_GROUND_CLEARANCE, 6)
    // The air's floor at the stop, with or without the tiles (tides-zmw.9.29).
    expect(landed.cap).toBeCloseTo(lawFloor(EARTH_GROUND_SPEED_LAW, landed.gap, landed.altitude), 12)
    // Rides the well and the air down without the approach warning's overshoot.
    expect(peakShare).toBeLessThan(1.5)
    // Most of it in the air (~70 s at full throttle, over 3 min at 0.3), as approachEta has it.
    expect(landed.seconds).toBeGreaterThan(0.95 * landed.eta)
    expect(landed.seconds).toBeLessThan(1.1 * landed.eta + 3)
  })

  // The deck's tallest tops over the ground under them.
  const DECK = CLOUD_LAYER_TOP - TERRAIN_DISPLACEMENT * TERRAIN_MAX_GREY

  // At the air's speed now (tides-zmw.9.29): ~1,300 km/h through the deck.
  test('crosses the cloud deck in tens of seconds, not frames', () => {
    const { landed } = dive('high', 1, DECK)
    expect(landed.seconds).toBeGreaterThan(10)
    expect(landed.seconds).toBeGreaterThan(0.95 * landed.eta)
    expect(landed.seconds).toBeLessThan(1.1 * landed.eta + 3)
  })

  test('climbs back out of the deck at full throttle within seconds', () => {
    // Over the deck's tallest tops in 8 s, the low tier's stop in 15.
    expect(dive('high', 1, DECK, 8).height).toBeGreaterThan(DECK)
    expect(dive('high', 1, DECK, 15).height).toBeGreaterThan(EARTH_COLLISION_RADIUS - EARTH_RADIUS)
  })

  test.each([true, false])('a locked dive at Earth never goes over the cap (FA %s)', (flightAssist) => {
    const bodies = flightBodies()
    const earth = bodies.find((b) => b.key === 'earth')!
    const state = shipAt(earth.position.clone().add(new THREE.Vector3(0, 0, 6)), earth.position)
    const telemetry = createShipTelemetry()
    let peak = 0
    for (let i = 0; i < 60 * 60; i++) {
      stepShip(state, input({ throttle: 1, flightAssist }), FRAME, env(bodies, 'earth'), telemetry)
      peak = Math.max(peak, telemetry.speed / telemetry.speedCap)
    }
    expect(telemetry.nearest.surfaceDistance).toBeCloseTo(EARTH_GROUND_CLEARANCE, 6)
    expect(peak).toBeLessThanOrEqual(1 + 1e-6)
  })

  test('the low tier still stops at EARTH_COLLISION_RADIUS', () => {
    const bodies = flightBodies(TRIP_DATE, 'low')
    const earth = bodies.find((b) => b.key === 'earth')!
    const state = shipAt(earth.position.clone().add(new THREE.Vector3(0, 0, 4)), earth.position)
    fly(state, 30, input({ throttle: 1 }), env(bodies))
    expect(state.position.distanceTo(earth.position)).toBeCloseTo(EARTH_COLLISION_RADIUS, 9)
  })
})

describe('dt', () => {
  test('long frames are clamped to MAX_DT', () => {
    const a = shipAt(new THREE.Vector3(0, 0, 100), SUN.position)
    const b = shipAt(new THREE.Vector3(0, 0, 100), SUN.position)
    stepShip(a, input({ throttle: 1, pitch: 0.5 }), 10, env(BODIES))
    stepShip(b, input({ throttle: 1, pitch: 0.5 }), MAX_DT, env(BODIES))
    expect(a.position.toArray()).toEqual(b.position.toArray())
    expect(a.orientation.toArray()).toEqual(b.orientation.toArray())
  })
})

describe('telemetry', () => {
  test('reports the body whose well sets the cap, which can be other than the nearest', () => {
    // As in speedCap: 100 units off a Sun-mass body, 20 off a Moon-mass one.
    const sun: Body = { key: 'sun', position: new THREE.Vector3(), radius: 3, mass: BODY_MASS_KG.sun }
    const moon: Body = {
      key: 'moon',
      position: new THREE.Vector3(124, 0, 0),
      radius: 1,
      mass: BODY_MASS_KG.moon,
    }
    const state = createShipState()
    state.position.set(103, 0, 0)
    const telemetry = createShipTelemetry()
    stepShip(state, input(), FRAME, env([sun, moon]), telemetry)
    expect(telemetry.nearest.key).toBe('moon')
    expect(telemetry.well.key).toBe('sun')
    expect(telemetry.well.factor).toBe(wellFactor(BODY_MASS_KG.sun))
    expect(telemetry.well.floor).toBe(V_NORMAL)

    stepShip(state, input(), FRAME, env([]), telemetry)
    expect(telemetry.well).toEqual({ key: null, factor: 1, floor: V_NORMAL })
  })

  test('reports the clamped throttle it flew with', () => {
    const telemetry = createShipTelemetry()
    stepShip(createShipState(), input({ throttle: -3 }), FRAME, env([]), telemetry)
    expect(telemetry.throttle).toBe(-0.25)
    stepShip(createShipState(), input({ throttle: 7 }), FRAME, env([]), telemetry)
    expect(telemetry.throttle).toBe(1)
  })

  test('reports nearest, target and the input it flew with', () => {
    const state = shipAt(EARTH.position.clone().add(new THREE.Vector3(0, 0, -15)), NEPTUNE.position)
    const telemetry = createShipTelemetry()
    stepShip(state, input({ throttle: 0.5 }), FRAME, env(BODIES, 'neptune'), telemetry)
    expect(telemetry.nearest.key).toBe('earth')
    expect(telemetry.nearest.surfaceDistance).toBeCloseTo(15 - EARTH.radius, 1)
    expect(telemetry.target?.key).toBe('neptune')
    expect(telemetry.throttle).toBe(0.5)
    expect(telemetry.flightAssist).toBe(true)
    expect(telemetry.velocity.toArray()).toEqual(state.velocity.toArray())

    stepShip(state, input(), FRAME, env(BODIES), telemetry)
    expect(telemetry.target).toBeNull()
  })
})

function expectFinite(state: ShipState, telemetry: ShipTelemetry): void {
  for (const v of [state.position, state.velocity, state.angularVelocity]) {
    expect(v.toArray().every(Number.isFinite)).toBe(true)
  }
  expect(state.orientation.toArray().every(Number.isFinite)).toBe(true)
  expect(Number.isFinite(telemetry.speed)).toBe(true)
  expect(telemetry.speedCap).toBeGreaterThanOrEqual(V_NORMAL)
  expect(telemetry.speedCap).toBeLessThanOrEqual(V_TOP)
}

describe('degenerate geometry', () => {
  test('a ship at a body centre is pushed out with finite state', () => {
    const state = createShipState()
    state.position.copy(EARTH.position)
    const telemetry = createShipTelemetry()
    stepShip(state, input({ throttle: 1 }), FRAME, env(BODIES, 'earth'), telemetry)
    expectFinite(state, telemetry)
    expect(state.position.distanceTo(EARTH.position)).toBeCloseTo(collisionRadius(EARTH), 9)
  })

  test('coincident bodies and a NaN mass leave the cap finite', () => {
    const twin: Body = { ...MOON, key: 'twin', position: MOON.position.clone(), mass: NaN }
    const state = shipAt(MOON.position.clone().add(new THREE.Vector3(0, 5, 0)), MOON.position)
    const telemetry = createShipTelemetry()
    for (let i = 0; i < 600; i++) {
      stepShip(state, input({ throttle: 1 }), FRAME, env([MOON, twin], 'twin'), telemetry)
      expectFinite(state, telemetry)
    }
    expect(state.position.distanceTo(MOON.position)).toBeGreaterThanOrEqual(
      collisionRadius(MOON) * (1 - 1e-12)
    )
  })

  test.each([0, NaN])('a first frame with dt %s fills finite telemetry without moving', (dt) => {
    const state = shipAt(new THREE.Vector3(0, 0, 100), SUN.position)
    const telemetry = createShipTelemetry()
    stepShip(state, input({ throttle: 1 }), dt, env(BODIES, 'sun'), telemetry)
    expectFinite(state, telemetry)
    expect(state.position.toArray()).toEqual([0, 0, 100])
    expect(telemetry.speed).toBe(0)
    expect(telemetry.target?.etaSeconds).toBe(Infinity)
  })
})

// Trips at tides-2hv.6's flight scale (1000 units per AU) between the real
// flight bodies, frozen at TRIP_DATE: over a 5-minute trip Earth moves ~0.06
// units. Start from rest 15 units from Earth's centre (about the spawn
// distance) with the nose on the target, full throttle, FA on; arrived one
// target radius off its surface, where it spans 60° of the view.
interface Trip {
  seconds: number
  peakSpeed: number
  /** speed / cap at arrival. */
  arrivalFraction: number
  /** Highest speed / cap on the way. */
  peakFraction: number
  /** A collision before arriving. */
  hit: boolean
  /** Every body whose well set the cap on the way. */
  wells: Set<string>
}

function trip(
  key: string,
  { date = TRIP_DATE, locked = true, limit = 600, dt = FRAME } = {}
): Trip {
  const bodies = flightBodies(date)
  const earth = bodies.find((b) => b.key === 'earth')!
  const target = bodies.find((b) => b.key === key)!
  const heading = target.position.clone().sub(earth.position).normalize()
  // The Moon is ~10 units from Earth's centre: start off to the side of the
  // Earth → Moon line rather than on it, so the path stays clear of Earth.
  const offset = key === 'moon' ? heading.clone().cross(Y).normalize() : heading
  const state = shipAt(earth.position.clone().addScaledVector(offset, 15), target.position)
  const telemetry = createShipTelemetry()
  const flightEnv = env(bodies, locked ? key : null)
  const result: Trip = {
    seconds: 0,
    peakSpeed: 0,
    arrivalFraction: 0,
    peakFraction: 0,
    hit: false,
    wells: new Set(),
  }
  let gap: number
  do {
    stepShip(state, input({ throttle: 1 }), dt, flightEnv, telemetry)
    result.seconds += dt
    expectFinite(state, telemetry)
    gap = state.position.distanceTo(target.position) - target.radius
    const fraction = telemetry.speed / telemetry.speedCap
    result.peakSpeed = Math.max(result.peakSpeed, telemetry.speed)
    result.peakFraction = Math.max(result.peakFraction, fraction)
    result.arrivalFraction = fraction
    if (telemetry.colliding) result.hit = true
    if (telemetry.well.key) result.wells.add(telemetry.well.key)
  } while (gap > target.radius && result.seconds < limit)
  return result
}

// Jupiter's band is checked two days after TRIP_DATE, when the Earth →
// Jupiter line runs clear of its moons (tides-2hv.8): it passes 10+ units off
// every Galilean's shell, and Jupiter is as far as at TRIP_DATE. At
// TRIP_DATE itself the line runs through Callisto (18.6 units out from
// Jupiter): Callisto's well takes over ~18 units short and the locked ship
// crawls through it at the V_NORMAL floor, ~20 s longer than the open
// approach the band was set for (130 s against 109 s with no moons). The
// moons' phases change the trip by tens of seconds from day to day, so the
// band is for the open approach; crossing a moon system is tested on its own
// below.
const JUPITER_TRIP_DATE = '2026-10-24T12:00:00Z'

const GALILEANS = ['io', 'europa', 'ganymede', 'callisto'] as const

// How far the straight Earth → Jupiter trip (from 15 units out of Earth to
// one Jupiter radius off its surface, as trip() flies it) passes from each
// Galilean's collision shell at `date`; negative runs through it. The
// pinned dates above depend on the moons' phases, so a [TUNE] change to the
// log map or the moons' radii shows up here first.
function galileanMisses(date: string): Record<(typeof GALILEANS)[number], number> {
  const bodies = flightBodies(date)
  const earth = bodies.find((b) => b.key === 'earth')!
  const jupiter = bodies.find((b) => b.key === 'jupiter')!
  const heading = jupiter.position.clone().sub(earth.position).normalize()
  const line = new THREE.Line3(
    earth.position.clone().addScaledVector(heading, 15),
    jupiter.position.clone().addScaledVector(heading, -2 * jupiter.radius)
  )
  const closest = new THREE.Vector3()
  return Object.fromEntries(
    GALILEANS.map((key) => {
      const moon = bodies.find((b) => b.key === key)!
      line.closestPointToPoint(moon.position, true, closest)
      return [key, closest.distanceTo(moon.position) - collisionRadius(moon)]
    })
  ) as Record<(typeof GALILEANS)[number], number>
}

describe('trip times at the flight scale', () => {
  test.each([
    ['moon', 10, 15, TRIP_DATE],
    ['mars', 30, 60, TRIP_DATE],
    ['jupiter', 90, 120, JUPITER_TRIP_DATE],
    ['neptune', 180, 300, TRIP_DATE],
  ] as const)('Earth → %s at full throttle, locked, takes %s–%s s (%s)', (key, min, max, date) => {
    if (key === 'jupiter') {
      // The open approach: the line clears every Galilean's shell.
      for (const [moon, miss] of Object.entries(galileanMisses(date))) {
        expect(miss, moon).toBeGreaterThanOrEqual(5)
      }
    }
    const { seconds, peakSpeed, peakFraction, hit } = trip(key, { date })
    console.log(
      `Earth → ${key} (${date.slice(0, 10)}): ${seconds.toFixed(1)} s, peak ${peakSpeed.toFixed(1)} u/s, peak speed/cap ${peakFraction.toFixed(3)}`
    )
    expect(seconds).toBeGreaterThanOrEqual(min)
    expect(seconds).toBeLessThanOrEqual(max)
    expect(hit).toBe(false)
    expect(peakSpeed).toBeLessThanOrEqual(V_TOP * (1 + 1e-9))
    // Locked: never over the cap, so no overshoot.
    expect(peakFraction).toBeLessThanOrEqual(1 + 1e-9)
  })

  // Locked, the ride down follows the cap whichever well takes over, so a
  // straight line through a moon system drops hard at each moon instead of
  // carrying the ship in over its cap (2.4× at Callisto with the braked
  // ride). On 2027-02-26 the line passes 0.84 units off Ganymede's shell; at
  // TRIP_DATE it runs through Callisto, so the ship meets Callisto's surface,
  // at no more than the V_NORMAL floor, and slides round it: contact is
  // allowed there, since only steering avoids it.
  test.each([
    { date: TRIP_DATE, moon: 'callisto', missAtMost: 0, contactAllowed: true },
    { date: '2027-02-26T12:00:00Z', moon: 'ganymede', missAtMost: 2, contactAllowed: false },
  ] as const)('locked across Jupiter’s moons ($date, past $moon) stays under every well’s cap', ({ date, moon, missAtMost, contactAllowed }) => {
    // The premise: the line runs through (≤ 0) or just past the moon's shell.
    const miss = galileanMisses(date)[moon]
    expect(miss).toBeLessThanOrEqual(missAtMost)
    if (!contactAllowed) expect(miss).toBeGreaterThan(0)
    const { seconds, peakSpeed, peakFraction, hit, wells } = trip('jupiter', { date })
    console.log(
      `Earth → jupiter past ${moon} (${date.slice(0, 10)}): ${seconds.toFixed(1)} s, peak ${peakSpeed.toFixed(1)} u/s, peak speed/cap ${peakFraction.toFixed(3)}, contact ${hit}`
    )
    expect(wells.has(moon)).toBe(true)
    expect(seconds).toBeLessThan(600)
    expect(peakFraction).toBeLessThanOrEqual(1 + 1e-9)
    if (!contactAllowed) expect(hit).toBe(false)
  })

  test('is frame-rate independent: the Moon trip at 60 fps and at MAX_DT agree within 0.5 s', () => {
    const smooth = trip('moon').seconds
    const choppy = trip('moon', { dt: MAX_DT }).seconds
    console.log(`Earth → moon: ${smooth.toFixed(2)} s at 60 fps, ${choppy.toFixed(2)} s at ${1 / MAX_DT} fps`)
    expect(Math.abs(choppy - smooth)).toBeLessThan(0.5)
  })

  // Log only: the targets are for TRIP_DATE. Mars at opposition is closer;
  // at conjunction the straight line runs through the Sun's well (and over
  // its surface at V_NORMAL), which is the pilot's cue to fly around it.
  test.each(['2027-02-19T12:00:00Z', '2026-01-09T12:00:00Z'])('other dates arrive (%s)', (date) => {
    const times = (['moon', 'mars', 'jupiter', 'neptune'] as const).map((key) => {
      const { seconds } = trip(key, { date, limit: 900 })
      expect(seconds).toBeLessThan(900)
      return `${key} ${seconds.toFixed(0)} s`
    })
    console.log(`${date.slice(0, 10)}: ${times.join(', ')}`)
  })
})

describe('overshoot', () => {
  test('unlocked, full throttle at the Moon arrives over the cap and hits; locked it does not', () => {
    const unlocked = trip('moon', { locked: false })
    expect(unlocked.arrivalFraction).toBeGreaterThan(1.2)
    expect(unlocked.peakFraction).toBeLessThanOrEqual(OVERSPEED_MAX)

    const locked = trip('moon')
    expect(locked.peakFraction).toBeLessThanOrEqual(1 + 1e-9)
    expect(locked.hit).toBe(false)

    // Keep going unlocked: it reaches the surface still over the floor.
    const bodies = flightBodies()
    const moon = bodies.find((b) => b.key === 'moon')!
    const state = shipAt(moon.position.clone().add(new THREE.Vector3(0, 0, 20)), moon.position)
    const telemetry = createShipTelemetry()
    let hit = false
    for (let i = 0; i < 60 * 30 && !hit; i++) {
      stepShip(state, input({ throttle: 1 }), FRAME, env(bodies), telemetry)
      hit = telemetry.colliding
    }
    expect(hit).toBe(true)
  })

  test('below WELL_BRAKE · wellFactor / K_WELL throttle the dive tracks the cap', () => {
    const bodies = flightBodies()
    const moon = bodies.find((b) => b.key === 'moon')!
    const throttle = (0.9 * WELL_BRAKE * wellTime(moon))
    const state = shipAt(moon.position.clone().add(new THREE.Vector3(0, 0, 20)), moon.position)
    const telemetry = createShipTelemetry()
    let peak = 0
    for (let i = 0; i < 60 * 30; i++) {
      stepShip(state, input({ throttle }), FRAME, env(bodies), telemetry)
      peak = Math.max(peak, telemetry.speed / telemetry.speedCap)
    }
    expect(peak).toBeLessThanOrEqual(throttle + 1e-6)
  })
})

describe('speed / cap tracks the throttle with FA on (tides-2hv.4 lag)', () => {
  const bodies = flightBodies()
  const earth = bodies.find((b) => b.key === 'earth')!
  const jupiter = bodies.find((b) => b.key === 'jupiter')!

  // 10 s at `throttle` from rest, nose from `from` toward `toward`.
  function settled(from: THREE.Vector3, toward: THREE.Vector3, throttle: number): number {
    const state = shipAt(from, toward)
    const telemetry = createShipTelemetry()
    for (let i = 0; i < 600; i++) stepShip(state, input({ throttle }), FRAME, env(bodies), telemetry)
    return telemetry.speed / telemetry.speedCap
  }

  test.each([0.5, 0.75, 1])('departing Earth at throttle %s', (throttle) => {
    // Straight up out of the ecliptic: away from Earth, the Moon and the Sun.
    const from = earth.position.clone().add(new THREE.Vector3(0, 15, 0))
    const fraction = settled(from, from.clone().add(Y), throttle)
    expect(Math.abs(fraction - throttle)).toBeLessThan(0.03)
  })

  test.each([0.5, 0.75, 1])('closing on Jupiter at throttle %s', (throttle) => {
    const from = jupiter.position.clone().add(new THREE.Vector3(0, 0, 600))
    const fraction = settled(from, jupiter.position, throttle)
    expect(Math.abs(fraction - throttle)).toBeLessThan(0.03)
  })
})

describe('true to scale near the ground (tides-zmw.9.18)', () => {
  const M = EARTH_UNITS_PER_METRE
  const T = Date.parse(TRIP_DATE)
  const kmh = (unitsPerSecond: number) => unitsPerSecond * EARTH_KM_PER_UNIT * 3600

  test('the floor follows the gap: 2/s of it, 50 m/s at least, the plateau at most; plain bodies keep speedFloor', () => {
    const earth: Body = { ...EARTH, minSpeed: EARTH_SLOWEST, groundSpeed: EARTH_GROUND_SPEED_LAW }
    expect(speedFloorAt(earth, 100 * M) / M).toBeCloseTo(200, 9)
    expect(speedFloorAt(earth, 30 * M) / M).toBeCloseTo(60, 9)
    expect(speedFloorAt(earth, 10 * M) / M).toBeCloseTo(50, 9)
    expect(speedFloorAt(earth, 0)).toBe(EARTH_SLOWEST)
    expect(speedFloorAt(earth, 1)).toBe(EARTH_GROUND_SPEED)
    expect(speedFloorAt(earth, NaN)).toBe(EARTH_GROUND_SPEED)
    expect(speedFloor(earth)).toBe(EARTH_SLOWEST)
    for (const gap of [0, 1e-5, 1, 100]) {
      expect(speedFloorAt(MOON, gap)).toBe(V_NORMAL)
      expect(speedFloorAt({ ...MOON, minSpeed: 0.02 }, gap)).toBe(0.02)
    }
  })

  // Real Earth over the tiles (no sampler: the globe's sphere), on reversed-Z float.
  function earthOverTiles() {
    const bodies = createShipBodies('high', true)
    updateShipBodies(bodies, T)
    const earth = bodies.find((b) => b.key === 'earth')!
    earth.floor!.beginFrame(true)
    return { bodies, earth, moon: bodies.find((b) => b.key === 'moon')! }
  }

  const UP = new THREE.Vector3(0.3, 1, -0.2).normalize()
  const gapOf = (earth: Body, state: ShipState) => {
    const d = state.position.distanceTo(earth.position)
    return d - earth.ground!(state.position.clone().sub(earth.position).divideScalar(d))
  }

  test.each([0.5, 0.75, 1])('a steady pass 100 m up at throttle %s reads 300-800 km/h', (throttle) => {
    const { bodies, earth } = earthOverTiles()
    const start = earth.position.clone().addScaledVector(UP, earth.ground!(UP) + 100 * M)
    const across = new THREE.Vector3(1, 0, 0).projectOnPlane(UP).normalize()
    const state = shipAt(start, start.clone().add(across))
    const telemetry = createShipTelemetry()
    for (let i = 0; i < 10 * 60; i++) {
      stepShip(state, input({ throttle }), FRAME, env(bodies), telemetry)
      // Hold 100 m: back onto the height, no climb or sink.
      const up = state.position.clone().sub(earth.position).normalize()
      state.position.copy(earth.position).addScaledVector(up, earth.ground!(up) + 100 * M)
      state.velocity.projectOnPlane(up)
    }
    expect(telemetry.air.speed).toBe(telemetry.speed)
    const reads = kmh(telemetry.air.speed)
    expect(reads).toBeGreaterThan(300)
    expect(reads).toBeLessThan(800)
    expect(reads / (throttle * 720)).toBeCloseTo(1, 1)
  })

  // From the 30 m stop, nose straight up at full throttle, until 0.3 u over the ground.
  function climb(carried: boolean): number {
    const { bodies, earth, moon } = earthOverTiles()
    const start = earth.position.clone().addScaledVector(UP, earth.ground!(UP) + FINE_GROUND_CLEARANCE)
    const state = shipAt(start, start.clone().add(UP))
    const carry = createFrameCarry()
    let t = T
    if (carried) carryShip(carry, state, earth, moon, FRAME, earthSpinRate(1))
    expect(gapOf(earth, state) / M).toBeCloseTo(30, 6)
    let seconds = 0
    for (; seconds < 60 && gapOf(earth, state) < 0.3; seconds += FRAME) {
      if (carried) {
        t += FRAME * 1000
        updateShipBody(earth, t)
        updateShipBody(moon, t)
        carryShip(carry, state, earth, moon, FRAME, earthSpinRate(1))
      }
      stepShip(state, input({ throttle: 1 }), FRAME, env(bodies))
    }
    return seconds
  }

  test('climbs from the 30 m stop to 0.3 u in under 15 s at the 0.02 u/s plateau, carried or not', () => {
    const still = climb(false)
    const carried = climb(true)
    expect(still).toBeLessThan(15)
    expect(Math.abs(carried - still)).toBeLessThan(0.2)
  })

  test("riding up over a cliff's edge, the cap's jump grows the speed at most e^(RIDE_UP_RATE·dt) a step", () => {
    // Flat ground 100 m under the ship for x < 0, a 2 km drop past it.
    const R = EARTH_RADIUS
    const ground = (direction: THREE.Vector3) => (direction.x < 0 ? R : R - 2000 * M)
    const gapLaw: GroundSpeedLaw = { ...EARTH_GROUND_SPEED_LAW, air: undefined }
    const make = (law?: GroundSpeedLaw): Body => ({
      key: 'earth',
      position: new THREE.Vector3(),
      radius: R,
      collisionRadius: R + 10 * M,
      mass: 5.972e24,
      ground,
      groundClearance: FINE_GROUND_CLEARANCE,
      minSpeed: law ? EARTH_SLOWEST : 0.02,
      ...(law ? { groundSpeed: law } : {}),
    })
    const growth = (law?: GroundSpeedLaw) => {
      const body = make(law)
      // ~1 km short of the edge, flying at it.
      const state = shipAt(new THREE.Vector3(-0.0005, R + 100 * M, 0), new THREE.Vector3(1, R + 100 * M, 0))
      let worst = 0
      let edge = NaN
      let crossed = false
      for (let i = 0; i < 20 * 60; i++) {
        const before = Math.max(state.velocity.length(), 1e-12)
        stepShip(state, input({ throttle: 1 }), FRAME, env([body]))
        // Hold the height, as in level flight.
        state.position.setLength(R + 100 * M)
        state.velocity.projectOnPlane(state.position.clone().normalize())
        // Spooled up (4 s) before the edge comes.
        if (i > 4 * 60) worst = Math.max(worst, state.velocity.length() / before)
        if (!crossed && state.position.x > 0) edge = state.velocity.length() / before
        crossed ||= state.position.x > 0
      }
      expect(crossed).toBe(true)
      return law ? { worst, edge } : worst
    }
    // Over the edge the cap jumps 21× (100 m to 2100 m of gap), which the
    // ride would pass straight on to the speed. Limited, the edge's step grows
    // it e^(3h) at most, and after it Flight Assist spools toward the new cap
    // over its τ (2 s): (1 − e^(−h/τ)) · (21 − 1) ≈ 17% a frame at first.
    const { worst, edge } = growth(gapLaw) as { worst: number; edge: number }
    expect(edge).toBeCloseTo(Math.exp(RIDE_UP_RATE * FRAME), 3)
    expect(worst).toBeLessThan(1 + (1 - Math.exp(-FRAME / VELOCITY_TAU_WELL)) * 20 + 1e-3)
    expect(worst).toBeGreaterThan(Math.exp(RIDE_UP_RATE * FRAME))
    // Before the law, at the flat 0.02 floor, the edge changed nothing (the floor held the cap).
    expect(growth()).toBeLessThan(1.02)
    // Nor with the air (tides-zmw.9.29): 100 m over the sea either side, the cap holds.
    expect((growth(EARTH_GROUND_SPEED_LAW) as { worst: number }).worst).toBeLessThan(1.02)
  })

  test('an unlocked dive under the law rides the cap down: speed / cap stays at the throttle to the stop', () => {
    const { bodies, earth } = earthOverTiles()
    const start = earth.position.clone().addScaledVector(UP, earth.ground!(UP) + 30000 * M)
    const state = shipAt(start, earth.position)
    const telemetry = createShipTelemetry()
    let peak = 0
    let seconds = 0
    for (; seconds < 600; seconds += FRAME) {
      stepShip(state, input({ throttle: 0.6 }), FRAME, env(bodies), telemetry)
      // After the spool-up (2 s τ deep in the well).
      if (seconds > 8) peak = Math.max(peak, telemetry.speed / telemetry.speedCap)
      if (gapOf(earth, state) < FINE_GROUND_CLEARANCE + 1e-3 * M) break
    }
    expect(peak).toBeLessThan(0.62)
    // Through the air (tides-zmw.9.29): ∫ dh / (0.6 · sea · e^(h / L)) from
    // the stop's altitude to the start's, ~2 min, then the last ~100 m on the
    // gap law in about a second.
    const air = EARTH_GROUND_SPEED_LAW.air!
    const base = earth.ground!(UP) - earth.radius
    const inAir = (air.scale / (0.6 * air.sea)) * (Math.exp(-base / air.scale) - Math.exp(-(base + 30000 * M) / air.scale))
    expect(seconds).toBeGreaterThan(0.95 * inAir)
    expect(seconds).toBeLessThan(1.05 * inAir + 4)
  })

  test('a ridge passing under the ship eases the speed down at most e^(−RIDE_DOWN_RATE·dt) a step, not a 3.3× brake', () => {
    // Flat ground 100 m under the ship for x < 0, 70 m higher past it.
    const R = EARTH_RADIUS
    const body: Body = {
      key: 'earth',
      position: new THREE.Vector3(),
      radius: R,
      collisionRadius: R + 10 * M,
      mass: 5.972e24,
      ground: (direction) => (direction.x < 0 ? R : R + 70 * M),
      groundClearance: FINE_GROUND_CLEARANCE,
      minSpeed: EARTH_SLOWEST,
      groundSpeed: EARTH_GROUND_SPEED_LAW,
    }
    const state = shipAt(new THREE.Vector3(-0.0005, R + 100 * M, 0), new THREE.Vector3(1, R + 100 * M, 0))
    let edge = NaN
    let worst = Infinity
    for (let i = 0; i < 20 * 60; i++) {
      const before = Math.max(state.velocity.length(), 1e-12)
      const wasOver = state.position.x > 0
      stepShip(state, input({ throttle: 1 }), FRAME, env([body]))
      state.position.setLength(R + 100 * M)
      state.velocity.projectOnPlane(state.position.clone().normalize())
      if (i > 4 * 60) worst = Math.min(worst, state.velocity.length() / before)
      if (!wasOver && state.position.x > 0) edge = state.velocity.length() / before
    }
    // The cap fell 100 m → 30 m of gap (0.3×) in the edge's step.
    expect(edge).toBeCloseTo(Math.exp(-RIDE_DOWN_RATE * FRAME), 3)
    expect(worst).toBeGreaterThanOrEqual(Math.exp(-RIDE_DOWN_RATE * FRAME) * (1 - 1e-9))
  })

  test("a supercruise arrival in Earth's well still rides it with WELL_BRAKE over the tiles: the law only where its floor sets the cap", () => {
    const run = (surfaceTiles: boolean) => {
      const bodies = createShipBodies('high', surfaceTiles)
      updateShipBodies(bodies, T)
      const earth = bodies.find((b) => b.key === 'earth')!
      const state = shipAt(earth.position.clone().add(new THREE.Vector3(0, 0, 9)), earth.position)
      const telemetry = createShipTelemetry()
      let peak = 0
      for (let i = 0; i < 30 * 60; i++) {
        stepShip(state, input({ throttle: 1 }), FRAME, env(bodies), telemetry)
        // Above the plateau's top (0.074 u), where the well sets the cap.
        if (telemetry.nearest.surfaceDistance < 0.1) break
        peak = Math.max(peak, telemetry.speed / telemetry.speedCap)
      }
      return peak
    }
    const over = run(true)
    expect(over).toBe(run(false))
    expect(over).toBeGreaterThan(1)
  })

  test("stepShip's telemetry reads the air speed as the frame speed and the rest 0, the carry's to fill", () => {
    const telemetry = createShipTelemetry()
    const state = shipAt(new THREE.Vector3(20, 0, 0), new THREE.Vector3(50, 0, 0))
    fly(state, 1, input({ throttle: 1 }), env(BODIES))
    stepShip(state, input({ throttle: 1 }), FRAME, env(BODIES), telemetry)
    expect(telemetry.air).toEqual({ speed: telemetry.speed, coupling: 0, density: 0, dynamicPressure: 0 })
    expect(telemetry.speed).toBeGreaterThan(0)
  })
})

describe("Earth's air sets the cap (tides-zmw.9.29)", () => {
  const M = EARTH_UNITS_PER_METRE
  const KM = 1000 * M
  const R = EARTH_RADIUS
  const law = EARTH_GROUND_SPEED_LAW
  const air = law.air!
  const gapLaw: GroundSpeedLaw = { ...law, air: undefined }
  // Earth with its ground `height` over the sea along each direction.
  const earthWith = (height: (direction: THREE.Vector3) => number, groundSpeed: GroundSpeedLaw = law): Body => ({
    key: 'earth',
    position: new THREE.Vector3(),
    radius: R,
    collisionRadius: R + 10 * M,
    mass: BODY_MASS_KG.earth,
    ground: (direction) => R + height(direction),
    groundClearance: FINE_GROUND_CLEARANCE,
    minSpeed: EARTH_SLOWEST,
    groundSpeed,
  })
  const sea = earthWith(() => 0)
  const above = (km: number) => new THREE.Vector3(0, R + km * KM, 0)
  // The nose `degrees` over the horizon, ship over +Y.
  const nose = (degrees: number) => new THREE.Vector3(Math.cos(degrees * DEG), Math.sin(degrees * DEG), 0)
  const DEG = Math.PI / 180

  test('rises steadily with the altitude through the air and joins the well cap above it with no step', () => {
    const level = nose(0)
    let km = 0.03
    let previous = speedCap(above(km), [sea], level)
    while (km < 150) {
      // 1% or 100 m a sample, whichever is less.
      km += Math.min(0.01 * km, 0.1)
      const cap = speedCap(above(km), [sea], level)
      expect(cap).toBeGreaterThanOrEqual(previous)
      expect(cap / previous).toBeLessThan(1.011)
      // Over the guard's last stretch and under the plateau, the air's own.
      if (km > 1 && km < 90) expect(cap / (air.sea * Math.exp((km * KM) / air.scale))).toBeCloseTo(1, 12)
      // Above the air, as without it.
      if (km > 92) expect(cap).toBe(speedCap(above(km), [earthWith(() => 0, gapLaw)], level))
      previous = cap
    }
    const kmh = (km: number) => (speedCap(above(km), [sea], level) * EARTH_KM_PER_UNIT * 3600)
    expect(kmh(0.1)).toBeCloseTo(720, -1)
    expect(kmh(10)).toBeCloseTo(1300, -2)
    expect(kmh(40)).toBeCloseTo(7600, -2)
  })

  test('flying level 10 km up over 8 km peaks, the cap holds within 10%, where the gap law swung with the ground', () => {
    // Ridges every ~20 km: 0 to 8 km over the sea.
    const ridges = (direction: THREE.Vector3) => 4 * KM + 4 * KM * Math.sin(2000 * Math.atan2(direction.x, direction.y))
    const swing = (groundSpeed: GroundSpeedLaw) => {
      const earth = earthWith(ridges, groundSpeed)
      let lo = Infinity
      let hi = 0
      for (let i = 0; i <= 1000; i++) {
        const angle = (0.01 * i) / 1000
        const at = new THREE.Vector3(Math.sin(angle), Math.cos(angle), 0).multiplyScalar(R + 10 * KM)
        const level = new THREE.Vector3(Math.cos(angle), -Math.sin(angle), 0)
        const cap = speedCap(at, [earth], level)
        lo = Math.min(lo, cap)
        hi = Math.max(hi, cap)
      }
      return hi / lo
    }
    expect(swing(law)).toBeLessThanOrEqual(1.1)
    expect(swing(gapLaw)).toBeGreaterThan(3)
  })

  test("the escape vector: the nose climbing from 30° to 60° hands the cap back to the gap law's, smoothly", () => {
    const at = above(1)
    const airCap = speedCap(at, [sea], nose(0))
    const gapCap = speedCap(at, [earthWith(() => 0, gapLaw)], nose(0))
    expect(gapCap / airCap).toBeGreaterThan(5)
    for (const degrees of [-90, -45, 0, 15, 29]) expect(speedCap(at, [sea], nose(degrees))).toBe(airCap)
    for (const degrees of [61, 75, 90]) expect(speedCap(at, [sea], nose(degrees))).toBeCloseTo(gapCap, 15)
    let previous = airCap
    for (let degrees = 30; degrees <= 60; degrees += 0.5) {
      const cap = speedCap(at, [sea], nose(degrees))
      expect(cap).toBeGreaterThanOrEqual(previous)
      expect(cap / previous).toBeLessThan(1.1)
      previous = cap
    }
    // No nose reads as level.
    expect(speedCap(at, [sea])).toBe(airCap)
  })

  test('climbs from the sea to 100 km in seconds nose up, where the air alone takes over a minute', () => {
    const climb = (groundSpeed: GroundSpeedLaw) => {
      const earth = earthWith(() => 0, groundSpeed)
      const state = shipAt(above(0.03), above(1000))
      let seconds = 0
      for (; seconds < 300; seconds += FRAME) {
        stepShip(state, input({ throttle: 1 }), FRAME, env([earth]))
        if (state.position.length() > R + 100 * KM) break
      }
      return seconds
    }
    expect(climb(law)).toBeLessThan(15)
    expect(climb({ ...law, air: { ...air, escape: [2, 3] } })).toBeGreaterThan(60)
  })

  test('the escape follows the motion: nose up in reverse is a descent at the air\'s cap', () => {
    const state = shipAt(above(10), above(10).add(nose(70)))
    const telemetry = createShipTelemetry()
    for (let i = 0; i < 10 * 60; i++) {
      stepShip(state, input({ throttle: -1 }), FRAME, env([sea]), telemetry)
      const km = (state.position.length() - R) / KM
      expect(telemetry.speedCap).toBeLessThanOrEqual(air.sea * Math.exp((km * KM) / air.scale) * (1 + 1e-9))
    }
    expect(state.position.length()).toBeLessThan(R + 10 * KM)
  })

  test('pitching over from an escape climb with Flight Assist off keeps the speed while the ship still climbs', () => {
    const state = shipAt(above(10), above(10).add(nose(70)))
    for (let i = 0; i < 1.5 * 60; i++) stepShip(state, input({ throttle: 1 }), FRAME, env([sea]))
    const before = state.velocity.length()
    expect(before).toBeGreaterThan(3 * speedCap(state.position, [sea], nose(0)))
    // Nose level at once: the motion still climbs, so the cap holds; the
    // carried speed bleeds at WELL_BRAKE, not a 20× brake in half a second.
    const up = state.position.clone().normalize()
    const level = new THREE.Vector3(1, 0, 0).projectOnPlane(up).normalize()
    state.orientation.setFromUnitVectors(new THREE.Vector3(0, 0, -1), level)
    for (let i = 0; i < 30; i++) stepShip(state, input({ throttle: 1, flightAssist: false }), FRAME, env([sea]))
    expect(state.velocity.length() / before).toBeGreaterThan(0.8)
  })

  test('flying level at the cap into rising ground: never under the floor, and it comes to the 30 m stop over the slope', () => {
    // Sea for x < 0, then a slope rising to 3 km at 1:2.
    const slope = (direction: THREE.Vector3) => THREE.MathUtils.clamp(0.5 * R * Math.atan2(direction.x, direction.y), 0, 3 * KM)
    const earth = earthWith(slope)
    const start = new THREE.Vector3(-0.002, R + 1 * KM, 0)
    const state = shipAt(start, start.clone().add(new THREE.Vector3(1, 0, 0)))
    const telemetry = createShipTelemetry()
    const direction = new THREE.Vector3()
    let resting = 0
    for (let i = 0; i < 120 * 60; i++) {
      stepShip(state, input({ throttle: 1 }), FRAME, env([earth]), telemetry)
      const d = direction.copy(state.position).length()
      direction.divideScalar(d)
      expect(d - floorRadius(earth, direction)).toBeGreaterThanOrEqual(-1e-12)
      expect(telemetry.speed).toBeLessThanOrEqual(OVERSPEED_MAX * telemetry.speedCap + 1e-12)
      if (d - earth.ground!(direction) < FINE_GROUND_CLEARANCE + 1 * M) resting++
    }
    // It met the slope and rode it at the stop.
    expect(resting).toBeGreaterThan(0)
  })

  describe('boost (tides-zmw.25)', () => {
    const B = EARTH_AIR_BOOST
    const gapEarth = earthWith(() => 0, gapLaw)
    // The cap's fall per step at the spool's rate, the most a release may brake.
    const releaseRatio = (dt: number) => Math.exp((-Math.log(B) * dt) / BOOST_SPOOL_SECONDS)
    // A sea a thousand times Earth's radius: flat over a step to well under
    // 1e-9 of the cap, so a level step's ratios are the flight model's own
    // rather than the curve dropping away under it.
    const RF = 1000 * R
    const flat: Body = { ...sea, radius: RF, collisionRadius: RF + 10 * M, ground: () => RF }
    // Level `km` over the flat sea along +X, `speed` along the nose; `hold`
    // puts it back at that height after each step.
    function level(km: number, speed = 0) {
      const start = new THREE.Vector3(0, RF + km * KM, 0)
      const state = shipAt(start, start.clone().add(new THREE.Vector3(1, 0, 0)))
      state.velocity.set(speed, 0, 0)
      const radial = new THREE.Vector3()
      const hold = () => {
        state.position.setLength(RF + km * KM)
        state.velocity.projectOnPlane(radial.copy(state.position).normalize())
      }
      return { state, hold }
    }

    test("multiplies the air's cap by EARTH_AIR_BOOST through the air, never over the gap law's, with no step, and not near the ground or above the air", () => {
      const flatNose = nose(0)
      for (const km of [0.03, 0.05, 0.1]) expect(speedCap(above(km), [sea], flatNose, 1)).toBe(speedCap(above(km), [sea], flatNose))
      let km = 0.03
      let previous = speedCap(above(km), [sea], flatNose, 1)
      while (km < 150) {
        km += Math.min(0.01 * km, 0.1)
        const base = speedCap(above(km), [sea], flatNose)
        const cap = speedCap(above(km), [sea], flatNose, 1)
        expect(cap).toBeGreaterThanOrEqual(previous)
        expect(cap / previous).toBeLessThan(1.011)
        expect(cap).toBeLessThanOrEqual(speedCap(above(km), [gapEarth], flatNose))
        if (km >= 5 && km <= 30) expect(cap / base).toBeCloseTo(B, 9)
        if (km >= 92) expect(cap).toBe(base)
        previous = cap
      }
      // Part-spooled, a share of the factor in log; out of range clamps, NaN reads as none.
      const at = above(10)
      const base = speedCap(at, [sea], flatNose)
      expect(speedCap(at, [sea], flatNose, 0.5) / base).toBeCloseTo(Math.sqrt(B), 9)
      expect(speedCap(at, [sea], flatNose, 2)).toBe(speedCap(at, [sea], flatNose, 1))
      expect(speedCap(at, [sea], flatNose, -1)).toBe(base)
      expect(speedCap(at, [sea], flatNose, NaN)).toBe(base)
    })

    // Straight down from 100 km at full throttle, Flight Assist on, to the 30 m stop.
    const descend = (boost: boolean, dt = FRAME) => {
      const state = shipAt(above(100), new THREE.Vector3())
      let seconds = 0
      for (; seconds < 300; seconds += dt) {
        stepShip(state, input({ throttle: 1, boost }), dt, env([sea]))
        if (state.position.length() - R < FINE_GROUND_CLEARANCE + 1e-3 * M) break
      }
      return seconds
    }

    test('boosted, straight down from 100 km to the 30 m stop takes seconds, not a minute and a half, as approachEta has it', () => {
      const boosted = descend(true)
      expect(boosted).toBeLessThan(10)
      expect(descend(true, MAX_DT)).toBeLessThan(10)
      expect(descend(false)).toBeGreaterThan(80)
      const ground = { law, stop: FINE_GROUND_CLEARANCE, base: 0, boost: 1 }
      // From rest at the cap all the way, the spool-up aside.
      const eta = approachEta(100 * KM, 1e9, wellTime(sea), 1, speedFloor(sea), ground)
      expect(boosted).toBeGreaterThan(0.95 * eta)
      expect(boosted).toBeLessThan(1.1 * eta + 3)
    })

    test.each([
      [1, true],
      [10, true],
      [30, true],
      [1, false],
      [10, false],
      [30, false],
    ])('released flying level %s km up (Flight Assist %s), the speed falls no faster than the spool lets the cap, to the cap', (km, flightAssist) => {
      const { state, hold } = level(km)
      const telemetry = createShipTelemetry()
      for (let i = 0; i < 10 * 60; i++) {
        stepShip(state, input({ throttle: 1, boost: true, flightAssist }), FRAME, env([flat]), telemetry)
        hold()
      }
      expect(telemetry.speed).toBeGreaterThan(0.99 * telemetry.speedCap)
      const floorRatio = releaseRatio(FRAME) * (1 - 1e-9)
      const over = flightAssist ? 1 : OVERSPEED_MAX
      for (let i = 0; i < 10 * 60; i++) {
        const before = state.velocity.length()
        stepShip(state, input({ throttle: 1, flightAssist }), FRAME, env([flat]), telemetry)
        hold()
        expect(state.velocity.length() / before).toBeGreaterThanOrEqual(floorRatio)
        expect(telemetry.speed).toBeLessThanOrEqual(over * telemetry.speedCap * (1 + 1e-9))
      }
      const base = speedCap(state.position, [flat])
      expect(telemetry.speedCap / base).toBeCloseTo(1, 6)
      expect(telemetry.speed / base).toBeCloseTo(1, 3)
    })

    test.each([1, 10, 30])('engaged flying level %s km up, the speed rises no faster than RIDE_UP_RATE and reaches the boosted cap within 1.5 s', (km) => {
      for (const flightAssist of [true, false]) {
        const { state, hold } = level(km, speedCap(new THREE.Vector3(0, RF + km * KM, 0), [flat]))
        const telemetry = createShipTelemetry()
        for (let i = 0; i < 60; i++) {
          stepShip(state, input({ throttle: 1, flightAssist }), FRAME, env([flat]), telemetry)
          hold()
        }
        // Over the flat sea the held ground is the sea (tides-5lj).
        const boostedCap = speedCap(state.position, [flat], null, 1, { key: 'earth', radius: RF })
        const ceiling = Math.exp(RIDE_UP_RATE * FRAME) * (1 + 1e-9)
        let reached = NaN
        for (let i = 0; i < 5 * 60; i++) {
          const before = state.velocity.length()
          stepShip(state, input({ throttle: 1, flightAssist, boost: true }), FRAME, env([flat]), telemetry)
          hold()
          expect(state.velocity.length() / before).toBeLessThanOrEqual(ceiling)
          if (Number.isNaN(reached) && telemetry.speed >= 0.95 * boostedCap) reached = (i + 1) * FRAME
        }
        if (flightAssist) expect(reached).toBeLessThan(1.5)
      }
    })

    test.each([
      ['held', Infinity],
      ['released at 5 s', 5],
    ])('boost %s flying level at the cap into rising ground: never under the floor, never a hit, and it comes to the 30 m stop', (_, release) => {
      const slope = (direction: THREE.Vector3) => THREE.MathUtils.clamp(0.5 * R * Math.atan2(direction.x, direction.y), 0, 3 * KM)
      const earth = earthWith(slope)
      const start = new THREE.Vector3(-0.002, R + 1 * KM, 0)
      const state = shipAt(start, start.clone().add(new THREE.Vector3(1, 0, 0)))
      const telemetry = createShipTelemetry()
      const direction = new THREE.Vector3()
      let resting = 0
      for (let i = 0; i < 120 * 60; i++) {
        stepShip(state, input({ throttle: 1, boost: i * FRAME < release }), FRAME, env([earth]), telemetry)
        const d = direction.copy(state.position).length()
        direction.divideScalar(d)
        expect(d - floorRadius(earth, direction)).toBeGreaterThanOrEqual(-1e-12)
        expect(telemetry.speed).toBeLessThanOrEqual(OVERSPEED_MAX * telemetry.speedCap + 1e-12)
        expect(telemetry.colliding).toBe(false)
        if (d - earth.ground!(direction) < FINE_GROUND_CLEARANCE + 1 * M) resting++
      }
      expect(resting).toBeGreaterThan(0)
    })

    test('a locked dive with Flight Assist off, boosted, never closes faster than the cap', () => {
      const state = shipAt(above(30), new THREE.Vector3())
      const telemetry = createShipTelemetry()
      const down = new THREE.Vector3()
      let seconds = 0
      for (; seconds < 120; seconds += FRAME) {
        stepShip(state, input({ throttle: 1, flightAssist: false, boost: true }), FRAME, env([sea], 'earth'), telemetry)
        const closing = state.velocity.dot(down.copy(state.position).normalize().negate())
        expect(closing).toBeLessThanOrEqual(telemetry.speedCap * (1 + 1e-9))
        if (state.position.length() - R < FINE_GROUND_CLEARANCE + 1e-3 * M) break
      }
      expect(seconds).toBeLessThan(120)
    })

    test.each([20, 5, 1])('a locked dive with Flight Assist off, boost released at %s km, never closes faster than the cap through the spool-down', (km) => {
      const state = shipAt(above(100), new THREE.Vector3())
      const telemetry = createShipTelemetry()
      const down = new THREE.Vector3()
      let released = NaN
      let seconds = 0
      for (; seconds < 120; seconds += FRAME) {
        const gap = state.position.length() - R
        if (Number.isNaN(released) && gap < km * KM) released = seconds
        stepShip(state, input({ throttle: 1, flightAssist: false, boost: Number.isNaN(released) }), FRAME, env([sea], 'earth'), telemetry)
        const closing = state.velocity.dot(down.copy(state.position).normalize().negate())
        expect(closing).toBeLessThanOrEqual(telemetry.speedCap * (1 + 1e-9))
        if (gap < FINE_GROUND_CLEARANCE + 1e-3 * M) break
      }
      // Released, and the spool-down ran its course before the stop.
      expect(seconds - released).toBeGreaterThan(BOOST_SPOOL_SECONDS)
      expect(seconds).toBeLessThan(120)
    })

    test('changes nothing without an air law, and a climb nose up is still seconds', () => {
      const run = (boost: boolean) => {
        const state = shipAt(MOON.position.clone().add(new THREE.Vector3(0, 3, 0)), MOON.position)
        fly(state, 5, input({ throttle: 1, boost }), env([MOON]))
        return state
      }
      const on = run(true)
      const off = run(false)
      expect(on.boost).toBe(1)
      expect(on.position.toArray()).toEqual(off.position.toArray())
      expect(on.velocity.toArray()).toEqual(off.velocity.toArray())

      const state = shipAt(above(0.03), above(1000))
      let seconds = 0
      for (; seconds < 300; seconds += FRAME) {
        stepShip(state, input({ throttle: 1, boost: true }), FRAME, env([sea]))
        if (state.position.length() > R + 100 * KM) break
      }
      expect(seconds).toBeLessThan(15)
    })

    test.each([
      ['in the air 10 km up', true, sea, 10, 1],
      ['in the air 60 km up, under the plateau unboosted', true, sea, 60, 1],
      ['part-spooled 10 km up', true, sea, 10, 0.1],
      ['200 m up, the air under the gap law unboosted', true, sea, 0.2, 1],
      ['1 km over flat ground', true, sea, 1, 1],
      ['with the spool at 0', false, sea, 10, 0],
      ['92 km up, where the air meets the plateau', false, sea, 92, 1],
      ['150 km up, in the well', false, sea, 150, 1],
      ['in the guard band 50 m up', false, sea, 0.05, 1],
      ['in the guard band 100 m up', false, sea, 0.1, 1],
      ['on the low tier, without a groundSpeed law', false, { ...sea, groundSpeed: undefined, minSpeed: undefined }, 10, 1],
    ] as const)('telemetry.boosted %s: %s', (_, expected, body, km, spool) => {
      const state = shipAt(above(km), above(km).add(nose(0)))
      state.boost = spool
      const telemetry = createShipTelemetry()
      stepShip(state, input({ boost: spool > 0 }), FRAME, env([body]), telemetry)
      expect(telemetry.boost > 0).toBe(spool > 0)
      expect(telemetry.boosted).toBe(expected)
      // Honest: exactly when the cap is over the unboosted one.
      expect(telemetry.speedCap > speedCap(state.position, [body], null) * (1 + 1e-6)).toBe(expected)
    })

    test("1 km over flat ground, boosted, the cap is over the gap law's 2 · gap (tides-5lj)", () => {
      const state = shipAt(above(1), above(1).add(nose(0)))
      state.boost = 1
      const telemetry = createShipTelemetry()
      stepShip(state, input({ boost: true }), FRAME, env([sea]), telemetry)
      const gap = state.position.length() - R
      expect(telemetry.boosted).toBe(true)
      expect(telemetry.speedCap).toBeGreaterThan(2 * EARTH_GAP_RATE * gap)
    })

    test('telemetry.boosted is false on the Moon, the spool full', () => {
      const state = shipAt(MOON.position.clone().add(new THREE.Vector3(0, 3, 0)), MOON.position)
      state.boost = 1
      const telemetry = createShipTelemetry()
      stepShip(state, input({ boost: true }), FRAME, env([MOON]), telemetry)
      expect(telemetry.boost).toBe(1)
      expect(telemetry.boosted).toBe(false)
      expect(createShipTelemetry().boosted).toBe(false)
    })

    test('spools up over BOOST_SPOOL_SECONDS and back down after release; a zero or NaN step leaves it', () => {
      const state = shipAt(above(10), above(10).add(nose(0)))
      const telemetry = createShipTelemetry()
      const steps = Math.ceil(BOOST_SPOOL_SECONDS / FRAME)
      for (let i = 0; i < steps / 2; i++) stepShip(state, input({ boost: true }), FRAME, env([sea]), telemetry)
      expect(state.boost).toBeCloseTo(0.5, 9)
      expect(telemetry.boost).toBe(state.boost)
      stepShip(state, input({ boost: true }), 0, env([sea]))
      stepShip(state, input({ boost: false }), NaN, env([sea]))
      expect(state.boost).toBeCloseTo(0.5, 9)
      for (let i = 0; i < steps; i++) stepShip(state, input({ boost: true }), FRAME, env([sea]))
      expect(state.boost).toBe(1)
      // A long frame spools only MAX_DT's worth.
      stepShip(state, input({ boost: false }), 1, env([sea]))
      expect(state.boost).toBeCloseTo(1 - MAX_DT / BOOST_SPOOL_SECONDS, 12)
      for (let i = 0; i < steps; i++) stepShip(state, input({ boost: false }), FRAME, env([sea]), telemetry)
      expect(state.boost).toBe(0)
      expect(telemetry.boost).toBe(0)
      expect(createShipState().boost).toBe(0)
    })
  })
})

describe('boosted guard on the held ground (tides-5lj)', () => {
  const M = EARTH_UNITS_PER_METRE
  const KM = 1000 * M
  const law = EARTH_GROUND_SPEED_LAW
  // A sea a thousand times Earth's radius, so level flight stays level over
  // tens of km, with ground along the arc s = RF · atan2(x, y) over +X:
  // `top(lo, hi)` is the highest it stands over the sea between arcs lo and
  // hi. Its ground reads the highest within `reach` of the direction, as
  // Earth's does (ship-bodies.ts); without one, straight under it.
  const RF = 1000 * EARTH_RADIUS
  const arcOf = (direction: THREE.Vector3) => RF * Math.atan2(direction.x, direction.y)
  const earthOver = (top: (lo: number, hi: number) => number): Body => ({
    key: 'earth',
    position: new THREE.Vector3(),
    radius: RF,
    collisionRadius: RF + 10 * M,
    mass: BODY_MASS_KG.earth,
    ground: (direction, reach = 0) => {
      const s = arcOf(direction)
      return RF + top(s - reach, s + reach)
    },
    groundClearance: FINE_GROUND_CLEARANCE,
    minSpeed: EARTH_SLOWEST,
    groundSpeed: law,
  })
  const flat = earthOver(() => 0)
  // Ridges 0 to 4 km over the sea every 16 km: 2 km + 2 km · sin(2π s / λ).
  const WAVE = 16 * KM
  const ridge = (s: number) => 2 * KM + 2 * KM * Math.sin((2 * Math.PI * s) / WAVE)
  const ridgeTop = (lo: number, hi: number) => {
    if (hi - lo >= WAVE) return 4 * KM
    // The first crest (s = λ/4 + nλ) at or after lo.
    const crest = WAVE / 4 + Math.ceil((lo - WAVE / 4) / WAVE) * WAVE
    return crest <= hi ? 4 * KM : Math.max(ridge(lo), ridge(hi))
  }
  const ridges = earthOver(ridgeTop)
  const hold = (radius: number, key: string | null = 'earth'): GroundHold => ({ key, radius })

  // Level `km` over `body`'s sea along +X at `speed`; `keep` puts it back at
  // that height, level, after each step.
  function level(km: number, speed = 0) {
    const start = new THREE.Vector3(0, RF + km * KM, 0)
    const state = shipAt(start, start.clone().add(new THREE.Vector3(1, 0, 0)))
    state.velocity.set(speed, 0, 0)
    const radial = new THREE.Vector3()
    const keep = () => {
      state.position.setLength(RF + km * KM)
      state.velocity.projectOnPlane(radial.copy(state.position).normalize())
    }
    return { state, keep }
  }

  test('flying level 5 km up over 4 km ridges at full throttle, boosted, the cap holds steady at 5 · (1 km − 120 m), where the guard straight under the ship swung it over 2×', () => {
    const { state, keep } = level(5, speedCap(new THREE.Vector3(0, RF + 5 * KM, 0), [ridges]))
    const telemetry = createShipTelemetry()
    const fly = (seconds: number, record?: (cap: number) => void) => {
      for (let i = 0; i < seconds * 60; i++) {
        stepShip(state, input({ throttle: 1, boost: true }), FRAME, env([ridges]), telemetry)
        keep()
        record?.(telemetry.speedCap)
      }
    }
    fly(3)
    let lo = Infinity
    let hi = 0
    const start = arcOf(state.position)
    fly(20, (cap) => {
      lo = Math.min(lo, cap)
      hi = Math.max(hi, cap)
    })
    // Over several ridges.
    expect(arcOf(state.position) - start).toBeGreaterThan(4 * WAVE)
    expect(hi / lo).toBeLessThan(1.03)
    const steady = EARTH_BOOST_GUARD_RATE * (1 * KM - EARTH_BOOST_GUARD_OFFSET)
    expect(Math.abs(lo / steady - 1)).toBeLessThan(0.02)
    expect(Math.abs(hi / steady - 1)).toBeLessThan(0.02)
    expect(steady / M).toBeCloseTo(4400, 6)
    // Without a held ground the boosted guard reads the gap, 2 · gap: 2 km/s
    // over a peak, the boosted air's ~5.4 km/s over a valley.
    let flo = Infinity
    let fhi = 0
    for (let i = 0; i <= 100; i++) {
      const at = new THREE.Vector3(Math.sin((i / 100) * (WAVE / RF)), Math.cos((i / 100) * (WAVE / RF)), 0).multiplyScalar(RF + 5 * KM)
      const cap = speedCap(at, [ridges], null, 1)
      flo = Math.min(flo, cap)
      fhi = Math.max(fhi, cap)
    }
    expect(fhi / flo).toBeGreaterThan(2)
  })

  test('unboosted, the held ground changes nothing: the floor and ceiling are the same numbers, and stepShip holds no ground', () => {
    for (const metres of [10, 30, 100, 150, 200, 500, 1000, 3000, 10000, 50000, 120000]) {
      const gap = metres * M
      for (const base of [0, 4 * KM]) {
        for (const climb of [0, 0.6, 0.9]) {
          for (const held of [gap, 0.5 * gap, 2 * gap, 0, -gap, Infinity]) {
            expect(lawFloor(law, gap, gap + base, climb, 0, held)).toBe(lawFloor(law, gap, gap + base, climb))
            expect(lawCeiling(law, gap, gap + base, climb, 0, held)).toBe(lawCeiling(law, gap, gap + base, climb))
          }
        }
      }
    }
    const { state, keep } = level(5)
    for (let i = 0; i < 120; i++) {
      stepShip(state, input({ throttle: 1 }), FRAME, env([ridges]))
      keep()
      expect(state.groundHold.key).toBeNull()
      expect(state.groundHold.radius).toBeNaN()
    }
    expect(createShipState().groundHold).toEqual({ key: null, radius: NaN })
  })

  test("near the ground the boosted guard is the gap law's as before: today's boosted floor under 200 m, the unboosted one under 100 m", () => {
    for (let metres = 30; metres <= 190; metres += 10) {
      const gap = metres * M
      const unboosted = lawFloor(law, gap, gap)
      const before = lawFloor(law, gap, gap, 0, 1)
      // Held at the gap (flat ground): as before.
      expect(lawFloor(law, gap, gap, 0, 1, gap)).toBe(before)
      // Higher ground held: between the two.
      const higher = lawFloor(law, gap, gap, 0, 1, 0.5 * gap)
      expect(higher).toBeGreaterThanOrEqual(unboosted)
      expect(higher).toBeLessThanOrEqual(before)
      if (metres < 100) expect(lawFloor(law, gap, gap, 0, 1, gap)).toBe(unboosted)
    }
  })

  test('the spool moves the boosted floor no faster than ln(EARTH_AIR_BOOST) per unit of spool in log', () => {
    const ds = 0.05
    const bound = Math.log(EARTH_AIR_BOOST) * ds * (1 + 1e-9)
    for (const metres of [50, 200, 1000, 3000, 10000, 40000]) {
      const gap = metres * M
      for (const share of [1, 0.5, 0.1]) {
        for (const base of [0, 4 * KM]) {
          for (const climb of [0, 0.7]) {
            for (let s = 0; s < 1 - 1e-9; s += ds) {
              const a = lawFloor(law, gap, gap + base, climb, s, share * gap)
              const b = lawFloor(law, gap, gap + base, climb, Math.min(1, s + ds), share * gap)
              expect(Math.abs(Math.log(b / a))).toBeLessThanOrEqual(bound)
            }
          }
        }
      }
    }
  })

  test('a boosted dive at the cap over flat ground with Flight Assist on rides the cap down: never clamped at RIDE_DOWN_RATE between 975 m and 200 m', () => {
    const start = new THREE.Vector3(0, RF + 3 * KM, 0)
    const state = shipAt(start, new THREE.Vector3())
    state.boost = 1
    state.groundHold = hold(RF)
    state.velocity.copy(noseOf(state)).multiplyScalar(speedCap(start, [flat], noseOf(state), 1, state.groundHold))
    const telemetry = createShipTelemetry()
    const clamp = Math.exp(-RIDE_DOWN_RATE * FRAME)
    let checked = 0
    for (let i = 0; i < 60 * 60; i++) {
      const gap = state.position.length() - RF
      const before = state.velocity.length()
      stepShip(state, input({ throttle: 1, boost: true }), FRAME, env([flat]), telemetry)
      if (gap < 975 * M && gap > 200 * M) {
        checked++
        expect(state.velocity.length() / before).toBeGreaterThan(clamp * (1 + 1e-6))
        expect(telemetry.speed / telemetry.speedCap).toBeGreaterThan(0.99)
        expect(telemetry.speed / telemetry.speedCap).toBeLessThanOrEqual(1 + 1e-9)
      }
      if (gap < FINE_GROUND_CLEARANCE + 1 * M) break
    }
    expect(checked).toBeGreaterThan(10)
  })

  test('flying level beside a ridge parallel to the track, boosted, the cap holds steady and the speed rides under it (review 1: no sawtooth)', () => {
    // 3 km up over the sea, a 2.5 km ridge 5 km to the side along the whole track.
    const D = 5 * KM
    const H = 2.5 * KM
    const ALT = 3 * KM
    const beside: Body = {
      ...flat,
      ground: (direction, reach = 0) => RF + (Math.abs(RF * Math.atan2(direction.z, direction.y) - D) <= reach ? H : 0),
    }
    const { state, keep } = level(3, speedCap(new THREE.Vector3(0, RF + ALT, 0), [beside]))
    const telemetry = createShipTelemetry()
    let lo = Infinity
    let hi = 0
    for (let i = 0; i < 18 * 60; i++) {
      stepShip(state, input({ throttle: 1, boost: true }), FRAME, env([beside]), telemetry)
      keep()
      if (i < 8 * 60) continue
      lo = Math.min(lo, telemetry.speedCap)
      hi = Math.max(hi, telemetry.speedCap)
      expect(telemetry.speed / telemetry.speedCap).toBeLessThanOrEqual(1 + 1e-6)
    }
    expect(hi / lo).toBeLessThan(1.03)
    // The ridge held: 5 · (500 m − 120 m).
    expect(lo / (EARTH_BOOST_GUARD_RATE * (ALT - H - EARTH_BOOST_GUARD_OFFSET))).toBeCloseTo(1, 6)
    expect(telemetry.speed / telemetry.speedCap).toBeGreaterThan(0.99)
  })

  test('500 m up toward a 300 m hill 30 km ahead, boosted, the cap drops once and holds until the ship is over it, the speed under it (review 2: no gaps between the windows)', () => {
    const ALT = 0.5 * KM
    const AT = 30 * KM
    const hill = earthOver((lo, hi) => (hi >= AT - 50 * M && lo <= AT + 50 * M ? 300 * M : 0))
    const { state, keep } = level(0.5, speedCap(new THREE.Vector3(0, RF + ALT, 0), [hill]))
    const telemetry = createShipTelemetry()
    let previous = NaN
    let dropped = false
    let rises = 0
    let over = false
    for (let i = 0; i < 60 * 60; i++) {
      stepShip(state, input({ throttle: 1, boost: true }), FRAME, env([hill]), telemetry)
      keep()
      const cap = telemetry.speedCap
      if (cap < 0.8 * previous) dropped = true
      else if (dropped && cap > 1.01 * previous) rises++
      previous = cap
      if (arcOf(state.position) >= AT - 50 * M) {
        over = true
        break
      }
    }
    expect(over).toBe(true)
    expect(dropped).toBe(true)
    expect(rises).toBeLessThanOrEqual(1)
    // Over the hill: the guard on its 200 m clearance, 5 · (200 m − 120 m).
    expect(telemetry.speedCap / (EARTH_BOOST_GUARD_RATE * (200 * M - EARTH_BOOST_GUARD_OFFSET))).toBeCloseTo(1, 6)
    // The speed nearly down to it: the hill comes into the windows 5 km out
    // (10 altitudes), where the cap drops 1900 → 400 m/s, the ride's
    // OVERSPEED_MAX clamp brakes to 1200 and Flight Assist eases the rest
    // off over velocityTau (~2 s there), ~1.03× by the hill. With gaps
    // between the windows the cap sawtoothed back up and the ship crossed
    // at 2.2× it.
    expect(telemetry.speed / telemetry.speedCap).toBeLessThan(1.05)
  })

  describe('updateGroundHold', () => {
    const V = 4 * KM
    const ALT = 5 * KM
    const P = 3 * KM
    // The windows' speed there: the full boost's air floor, 5 km up ~5.4 km/s.
    const W = holdSpeed(law, ALT)
    // A narrow bump P over the sea centred on arc `at`.
    const bumpAt = (at: number) => earthOver((lo, hi) => (hi >= at - 10 * M && lo <= at + 10 * M ? P : 0))
    const position = new THREE.Vector3(0, RF + ALT, 0)
    const velocity = new THREE.Vector3(V, 0, 0)

    test('holdSpeed is the full boost air floor flying level, never over the plateau, whatever the ship does', () => {
      expect(W / M).toBeCloseTo(5368, -1)
      expect(W).toBeCloseTo(EARTH_AIR_BOOST * law.air!.sea * Math.exp(ALT / law.air!.scale), 15)
      expect(holdSpeed(law, 80 * KM)).toBe(law.max)
      expect(holdSpeed({ ...law, air: undefined }, ALT)).toBeNaN()
    })

    test('takes a peak in the corridor at once, from 1.5 s behind to 3.5 s ahead at holdSpeed, and none outside it, at any speed of its own', () => {
      for (const speed of [V, 0.1 * V, 10 * V]) {
        for (const [seconds, seen] of [
          [0, true],
          [1.5, true],
          [3.4, true],
          [-1.4, true],
          [3.7, false],
          [4, false],
          [-1.7, false],
          [-2, false],
        ] as const) {
          const h = hold(NaN, null)
          updateGroundHold(h, bumpAt(seconds * W), position, new THREE.Vector3(speed, 0, 0), 1, FRAME)
          expect(h.key).toBe('earth')
          expect(h.radius).toBe(RF + (seen ? P : 0))
        }
      }
      // Still, the windows all sit on the ship.
      for (const [seconds, seen] of [
        [1.4, true],
        [-1.4, true],
        [1.6, false],
        [2, false],
      ] as const) {
        const h = hold(NaN, null)
        updateGroundHold(h, bumpAt(seconds * W), position, new THREE.Vector3(), 1, FRAME)
        expect(h.radius).toBe(RF + (seen ? P : 0))
      }
      // Rising is instant from a lower hold too.
      const h = hold(RF)
      updateGroundHold(h, bumpAt(1.5 * W), position, velocity, 1, FRAME)
      expect(h.radius).toBe(RF + P)
    })

    test.each([0.3, 0.8, 5])('%s km up the windows touch or overlap along the track: a corridor with no gaps', (km) => {
      const windows: [number, number][] = []
      const spy: Body = {
        ...flat,
        ground: (direction, reach = 0) => {
          const s = arcOf(direction)
          windows.push([s - reach, s + reach])
          return RF
        },
      }
      updateGroundHold(hold(NaN, null), spy, new THREE.Vector3(0, RF + km * KM, 0), velocity, 1, FRAME)
      expect(windows.length).toBe(3)
      windows.sort((a, b) => a[0] - b[0])
      for (let i = 1; i < windows.length; i++) expect(windows[i][0]).toBeLessThanOrEqual(windows[i - 1][1] * (1 + 1e-9) + 1e-12)
      // Low down, from 2 altitudes behind to 10 ahead.
      if (km < 1) {
        expect(windows[0][0] / (-2 * km * KM)).toBeCloseTo(1, 6)
        expect(windows[2][1] / (10 * km * KM)).toBeCloseTo(1, 6)
      }
    })

    test('the ahead offset fades in from rest over HOLD_DRIFT_SHARE of the least speed, so a drift barely moves the windows', () => {
      const centres = (speed: number) => {
        const at: number[] = []
        const spy: Body = { ...flat, ground: (direction, reach = 0) => (at.push(arcOf(direction)), flat.ground!(direction, reach)) }
        updateGroundHold(hold(NaN, null), spy, position, new THREE.Vector3(speed, 0, 0), 1, FRAME)
        return at
      }
      const drift = HOLD_DRIFT_SHARE * law.min
      expect(centres(0)).toEqual([0, 0, 0])
      // A hundredth of the fade: a hundredth of the offset.
      const slow = centres(0.01 * drift)
      const full = centres(drift)
      expect(slow[2] / full[2]).toBeCloseTo(0.01, 6)
      expect(full[2] / (2 * W)).toBeCloseTo(1, 5)
      // Above it, fixed whatever the speed.
      expect(centres(100 * drift)).toEqual(full)
    })

    test('falls toward lower ground over HOLD_FALL_TAU', () => {
      const h = hold(RF + P)
      updateGroundHold(h, flat, position, velocity, 1, 0.5)
      expect((h.radius - RF) / P).toBeCloseTo(Math.exp(-0.5 / HOLD_FALL_TAU), 6)
      for (let i = 0; i < 60 * 30; i++) updateGroundHold(h, flat, position, velocity, 1, FRAME)
      expect((h.radius - RF) / P).toBeLessThan(1e-3)
      // A zero or NaN step holds it.
      const held = h.radius
      updateGroundHold(h, flat, position, velocity, 1, 0)
      updateGroundHold(h, flat, position, velocity, 1, NaN)
      expect(h.radius).toBe(held)
    })

    test('lets go with the spool at 0, without a body or ground, and starts over on a new body', () => {
      for (const [body, spool] of [
        [flat, 0],
        [flat, NaN],
        [null, 1],
        [{ ...flat, ground: undefined }, 1],
      ] as const) {
        const h = hold(RF + P)
        updateGroundHold(h, body, position, velocity, spool, FRAME)
        expect(h.key).toBeNull()
        expect(h.radius).toBeNaN()
      }
      // Lower ground on another body's hold: taken at once.
      const h = hold(RF + P, 'mars')
      updateGroundHold(h, flat, position, velocity, 1, FRAME)
      expect(h).toEqual({ key: 'earth', radius: RF })
    })

    test('reads windows of HOLD_REACH_SECONDS at holdSpeed, never over HOLD_REACH_ALTITUDES × the altitude, and nothing where the boost changes nothing', () => {
      const reaches: number[] = []
      const spy: Body = { ...flat, ground: (direction, reach = 0) => (reaches.push(reach), flat.ground!(direction, reach)) }
      const at = (km: number) => new THREE.Vector3(0, RF + km * KM, 0)
      const reads = (km: number, speed = V) => {
        reaches.length = 0
        const h = hold(NaN, null)
        updateGroundHold(h, spy, at(km), new THREE.Vector3(speed, 0, 0), 1, FRAME)
        return h
      }
      for (const speed of [1 * KM, V, 50 * KM]) {
        reads(5, speed)
        expect(reaches.length).toBe(3)
        for (const reach of reaches) expect(reach / (HOLD_REACH_SECONDS * W)).toBeCloseTo(1, 9)
      }
      reads(1)
      for (const reach of reaches) expect(reach / KM).toBeCloseTo(HOLD_REACH_ALTITUDES, 9)
      // High in the air, at most 1.5 s of the plateau speed (~64 km).
      reads(80)
      for (const reach of reaches) expect(reach / (HOLD_REACH_SECONDS * law.max)).toBeCloseTo(1, 9)
      // From where the unboosted air meets the plateau (~91 km) the boost
      // changes nothing: no scan, no hold. Nor without an air law.
      for (const km of [92, 150, 400000]) {
        const h = reads(km)
        expect(reaches.length).toBe(0)
        expect(h.radius).toBeNaN()
      }
      reaches.length = 0
      const h = hold(RF)
      updateGroundHold(h, { ...spy, groundSpeed: { ...law, air: undefined } }, position, velocity, 1, FRAME)
      expect(reaches.length).toBe(0)
      expect(h).toEqual({ key: null, radius: NaN })
    })

    test('a NaN window never wins, and with no ground read at all it holds none', () => {
      let calls = 0
      const first: Body = { ...flat, ground: () => (calls++ === 0 ? NaN : RF + P) }
      const h = hold(NaN, null)
      updateGroundHold(h, first, position, velocity, 1, FRAME)
      expect(h.radius).toBe(RF + P)
      const none: Body = { ...flat, ground: () => NaN }
      updateGroundHold(h, none, position, velocity, 1, FRAME)
      expect(h.key).toBeNull()
      expect(h.radius).toBeNaN()
    })
  })
})
