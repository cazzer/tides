import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  dayFade,
  DAY_FLOOR,
  FLASH_MAX_S,
  FLASH_MIN_S,
  FLASH_TAIL_S,
  PULSE_ATTACK_S,
  PULSE_DECAY_S,
  displayMs,
  emitCrossed,
  flashBrightness,
  flashIntensity,
  flashRadiusKm,
  flashSeed,
  FLASH_LIFETIME_S,
  FUTURE_SLACK_MS,
  hashKey,
  isJump,
  lightningCaps,
  lightningClock,
  LIVE_LAG_MS,
  pulseCount,
  windowStride,
  WINDOW_MS,
  type FlashBatch,
} from './lightning'

function batch(offsetsMs: number[], owned = offsetsMs.map(() => 1)): FlashBatch {
  const n = offsetsMs.length
  return {
    source: 'glm',
    key: 'k',
    startMs: 1_000_000,
    count: n,
    lat: new Float32Array(n),
    lon: new Float32Array(n),
    offsetMs: Float32Array.from(offsetsMs),
    durationMs: new Float32Array(n),
    energyJ: new Float32Array(n),
    areaKm2: new Float32Array(n),
    owned: Uint8Array.from(owned),
  }
}

const collect = (b: FlashBatch, stride: number, from: number, to: number, cap = Infinity) => {
  const got: number[] = []
  const n = emitCrossed(b, stride, from, to, (_, i) => {
    if (got.length >= cap) return false
    got.push(i)
    return true
  })
  expect(n).toBe(got.length)
  return got
}

describe('the lightning clock', () => {
  const now = Date.UTC(2026, 10, 13, 12)
  test('live plays the newest data LIVE_LAG_MS late; the past as it is; a forecast as it is', () => {
    expect(lightningClock(now, now)).toBe(now - LIVE_LAG_MS)
    expect(lightningClock(now + FUTURE_SLACK_MS, now)).toBe(now - LIVE_LAG_MS)
    expect(lightningClock(now - 3_600_000, now)).toBe(now - 3_600_000)
    expect(lightningClock(now + FUTURE_SLACK_MS + 1, now)).toBe(now + FUTURE_SLACK_MS + 1)
  })

  test('sped up, every stride-th window: at most one per ~5 s of wall time', () => {
    expect([0, 1, -1, 4, 5, 8, 60, -60, 3600].map(windowStride)).toEqual([1, 1, 1, 1, 2, 2, 16, 16, 1024])
    for (const rate of [5, 8, 30, 60, 600, 3600, 86_400]) {
      expect((windowStride(rate) * WINDOW_MS) / rate).toBeGreaterThanOrEqual(5000)
    }
  })

  test('a step of more than two strides of windows is a jump', () => {
    expect(isJump(0, 2 * WINDOW_MS, 1)).toBe(false)
    expect(isJump(0, 2 * WINDOW_MS + 1, 1)).toBe(true)
    expect(isJump(0, -2 * WINDOW_MS * 16, 16)).toBe(false)
  })
})

describe('emitCrossed', () => {
  const b = batch([-1000, 0, 500, 500, 9000, 19_000])

  test('forward, the flashes in (from, to]', () => {
    expect(collect(b, 1, b.startMs - 2000, b.startMs)).toEqual([0, 1])
    expect(collect(b, 1, b.startMs, b.startMs + 500)).toEqual([2, 3])
    expect(collect(b, 1, b.startMs + 500, b.startMs + 8999)).toEqual([])
  })

  test('backward, the flashes in [to, from)', () => {
    expect(collect(b, 1, b.startMs + 500, b.startMs)).toEqual([1])
    expect(collect(b, 1, b.startMs + 9500, b.startMs + 500)).toEqual([2, 3, 4])
  })

  test('display times stretch with the stride', () => {
    expect(displayMs(b, 4, 16)).toBe(b.startMs + 9000 * 16)
    expect(collect(b, 16, b.startMs + 9000, b.startMs + 9000 * 16)).toEqual([4])
  })

  test('skips flashes another batch owns, and stops when emit says so', () => {
    expect(collect(batch([1, 2, 3, 4], [1, 0, 1, 1]), 1, 0, 2_000_000)).toEqual([0, 2, 3])
    expect(collect(b, 1, 0, 2_000_000, 2)).toEqual([0, 1])
    expect(collect(batch([]), 1, 0, 2_000_000)).toEqual([])
  })
})

