import { describe, expect, test } from 'vitest'
import { SEA_LEVEL_DENSITY, airDensity } from './frame-carry'
import {
  SHAKE_BOOST_GAIN,
  SHAKE_EPSILON,
  SHAKE_FALL_TAU,
  SHAKE_HZ,
  SHAKE_MAX_INTENSITY,
  SHAKE_MIN_VIEW_PX,
  SHAKE_PX,
  SHAKE_Q_MIN,
  SHAKE_Q_REF,
  SHAKE_RISE_TAU,
  SHAKE_ROLL_SHARE,
  SHAKE_WEIGHTS,
  airShakeShare,
  easeShake,
  shakeAngles,
  shakeNoise,
  shakeRadiansPerPx,
  shakeTarget,
  type ShakeAngles,
} from './shake'

/** Dynamic pressure, Pa, `km` up at `speed` m/s through the air. */
const q = (km: number, speed: number) => 0.5 * SEA_LEVEL_DENSITY * airDensity(km) * speed * speed
const AXES = [0, 1, 2] as const
const FRAME = 1 / 60
const angles = (): ShakeAngles => ({ pitch: 0, yaw: 0, roll: 0 })
// A 60° view 900 CSS px tall.
const DESKTOP = shakeRadiansPerPx(60, 900)

describe('shake target', () => {
  test('none in vacuum: no pressure, the plateau speed from 150 km up, nonsense', () => {
    expect(shakeTarget(0, 0, false)).toBe(0)
    expect(q(150, 43000)).toBeLessThan(SHAKE_Q_MIN)
    expect(shakeTarget(q(150, 43000), 0, false)).toBe(0)
    expect(shakeTarget(q(200, 43000), 1, true)).toBe(0)
    expect(shakeTarget(NaN, 1, true)).toBe(0)
    expect(shakeTarget(-5, 1, true)).toBe(0)
    expect(shakeTarget(Infinity, 1, true)).toBe(0)
    expect(airShakeShare(SHAKE_Q_MIN)).toBe(0)
  })

  test('none at rest, even at sea level and boosted', () => {
    expect(shakeTarget(q(0, 0), 0, false)).toBe(0)
    expect(shakeTarget(q(0, 0), 1, true)).toBe(0)
  })

  test('grows with the density and the speed, strictly above the floor', () => {
    let last = 0
    for (let km = 60; km >= 0; km -= 2) {
      const share = airShakeShare(q(km, 300))
      expect(share).toBeGreaterThanOrEqual(last)
      if (last > 0) expect(share).toBeGreaterThan(last)
      last = share
    }
    expect(last).toBeGreaterThan(0)
    last = 0
    for (let speed = 0; speed <= 1000; speed += 25) {
      const share = airShakeShare(q(5, speed))
      expect(share).toBeGreaterThanOrEqual(last)
      if (last > 0) expect(share).toBeGreaterThan(last)
      last = share
    }
    expect(last).toBeGreaterThan(0)
  })

  test('half the air floor at sea level is the reference, and the share never reaches 1', () => {
    expect(SHAKE_Q_REF).toBeCloseTo(q(0, 200) / 2, 6)
    expect(airShakeShare(q(0, 200))).toBeGreaterThan(0.8)
    expect(airShakeShare(SHAKE_Q_REF + SHAKE_Q_MIN)).toBeCloseTo(1 - 1 / Math.E, 12)
    for (const pressure of [1e3, 1e5, 1e7, 1e9]) expect(airShakeShare(pressure)).toBeLessThanOrEqual(1)
    expect(airShakeShare(1e5)).toBeLessThan(1)
  })

  test('the boost: full spool raises it by the gain, only while it raises the cap', () => {
    const pressure = q(2, 400)
    const plain = shakeTarget(pressure, 0, false)
    expect(plain).toBeGreaterThan(0)
    expect(shakeTarget(pressure, 1, true)).toBeCloseTo(plain * (1 + SHAKE_BOOST_GAIN), 12)
    let last = plain
    for (let spool = 0; spool <= 1; spool += 0.1) {
      const target = shakeTarget(pressure, spool, true)
      expect(target).toBeGreaterThanOrEqual(last)
      last = target
    }
    expect(shakeTarget(pressure, 1, false)).toBe(plain)
    expect(shakeTarget(pressure, 2, true)).toBeCloseTo(plain * (1 + SHAKE_BOOST_GAIN), 12)
    expect(shakeTarget(pressure, NaN, true)).toBe(plain)
    expect(shakeTarget(0, 1, true)).toBe(0)
    expect(shakeTarget(1e12, 1, true)).toBeLessThanOrEqual(SHAKE_MAX_INTENSITY)
  })

  test('none under reduced motion', () => {
    expect(shakeTarget(q(0, 400), 1, true, true)).toBe(0)
  })
})

