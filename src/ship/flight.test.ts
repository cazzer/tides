import * as THREE from 'three'
import { describe, expect, test } from 'vitest'
import { PLANETS, sceneRadius } from '../planets'
import {
  BLUE_ZONE,
  COLLISION_MARGIN,
  K_WELL,
  MAX_DT,
  OVERSPEED_MAX,
  PITCH_RATE,
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
  nearestBody,
  speedCap,
  speedFraction,
  stepShip,
  turnRateMultiplier,
  velocityTau,
  wellFactor,
  wellTime,
  type Body,
  type FlightEnv,
  type ShipState,
} from './flight'
import { BODY_MASS_KG, createShipBodies, updateShipBodies } from './ship-bodies'
import type { ShipInput } from './ship-input'
import { createShipTelemetry, type ShipTelemetry } from './ship-telemetry'

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
    ...overrides,
  }
}

function env(bodies: readonly Body[], targetKey: string | null = null): FlightEnv {
  return { bodies, targetKey }
}

// The ticket's trip-time targets are set at this instant.
const TRIP_DATE = '2026-10-22T12:00:00Z'

/** Ship mode's real bodies (masses, flight scale), frozen at `date`. */
function flightBodies(date = TRIP_DATE): Body[] {
  const bodies = createShipBodies()
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

    stepShip(state, input(), FRAME, env([]), telemetry)
    expect(telemetry.well).toEqual({ key: null, factor: 1 })
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
