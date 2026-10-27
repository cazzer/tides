import { describe, expect, it } from 'vitest'
import {
  BOOST_GAIN,
  BOOST_IDLE_SHARE,
  boostParams,
  engineDrive,
  engineParams,
  ENGINE_HZ,
  thrustLevel,
  WIND_Q_FULL,
  WIND_Q_MIN,
  windLevel,
  windParams,
} from './engine-mix'

const engine = () => ({ hz: 0, gain: 0, cutoff: 0, noiseGain: 0 })
const pair = () => ({ gain: 0, hz: 0 })

describe('engineDrive (tides-a4j.2)', () => {
  it('rises with the throttle and with the speed over its cap', () => {
    expect(engineDrive(0, 0, 10)).toBe(0)
    expect(engineDrive(0.5, 0, 10)).toBeGreaterThan(engineDrive(0.2, 0, 10))
    expect(engineDrive(1, 0, 10)).toBeGreaterThan(engineDrive(0.5, 0, 10))
    expect(engineDrive(0.5, 5, 10)).toBeGreaterThan(engineDrive(0.5, 2, 10))
    expect(engineDrive(1, 10, 10)).toBe(1)
  })

  it('hears the share of the cap, never the absolute speed', () => {
    expect(engineDrive(0.4, 3, 10)).toBeCloseTo(engineDrive(0.4, 3e6, 1e7), 12)
  })

  it('idles with no cap or a NaN one, and never passes 1', () => {
    expect(engineDrive(0, 5, 0)).toBe(0)
    expect(engineDrive(0, 5, NaN)).toBe(0)
    expect(engineDrive(NaN, 5, 10)).toBe(0)
    expect(engineDrive(1, 50, 10)).toBe(1)
  })

  it('works the engine in reverse by the throttle magnitude', () => {
    expect(engineDrive(-0.25, 0, 10)).toBeCloseTo(engineDrive(0.25, 0, 10), 12)
  })

  it('maps the drive onto the engine’s range', () => {
    expect(engineParams(0, engine()).hz).toBe(ENGINE_HZ[0])
    expect(engineParams(1, engine()).hz).toBe(ENGINE_HZ[1])
    const low = engineParams(0.2, engine())
    const high = engineParams(0.8, engine())
    for (const key of ['hz', 'gain', 'cutoff', 'noiseGain'] as const) expect(high[key]).toBeGreaterThan(low[key])
  })
})

describe('thrustLevel', () => {
  it('is 0 at rest and rises with the strafe and the throttle’s rate', () => {
    expect(thrustLevel(0, 0, 0)).toBe(0)
    expect(thrustLevel(1, 0, 0)).toBeGreaterThan(thrustLevel(0.5, 0, 0))
    expect(thrustLevel(0, -1, 0)).toBe(thrustLevel(1, 0, 0))
    expect(thrustLevel(0, 0, -0.8)).toBeGreaterThan(thrustLevel(0, 0, 0.2))
    expect(thrustLevel(1, 1, 50)).toBe(1)
    expect(thrustLevel(0, 0, NaN)).toBe(0)
  })
})

describe('boostParams', () => {
  it('is silent at no spool and sweeps up in level and pitch with it', () => {
    expect(boostParams(0, true, pair()).gain).toBe(0)
    let last = boostParams(0, true, pair())
    for (const spool of [0.25, 0.5, 0.75, 1]) {
      const next = boostParams(spool, true, pair())
      expect(next.gain).toBeGreaterThan(last.gain)
      expect(next.hz).toBeGreaterThan(last.hz)
      last = next
    }
    expect(last.gain).toBe(BOOST_GAIN)
  })

  it('plays plainly quieter where the boost raises nothing', () => {
    expect(boostParams(1, false, pair()).gain).toBeCloseTo(BOOST_GAIN * BOOST_IDLE_SHARE, 12)
    expect(boostParams(1, false, pair()).hz).toBe(boostParams(1, true, pair()).hz)
  })
})

describe('windLevel', () => {
  it('is exactly 0 in space, at a hover and for nonsense', () => {
    for (const q of [0, -1, NaN, Infinity, WIND_Q_MIN]) expect(windLevel(q)).toBe(0)
  })

  it('rises with the log of the dynamic pressure', () => {
    expect(windLevel(200)).toBeGreaterThan(windLevel(100))
    // Each tenfold step adds the same.
    expect(windLevel(2000) - windLevel(200)).toBeCloseTo(windLevel(20_000) - windLevel(2000), 12)
  })

  it('reads ~0.83 at sea level at 200 m/s, and 1 from full', () => {
    expect(windLevel(0.5 * 1.225 * 200 ** 2)).toBeCloseTo(0.835, 2)
    expect(windLevel(WIND_Q_FULL)).toBe(1)
    expect(windLevel(10 * WIND_Q_FULL)).toBe(1)
  })

  it('is silent at level 0 and opens its band with the level', () => {
    expect(windParams(0, pair()).gain).toBe(0)
    expect(windParams(0.8, pair()).hz).toBeGreaterThan(windParams(0.4, pair()).hz)
    expect(windParams(0.8, pair()).gain).toBeGreaterThan(windParams(0.4, pair()).gain)
  })
})
