import * as THREE from 'three'
import { describe, expect, test } from 'vitest'
import {
  K_WELL,
  V_NORMAL,
  V_TOP,
  collisionRadius,
  createShipState,
  stepShip,
  wellFactor,
  type Body,
} from './flight'
import {
  BODY_MASS_KG,
  EARTH_GROUND_SPEED,
  EARTH_GROUND_SPEED_LAW,
  EARTH_RADIUS,
  EARTH_SLOWEST,
  EARTH_UNITS_PER_METRE,
  FINE_GROUND_CLEARANCE,
} from './ship-bodies'
import type { ShipInput } from './ship-input'
import { createShipTelemetry } from './ship-telemetry'
import { isImpact } from './impact'
import {
  AHEAD_CONE,
  FAST_WINDOW_S,
  OVER_ON,
  SAFE_SHARE_FULL,
  approachEta,
  canCrash,
  approachStatus,
  approachSubject,
  resetShipApproach,
  safeShare,
  shipApproach,
  updateApproach,
  type ApproachInput,
  type ApproachStatus,
} from './approach'

const FRAME = 1 / 60

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

function body(key: keyof typeof BODY_MASS_KG, x = 0, y = 0, z = 0, radius = 1): Body {
  return { key, position: new THREE.Vector3(x, y, z), radius, mass: BODY_MASS_KG[key] }
}

interface Sample {
  t: number
  gap: number
  speed: number
  cap: number
  closing: number
  /** shipApproach as the HUD would read it this frame. */
  eta: number
  status: ApproachStatus
}

/**
 * Fly straight at `subject` (on the −Z axis from +Z) from `start` units off
 * its surface, already at `throttle` × V_TOP, holding `throttle`, until the
 * ship hits or `seconds` pass; shipApproach is updated every frame, as
 * ShipTargeting does.
 */
function approach(
  subject: Body,
  { start, throttle, locked, seconds = 600, flightAssist = true, speed = throttle * V_TOP }: {
    start: number
    throttle: number
    /** Initial speed toward it; throttle × V_TOP by default. */
    speed?: number
    locked: boolean
    seconds?: number
    flightAssist?: boolean
  }
): Sample[] {
  const state = createShipState()
  state.position.set(0, 0, subject.radius + start).add(subject.position)
  state.velocity.set(0, 0, -speed)
  const telemetry = createShipTelemetry()
  const bodies = [subject]
  const pilot = input({ throttle, flightAssist })
  const targetKey = locked ? subject.key : null
  const km = [NaN]
  resetShipApproach()
  const samples: Sample[] = []
  for (let t = 0; t < seconds; t += FRAME) {
    stepShip(state, pilot, FRAME, { bodies, targetKey }, telemetry)
    updateApproach({
      bodies,
      position: state.position,
      velocity: state.velocity,
      speed: telemetry.speed,
      cap: telemetry.speedCap,
      capFloor: telemetry.well.floor,
      throttle: telemetry.throttle,
      flightAssist,
      targetKey,
      km,
    })
    samples.push({
      t: t + FRAME,
      gap: telemetry.nearest.surfaceDistance,
      speed: telemetry.speed,
      cap: telemetry.speedCap,
      closing: -state.velocity.z,
      eta: shipApproach.eta,
      status: shipApproach.status,
    })
    if (telemetry.colliding || telemetry.nearest.surfaceDistance < 0.03) break
  }
  return samples
}

