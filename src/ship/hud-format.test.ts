import { describe, expect, test } from 'vitest'
import { V_TOP } from './flight'
import { formatDistance, formatSpeed } from './ship-distances'
import { approachAnnouncement, approachTail, speedParts, wellSuffix } from './hud-format'

describe('speedParts', () => {
  test('splits formatSpeed into number and unit', () => {
    expect(speedParts(formatSpeed(15_500))).toEqual([formatSpeed(15_500).replace(/\s*km\/s$/, ''), 'km/s'])
    expect(speedParts(formatSpeed(16 * 299_792.458))).toEqual(['16', 'c'])
    expect(speedParts(formatSpeed(NaN))).toEqual(['—', ''])
  })
})

describe('wellSuffix', () => {
  test('names the well only while it holds the cap down', () => {
    expect(wellSuffix('sun', 40)).toBe(" · Sun's well")
    expect(wellSuffix('io', 1)).toBe(" · Io's well")
    expect(wellSuffix('sun', V_TOP)).toBe('')
    expect(wellSuffix(null, 1)).toBe('')
  })
})

describe('approachTail', () => {
  test('the ETA, or the warning in its place', () => {
    expect(approachTail('closing', 9.2)).toBe('ETA 9 s')
    expect(approachTail('locked', 9.2)).toBe('ETA 9 s')
    expect(approachTail('open', Infinity)).toBe('')
    expect(approachTail('fast', 9.2)).toBe('Too fast')
    expect(approachTail('over', 9.2)).toBe('Overshooting')
  })

  test('announces only the warnings', () => {
    expect(approachAnnouncement('fast', 'moon')).toBe('Too fast to stop at Moon')
    expect(approachAnnouncement('over', 'moon')).toBe('Overshooting Moon')
    expect(approachAnnouncement('closing', 'moon')).toBeNull()
  })
})

describe('fine units (tides-zmw.9.18)', () => {
  test('km/h under 1 km/s and metres under 1 km with fine; the same text as before without', () => {
    expect(formatSpeed(0.15, true)).toBe('540 km/h')
    expect(formatSpeed(0.2, true)).toBe('720 km/h')
    expect(speedParts(formatSpeed(0.15, true))).toEqual(['540', 'km/h'])
    expect(formatSpeed(43, true)).toBe(formatSpeed(43))
    expect(formatSpeed(0.15)).toBe(formatSpeed(0.15, false))
    expect(formatSpeed(0.15)).toMatch(/km\/s$/)
    expect(formatDistance(0.03, true)).toBe('30 m')
    expect(formatDistance(0.0304, true)).toBe('30 m')
    expect(formatDistance(-0.001, true)).toBe('0 m')
    expect(formatDistance(0.03)).toBe('0 km')
    expect(formatDistance(12, true)).toBe(formatDistance(12))
    expect(formatDistance(NaN, true)).toBe('—')
  })
})