describe('shake signal', () => {
  test('bounded, and exactly still at intensity 0', () => {
    const out = angles()
    for (let t = 0; t <= 1e4; t += 0.37) {
      for (const axis of AXES) expect(Math.abs(shakeNoise(t, axis))).toBeLessThanOrEqual(1)
      shakeAngles(t, SHAKE_MAX_INTENSITY, DESKTOP, out)
      const peak = SHAKE_PX * DESKTOP * SHAKE_MAX_INTENSITY
      expect(Math.abs(out.pitch)).toBeLessThanOrEqual(peak)
      expect(Math.abs(out.yaw)).toBeLessThanOrEqual(peak)
      expect(Math.abs(out.roll)).toBeLessThanOrEqual(SHAKE_ROLL_SHARE * peak)
      shakeAngles(t, 0, DESKTOP, out)
      expect(out).toEqual({ pitch: 0, yaw: 0, roll: 0 })
    }
    shakeAngles(3, 1, DESKTOP, out)
    shakeAngles(3, NaN, DESKTOP, out)
    expect(out).toEqual({ pitch: 0, yaw: 0, roll: 0 })
  })

  test('sized in screen pixels: the same px on a short view, but not wilder than a minimum view', () => {
    expect(shakeRadiansPerPx(60, 900)).toBeCloseTo(Math.tan(Math.PI / 6) / 450, 12)
    expect(shakeRadiansPerPx(60, 450)).toBeCloseTo(2 * shakeRadiansPerPx(60, 900), 12)
    expect(shakeRadiansPerPx(60, 50)).toBe(shakeRadiansPerPx(60, SHAKE_MIN_VIEW_PX))
    expect(shakeRadiansPerPx(NaN, 900)).toBe(0)
    expect(shakeRadiansPerPx(60, NaN)).toBe(0)
    // Peak boosted on a desktop: a few px, still well under a degree.
    expect(SHAKE_PX * DESKTOP * SHAKE_MAX_INTENSITY).toBeLessThan((0.5 * Math.PI) / 180)
  })

  test('deterministic in time', () => {
    const a = shakeAngles(12.34, 1.7, DESKTOP, angles())
    const b = shakeAngles(12.34, 1.7, DESKTOP, angles())
    expect(a).toEqual(b)
    expect(a.pitch).not.toBe(0)
  })

  test('smooth from frame to frame, and it moves', () => {
    const weightSum = SHAKE_WEIGHTS.reduce((a, b) => a + b, 0)
    for (const axis of AXES) {
      const rate = (2 * Math.PI * SHAKE_HZ[axis].reduce((sum, hz, i) => sum + SHAKE_WEIGHTS[i] * hz, 0)) / weightSum
      let min = Infinity
      let max = -Infinity
      for (let t = 0; t < 2; t += FRAME) {
        const step = Math.abs(shakeNoise(t + FRAME, axis) - shakeNoise(t, axis))
        expect(step).toBeLessThanOrEqual(rate * FRAME + 1e-12)
        min = Math.min(min, shakeNoise(t, axis))
        max = Math.max(max, shakeNoise(t, axis))
      }
      expect(max - min).toBeGreaterThan(0.5)
    }
  })
})

describe('shake easing', () => {
  test('rises over the rise time constant without overshoot', () => {
    expect(easeShake(0, 1, SHAKE_RISE_TAU)).toBeCloseTo(1 - 1 / Math.E, 12)
    let x = 0
    for (let i = 0; i < 600; i++) {
      x = easeShake(x, 1, FRAME)
      expect(x).toBeLessThanOrEqual(1)
    }
  })

  test('falls over the fall time constant without undershoot', () => {
    expect(easeShake(1, 0.5, SHAKE_FALL_TAU)).toBeCloseTo(0.5 + 0.5 / Math.E, 12)
    let x = 1
    for (let i = 0; i < 600; i++) {
      x = easeShake(x, 0.5, FRAME)
      expect(x).toBeGreaterThanOrEqual(0.5)
    }
  })

  test('frame-rate independent; dt 0 changes nothing', () => {
    let x = 0
    for (let i = 0; i < 60; i++) x = easeShake(x, 2, FRAME)
    expect(x).toBeCloseTo(easeShake(0, 2, 1), 9)
    expect(easeShake(0.4, 2, 0)).toBeCloseTo(0.4, 12)
  })

  test('easing out reaches exactly 0 in a finite time', () => {
    let x = SHAKE_MAX_INTENSITY
    let frames = 0
    while (x !== 0 && frames < 10_000) {
      x = easeShake(x, 0, FRAME)
      frames++
    }
    expect(x).toBe(0)
    expect(frames).toBeLessThan(60 * SHAKE_FALL_TAU * Math.log(SHAKE_MAX_INTENSITY / SHAKE_EPSILON) + 2)
  })

  test('a broken intensity starts over at the target', () => {
    expect(easeShake(NaN, 0.7, FRAME)).toBe(0.7)
    expect(easeShake(Infinity, 0, FRAME)).toBe(0)
  })
})