describe('safeShare', () => {
  test('is the throttle a light well can stop from, and 1 for heavy ones', () => {
    const moon = safeShare(wellFactor(BODY_MASS_KG.moon))
    const mars = safeShare(wellFactor(BODY_MASS_KG.mars))
    expect(moon).toBeGreaterThan(0.6)
    expect(moon).toBeLessThan(0.8)
    expect(mars).toBeGreaterThan(moon)
    expect(mars).toBeLessThan(SAFE_SHARE_FULL)
    // Earth and Venus peak at ~1.1× the cap at full throttle and land
    // gently: no tick, no warning.
    for (const key of ['venus', 'earth', 'jupiter', 'saturn', 'sun'] as const) {
      expect(safeShare(wellFactor(BODY_MASS_KG[key]))).toBe(1)
    }
  })

  test.each(['moon', 'mercury', 'mars', 'venus', 'earth'] as const)(
    'matches the flight model at %s: under it the run stays under the cap, over it the ship overshoots',
    (key) => {
      const subject = body(key)
      const share = safeShare(wellFactor(subject.mass))
      const T = wellFactor(subject.mass) / K_WELL
      const peak = (throttle: number) => {
        const run = approach(subject, { start: V_TOP * T * 1.2, throttle, locked: false })
        return Math.max(...run.map((s) => s.speed / s.cap))
      }
      expect(peak(share - 0.04)).toBeLessThanOrEqual(OVER_ON)
      if (share + 0.04 <= 1) expect(peak(share + 0.04)).toBeGreaterThan(OVER_ON)
    }
  )
})

describe("Earth's ground speed (tides-01v.8.7)", () => {
  test('full throttle still rides Earth down to its lower floor without an overshoot warning', () => {
    expect(safeShare(wellFactor(BODY_MASS_KG.earth), EARTH_GROUND_SPEED)).toBe(1)
  })

  test('the ETA runs on past V_NORMAL to the lower floor, crossing it at share · floor', () => {
    const wellTime = wellFactor(BODY_MASS_KG.earth) / K_WELL
    const floorGap = EARTH_GROUND_SPEED * wellTime
    expect(approachEta(floorGap, 1, wellTime, 1, EARTH_GROUND_SPEED)).toBeCloseTo(floorGap / EARTH_GROUND_SPEED, 9)
    expect(approachEta(floorGap, 1, wellTime, 1)).toBeLessThan(approachEta(floorGap, 1, wellTime, 1, EARTH_GROUND_SPEED))
  })

  test('keeps the ETA and the subject at part throttle near the ground', () => {
    const wellTime = wellFactor(BODY_MASS_KG.earth) / K_WELL
    // 0.3 throttle at the ground speed: under the V_NORMAL-scaled threshold.
    const closing = 0.3 * EARTH_GROUND_SPEED
    expect(approachEta(0.05, closing, wellTime, 0.3, EARTH_GROUND_SPEED)).toBeCloseTo(0.05 / closing, 9)
    const earth: Body = { key: 'earth', position: new THREE.Vector3(), radius: 1, minSpeed: EARTH_GROUND_SPEED }
    const position = new THREE.Vector3(1.05, 0, 0)
    expect(approachSubject([earth], position, new THREE.Vector3(-closing, 0, 0), null, null)).toBe(0)
    expect(approachSubject([{ ...earth, minSpeed: undefined }], position, new THREE.Vector3(-closing, 0, 0), null, null)).toBe(-1)
  })
})

describe("touching Earth's ground (tides-01v.8.17)", () => {
  test('its floor is too low for an arrival to crash; the V_NORMAL floor is not', () => {
    expect(canCrash(EARTH_GROUND_SPEED)).toBe(false)
    expect(canCrash(V_NORMAL)).toBe(true)
  })

  test.each([
    [false, 1],
    [false, 0],
    [true, 1],
  ] as const)(
    'an unlocked dive to the floor (Flight Assist %s, throttle %s) lands without an impact or a warning',
    (flightAssist, throttle) => {
      const earth: Body = { ...body('earth'), minSpeed: EARTH_GROUND_SPEED }
      const T = wellFactor(earth.mass) / K_WELL
      const state = createShipState()
      state.position.set(0, 0, earth.radius + V_TOP * T * 1.2)
      state.velocity.set(0, 0, -V_TOP)
      const telemetry = createShipTelemetry()
      const bodies = [earth]
      const pilot = input({ throttle, flightAssist })
      const km = [NaN]
      resetShipApproach()
      const statuses = new Set<ApproachStatus>()
      let peak = 0
      let wasColliding = false
      let impacts = 0
      let landed = false
      for (let t = 0; t < 300 && !landed; t += FRAME) {
        const speedBefore = telemetry.speed
        stepShip(state, pilot, FRAME, { bodies, targetKey: null }, telemetry)
        if (isImpact(telemetry.colliding, wasColliding, speedBefore)) impacts++
        wasColliding = telemetry.colliding
        peak = Math.max(peak, telemetry.speed / telemetry.speedCap)
        updateApproach({
          bodies,
          position: state.position,
          velocity: state.velocity,
          speed: telemetry.speed,
          cap: telemetry.speedCap,
          capFloor: telemetry.well.floor,
          throttle: telemetry.throttle,
          flightAssist,
          targetKey: null,
          km,
        })
        statuses.add(shipApproach.status)
        landed = state.position.length() - collisionRadius(earth) < 1e-6
      }
      expect(landed).toBe(true)
      expect(impacts).toBe(0)
      expect(statuses.has('over')).toBe(false)
      expect(statuses.has('fast')).toBe(false)
      expect(statuses.has('closing')).toBe(true)
      // The run does go over the cap: what used to read as overshooting.
      if (!flightAssist) expect(peak).toBeGreaterThan(OVER_ON)
    }
  )
})