describe('the flicker (vertex.glsl mirror)', () => {
  test('1 to 3 pulses by seed', () => {
    expect([0, 0.33, 0.34, 0.66, 0.67, 0.999].map(pulseCount)).toEqual([1, 1, 2, 2, 3, 3])
  })

  test('a 5 ms rise, a 35 ms fall, gone after the duration and its tail', () => {
    const seed = 0.1
    expect(flashIntensity(-0.001, 0.2, seed)).toBe(0)
    expect(flashIntensity(0.0025, 0.2, seed)).toBeCloseTo(0.5, 5)
    expect(flashIntensity(0.005, 0.2, seed)).toBeCloseTo(1, 5)
    expect(flashIntensity(0.04, 0.2, seed)).toBeCloseTo(Math.exp(-1), 5)
    expect(flashIntensity(0.2 + 0.15 + 0.001, 0.2, seed)).toBe(0)
    // Durations clamp to 0.1..0.4 s: never past FLASH_LIFETIME_S.
    expect(flashIntensity(FLASH_LIFETIME_S + 0.001, 3, seed)).toBe(0)
    expect(flashIntensity(0.24, 0.001, seed)).toBeGreaterThan(0)
    expect(flashIntensity(0.26, 0.001, seed)).toBe(0)
  })

  test('later pulses relight it, dimmer', () => {
    const seed = 0.9 // 3 pulses over 0.3 s: at 0, 0.1, 0.2
    expect(pulseCount(seed)).toBe(3)
    const before = flashIntensity(0.099, 0.3, seed)
    const second = flashIntensity(0.105, 0.3, seed)
    expect(second).toBeGreaterThan(before * 5)
    expect(second).toBeLessThan(1)
    expect(second).toBeGreaterThanOrEqual(0.5)
  })

  test('brightness by energy, glow radius by footprint', () => {
    expect(flashBrightness(1e-15)).toBe(0.15)
    expect(flashBrightness(1e-13)).toBeCloseTo(2 / 3, 5)
    expect(flashBrightness(3.5e-12)).toBe(1)
    expect(flashBrightness(0)).toBe(0.15)
    expect(flashRadiusKm(64)).toBeCloseTo(Math.sqrt(64 / Math.PI) * 2.5, 5)
    expect(flashRadiusKm(1)).toBe(8)
    expect(flashRadiusKm(6800)).toBe(80)
  })

  test('the day side keeps DAY_FLOOR of a flash', () => {
    expect(dayFade(-0.5)).toBe(1)
    expect(dayFade(-0.1)).toBe(1)
    expect(dayFade(0.15)).toBeCloseTo(DAY_FLOOR, 10)
    expect(dayFade(1)).toBeCloseTo(DAY_FLOOR, 10)
    expect(dayFade(0.025)).toBeGreaterThan(DAY_FLOOR)
    expect(dayFade(0.025)).toBeLessThan(1)
  })

  test('seeds are stable, spread over 0..1', () => {
    const h = hashKey('OR_GLM-L2-LCFA_G19_s20263170000000')
    expect(hashKey('OR_GLM-L2-LCFA_G19_s20263170000000')).toBe(h)
    const seeds = Array.from({ length: 3000 }, (_, i) => flashSeed(h, i))
    expect(Math.min(...seeds)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...seeds)).toBeLessThan(1)
    const thirds = [0, 1, 2].map((k) => seeds.filter((s) => pulseCount(s) === k + 1).length)
    for (const n of thirds) expect(n).toBeGreaterThan(800)
  })

  test("the shader's constants are these", () => {
    const glsl = readFileSync(new URL('./shaders/lightning/vertex.glsl', import.meta.url), 'utf8')
    const define = (name: string) => Number(glsl.match(new RegExp(`#define ${name} ([\\d.]+)`))?.[1])
    expect(define('FLASH_MIN_S')).toBe(FLASH_MIN_S)
    expect(define('FLASH_MAX_S')).toBe(FLASH_MAX_S)
    expect(define('FLASH_TAIL_S')).toBe(FLASH_TAIL_S)
    expect(define('PULSE_ATTACK_S')).toBe(PULSE_ATTACK_S)
    expect(define('PULSE_DECAY_S')).toBe(PULSE_DECAY_S)
    expect(define('DAY_FLOOR')).toBe(DAY_FLOOR)
    expect(glsl).toContain('smoothstep(-0.10, 0.15, dot(dir, uSun))')
    expect(glsl).toContain('0.5 + 0.4 * fract(seed * (fk + 1.0) * 13.7)')
  })

  test('caps: a bounded ring and per-frame starts, smaller on the low tier and phones', () => {
    expect(lightningCaps(false)).toEqual({ capacity: 1024, perFrame: 96 })
    expect(lightningCaps(true)).toEqual({ capacity: 256, perFrame: 24 })
  })
})
