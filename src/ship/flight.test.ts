import * as THREE from 'three'
import { describe, expect, test } from 'vitest'
import { PLANETS, sceneRadius } from '../planets'
import {
  BLUE_ZONE,
  COLLISION_MARGIN,
  ETA_SECONDS,
  K_CRUISE,
  MAX_DT,
  PITCH_RATE,
  V_NORMAL,
  VELOCITY_TAU,
  approachCap,
  collisionRadius,
  createShipState,
  nearestBody,
  speedCap,
  stepShip,
  turnRateFactor,
  type Body,
  type FlightEnv,
  type ShipState,
} from './flight'
import type { ShipInput } from './ship-input'
import { createShipTelemetry } from './ship-telemetry'

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
    expect(speedCap(at(V_NORMAL / K_CRUISE), [body])).toBeCloseTo(V_NORMAL, 12)
  })

  test('grows with distance to the nearest surface', () => {
    const gaps = [1, 2, 5, 10, 50, 300, 2000]
    const caps = gaps.map((g) => speedCap(at(g), [body]))
    for (let i = 1; i < caps.length; i++) expect(caps[i]).toBeGreaterThan(caps[i - 1])
    expect(caps[caps.length - 1]).toBeCloseTo(K_CRUISE * 2000, 9)
  })

  test('uses the nearest body, not the first', () => {
    const near: Body = { key: 'near', position: new THREE.Vector3(10, 0, 0), radius: 1 }
    const p = new THREE.Vector3(14, 0, 0)
    expect(nearestBody(p, [body, near])?.body.key).toBe('near')
    expect(speedCap(p, [body, near])).toBeCloseTo(K_CRUISE * 3, 12)
  })

  test('is V_NORMAL with no bodies', () => {
    expect(nearestBody(new THREE.Vector3(), [])).toBeNull()
    expect(speedCap(new THREE.Vector3(1e6, 0, 0), [])).toBe(V_NORMAL)
  })

})

describe('approachCap', () => {
  test('is surface distance over ETA_SECONDS, floored at V_NORMAL', () => {
    expect(approachCap(195)).toBeCloseTo(195 / ETA_SECONDS, 12)
    expect(approachCap(0.01)).toBe(V_NORMAL)
    expect(approachCap(-1)).toBe(V_NORMAL)
  })
})

describe('turnRateFactor', () => {
  test('peaks in the blue zone (throttle 0.5–0.75) and is lower at 0 and 1', () => {
    let best = -Infinity
    let bestAt = NaN
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const f = turnRateFactor(t)
      if (f > best + 1e-12) {
        best = f
        bestAt = t
      }
    }
    expect(bestAt).toBeGreaterThanOrEqual(0.5 - 1e-9)
    expect(bestAt).toBeLessThanOrEqual(0.75)
    expect(turnRateFactor(BLUE_ZONE[0])).toBe(best)
    expect(turnRateFactor(BLUE_ZONE[1])).toBe(best)
    expect(turnRateFactor(0)).toBeLessThan(best)
    expect(turnRateFactor(1)).toBeLessThan(best)
  })

  test('reverse throttle uses its magnitude', () => {
    expect(turnRateFactor(-0.25)).toBe(turnRateFactor(0.25))
  })
})

describe('Flight Assist on', () => {
  test('velocity converges to throttle × cap along the nose with a ~1 s e-fold', () => {
    // No bodies: the cap is V_NORMAL everywhere, so the target is fixed.
    const state = shipAt(new THREE.Vector3(), new THREE.Vector3(1, 2, -3))
    const target = noseOf(state).multiplyScalar(0.6 * V_NORMAL)

    fly(state, VELOCITY_TAU, input({ throttle: 0.6 }), env([]))
    const remaining = state.velocity.distanceTo(target) / target.length()
    expect(remaining).toBeCloseTo(Math.exp(-1), 2)

    fly(state, 10, input({ throttle: 0.6 }), env([]))
    expect(state.velocity.distanceTo(target)).toBeLessThan(1e-4)
  })

  test('cutting the throttle brings the ship to rest', () => {
    const state = shipAt(new THREE.Vector3(), new THREE.Vector3(0, 0, -1))
    fly(state, 5, input({ throttle: 1 }), env([]))
    fly(state, 15, input({ throttle: 0 }), env([]))
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

    const reversing = fly(createShipState(), 10, input({ throttle: -0.25 }), env([]))
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
  test('speed toward the target never exceeds max(V_NORMAL, gap / ETA) and it lands without passing inside', () => {
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
        Math.max(V_NORMAL, gap / ETA_SECONDS) + 1e-12
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

  test('reports a ~7 s ETA while at the target cap', () => {
    const state = shipAt(new THREE.Vector3(0, 0, -200), NEPTUNE.position)
    const telemetry = createShipTelemetry()
    for (let i = 0; i < 10 * 60; i++) {
      stepShip(state, input({ throttle: 1 }), FRAME, env(BODIES, 'neptune'), telemetry)
    }
    expect(telemetry.target!.etaSeconds).toBeGreaterThan(ETA_SECONDS - 0.1)
    expect(telemetry.target!.etaSeconds).toBeLessThan(ETA_SECONDS + 0.1)
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

  test('the ship never ends a step inside any body, for any input or dt', () => {
    const rand = random(7)
    const dts = [FRAME, 0.05, MAX_DT, 0.5, 5, 1e6, Infinity, NaN, -1, 0]
    const telemetry = createShipTelemetry()
    for (const body of [EARTH, MOON, SUN]) {
      for (let run = 0; run < 20; run++) {
        const start = body.position
          .clone()
          .add(
            new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5)
              .normalize()
              .multiplyScalar(body.radius * (1.05 + 3 * rand()))
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
            env(BODIES),
            telemetry
          )
          for (const b of BODIES) {
            expect(state.position.distanceTo(b.position)).toBeGreaterThanOrEqual(
              b.radius * COLLISION_MARGIN * (1 - 1e-12)
            )
          }
          expect(state.position.toArray().every(Number.isFinite)).toBe(true)
        }
      }
    }
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

describe('Earth → Neptune', () => {
  test('a full-throttle trip with Neptune targeted takes 10–40 s', () => {
    // From the ~15-unit spawn distance, nose on Neptune; arrived when one
    // Neptune radius off its surface (it then spans 60° of the view).
    const toNeptune = NEPTUNE.position.clone().sub(EARTH.position).normalize()
    const state = shipAt(
      EARTH.position.clone().addScaledVector(toNeptune, 15),
      NEPTUNE.position
    )
    const telemetry = createShipTelemetry()
    let t = 0
    do {
      stepShip(state, input({ throttle: 1 }), FRAME, env(BODIES, 'neptune'), telemetry)
      t += FRAME
    } while (telemetry.target!.surfaceDistance > NEPTUNE.radius && t < 120)

    console.log(`Earth → Neptune: ${t.toFixed(1)} s`)
    expect(t).toBeGreaterThanOrEqual(10)
    expect(t).toBeLessThanOrEqual(40)
  })
})