describe("over Earth's ground, over its cap (tides-01v.8.17)", () => {
  // Levelled off after a Flight Assist off dive: 2.5× Earth's ground cap,
  // with something else (the Sun, a locked Moon) as the subject.
  const skim: ApproachInput = {
    speed: 2.5 * EARTH_GROUND_SPEED,
    cap: EARTH_GROUND_SPEED,
    capFloor: EARTH_GROUND_SPEED,
    closing: 0.01,
    gap: 1000,
    factor: 1,
    locked: false,
    throttle: 1,
    flightAssist: false,
  }

  test('is not overshooting the subject when the well setting the cap is soft ground', () => {
    expect(approachStatus(skim, null)).toBe('closing')
    expect(approachStatus({ ...skim, locked: true }, null)).toBe('locked')
  })

  test('is overshooting when that well can be hit hard, whatever the subject', () => {
    const hard = { ...skim, speed: 2.5 * V_NORMAL, cap: V_NORMAL, capFloor: V_NORMAL }
    expect(approachStatus(hard, null)).toBe('over')
    expect(approachStatus({ ...hard, speedFloor: EARTH_GROUND_SPEED }, null)).toBe('over')
  })
})

describe('approachEta', () => {
  test('is Infinity when not closing, and gap / closing below the floor speed', () => {
    expect(approachEta(10, 0, 2)).toBe(Infinity)
    expect(approachEta(10, -1, 2)).toBe(Infinity)
    expect(approachEta(10, NaN, 2)).toBe(Infinity)
    expect(approachEta(10, 0.1, 2)).toBeCloseTo(100)
    // Resting on a surface: no ETA, rather than hours.
    expect(approachEta(0.02, 1e-6, 2)).toBe(Infinity)
  })

  test.each([1, 0.5])(
    'counts down along a locked approach to the Moon at throttle %s, within 15% of the arrival',
    (throttle) => {
      const moon = body('moon')
      const run = approach(moon, { start: 500, throttle, locked: true })
      const arrival = run[run.length - 1].t
      // It arrives, rather than sticking at the well time.
      expect(run[run.length - 1].gap).toBeLessThan(0.05)
      // From a second in, once the velocity has settled to the throttle.
      const settled = run.filter((s) => s.t > 1)
      expect(Math.abs(settled[0].eta - (arrival - settled[0].t)) / (arrival - settled[0].t)).toBeLessThan(0.15)
      for (let i = 1; i < settled.length; i++) {
        expect(settled[i].eta).toBeLessThan(settled[i - 1].eta + 1e-9)
      }
      // gap / closing, the old ETA, sticks near the well time in the well.
      const deep = settled.find((s) => s.gap < 5)!
      expect(deep.gap / deep.closing).toBeGreaterThan(1.5)
      expect(Math.abs(deep.eta - (arrival - deep.t))).toBeLessThan(0.15 * (arrival - deep.t) + 0.5)
    }
  )

  test('a locked approach is always locked, never fast or over', () => {
    const run = approach(body('moon'), { start: 500, throttle: 1, locked: true })
    expect(new Set(run.map((s) => s.status))).toEqual(new Set(['locked']))
  })
})

describe('approachStatus', () => {
  const base: ApproachInput = {
    speed: 10,
    cap: 20,
    closing: 10,
    gap: 1000,
    factor: 1,
    locked: false,
    throttle: 0.5,
    flightAssist: true,
  }

  test('over the cap is overshooting, with hysteresis, even when locked', () => {
    expect(approachStatus({ ...base, speed: 31 }, null)).toBe('over')
    expect(approachStatus({ ...base, speed: 31, locked: true }, null)).toBe('over')
    // Up to 1.5× the cap still lands gently: not a warning.
    expect(approachStatus({ ...base, speed: 29 }, null)).not.toBe('over')
    expect(approachStatus({ ...base, speed: 29 }, 'over')).toBe('over')
    // Settled back at the cap at full throttle: clears rather than latching.
    expect(approachStatus({ ...base, speed: 20, throttle: 1 }, 'over')).not.toBe('over')
  })

  test('open when not closing; no warning far outside the well', () => {
    expect(approachStatus({ ...base, closing: -1 }, null)).toBe('open')
    const edge = V_TOP * (1 / K_WELL)
    expect(approachStatus({ ...base, throttle: 1, closing: 150, speed: 150, cap: 150, gap: edge + 150 * (FAST_WINDOW_S + 1) }, null)).toBe('closing')
    expect(approachStatus({ ...base, throttle: 1, closing: 150, speed: 150, cap: 150, gap: edge + 150 * (FAST_WINDOW_S - 1) }, null)).toBe('fast')
  })

  test.each([
    ['moon', 0.4],
    ['moon', 0.55],
    ['moon', 0.8],
    ['moon', 1],
    ['mars', 0.7],
    ['mars', 1],
    ['earth', 0.9],
    ['earth', 1],
    ['jupiter', 1],
  ] as const)(
    'predicts "Too fast" at %s, throttle %s, exactly when the unlocked run goes over the cap',
    (key, throttle) => {
      const subject = body(key)
      const T = wellFactor(subject.mass) / K_WELL
      const run = approach(subject, { start: V_TOP * T + V_TOP * (FAST_WINDOW_S + 5), throttle, locked: false })
      const overshoots = run.some((s) => s.speed > OVER_ON * s.cap)
      // The warning, before the overshoot shows on the speed.
      const firstWarning = run.findIndex((s) => s.status === 'fast')
      const firstOver = run.findIndex((s) => s.status === 'over')
      expect(firstWarning >= 0).toBe(overshoots)
      expect(firstOver >= 0).toBe(overshoots)
      if (overshoots) expect(firstWarning).toBeLessThan(firstOver)
    }
  )

  test('with Flight Assist off, coasting into a light well is too fast', () => {
    const subject = body('moon')
    const run = approach(subject, { start: 50, throttle: 0, speed: 10, locked: false, flightAssist: false, seconds: 30 })
    expect(run.some((s) => s.status === 'fast')).toBe(true)
  })
})

describe('approachSubject', () => {
  const ship = new THREE.Vector3(0, 0, 0)
  const forward = new THREE.Vector3(0, 0, -1)

  test('the locked target, wherever it is', () => {
    const bodies = [body('moon', 0, 0, -10), body('mars', 0, 0, 50)]
    expect(approachSubject(bodies, ship, forward, 'mars', null)).toBe(1)
  })

  test('unlocked, the nearest well within the cone of the velocity; nothing at rest', () => {
    const off = Math.tan(AHEAD_CONE) * 100
    const bodies = [
      body('moon', 0, 0, -100),
      body('mars', off * 1.2, 0, -100),
      body('jupiter', 0, 0, 40),
    ]
    expect(approachSubject(bodies, ship, forward, null, null)).toBe(0)
    expect(approachSubject(bodies, ship, new THREE.Vector3(), null, null)).toBe(-1)
    // The Moon in front of a heavier well: the Moon is what the ship meets.
    const ahead = [body('moon', 0, 0, -100), body('earth', 2, 0, -150)]
    expect(approachSubject(ahead, ship, forward, null, null)).toBe(0)
  })

  test('keeps the shown body until another is clearly nearer', () => {
    const bodies = [body('moon', 0, 0, -100), body('mercury', 1, 0, -100)]
    const mercuryFirst = approachSubject(bodies, ship, forward, null, null)
    const other = bodies[1 - mercuryFirst].key
    expect(approachSubject(bodies, ship, forward, null, other)).toBe(1 - mercuryFirst)
  })
})

describe('approachEta over a ground speed law (tides-zmw.9.18)', () => {
  const M = EARTH_UNITS_PER_METRE
  const law = EARTH_GROUND_SPEED_LAW
  const ground = { law, stop: FINE_GROUND_CLEARANCE }
  const wellTime = wellFactor(BODY_MASS_KG.earth) / K_WELL

  test('the plateau, then the gap e-folding every 1 / (rate · share), then to the stop', () => {
    // On the plateau, closing at it: linear.
    const plateauGap = law.max / law.rate
    expect(approachEta(0.05, law.max, wellTime, 1, EARTH_SLOWEST, ground) - approachEta(plateauGap, law.max, wellTime, 1, EARTH_SLOWEST, ground)).toBeCloseTo((0.05 - plateauGap) / law.max, 9)
    // From the plateau's foot down to the stop at full share: ln(foot / stop) / rate.
    expect(approachEta(plateauGap, law.max, wellTime, 1, EARTH_SLOWEST, ground)).toBeCloseTo(Math.log(plateauGap / FINE_GROUND_CLEARANCE) / law.rate, 9)
    // Half throttle: twice as long.
    expect(approachEta(1000 * M, 0.5 * law.rate * 1000 * M, wellTime, 0.5, EARTH_SLOWEST, ground)).toBeCloseTo(Math.log(1000 / 30) / (0.5 * law.rate), 9)
    expect(approachEta(FINE_GROUND_CLEARANCE, 1e-4, wellTime, 1, EARTH_SLOWEST, ground)).toBe(0)
    expect(approachEta(1, 0, wellTime, 1, EARTH_SLOWEST, ground)).toBe(Infinity)
  })

  test.each([0.5, 1])('a locked descent at throttle %s from 5 km arrives within 15%% of the ETA it starts with', (throttle) => {
    const earth: Body = {
      key: 'earth',
      position: new THREE.Vector3(),
      radius: EARTH_RADIUS,
      collisionRadius: EARTH_RADIUS + 10 * M,
      mass: BODY_MASS_KG.earth,
      ground: () => EARTH_RADIUS,
      groundClearance: FINE_GROUND_CLEARANCE,
      minSpeed: EARTH_SLOWEST,
      groundSpeed: law,
    }
    const state = createShipState()
    state.position.set(0, EARTH_RADIUS + 5000 * M, 0)
    // Nose down, already at its steady speed.
    state.orientation.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
    state.velocity.set(0, -throttle * law.rate * 5000 * M, 0)
    const eta = approachEta(5000 * M, -state.velocity.y, wellTime, throttle, EARTH_SLOWEST, ground)
    const input: ShipInput = { throttle, strafeX: 0, strafeY: 0, pitch: 0, yaw: 0, roll: 0, level: false, flightAssist: true }
    const telemetry = createShipTelemetry()
    let t = 0
    for (; t < 60; t += 1 / 60) {
      stepShip(state, input, 1 / 60, { bodies: [earth], targetKey: 'earth' }, telemetry)
      // Arrived: within a metre of the stop.
      if (telemetry.nearest.surfaceDistance < FINE_GROUND_CLEARANCE + 1 * M) break
    }
    expect(Math.abs(t / eta - 1)).toBeLessThan(0.15)
  })
})
