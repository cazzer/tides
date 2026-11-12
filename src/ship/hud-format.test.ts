import { describe, expect, test } from 'vitest'
import { V_TOP } from './flight'
import { formatDistance, formatSpeed } from './ship-distances'
import {
  SYSTEM_CUE_MS,
  approachAnnouncement,
  approachTail,
  createSystemCue,
  speedParts,
  stepSystemCue,
  systemCueShowing,
  systemEdgeCue,
  wellSuffix,
} from './hud-format'

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

describe('the moon-system cue (tides-ufyr.6.2.1)', () => {
  test('names the system and the way across', () => {
    expect(systemEdgeCue('saturn', true)).toBe('Entering Saturn’s moons · scale change')
    expect(systemEdgeCue('mars', false)).toBe('Leaving Mars’s moons · scale change')
  })

  test('fires on a new crossing only, and shows for SYSTEM_CUE_MS', () => {
    const cue = createSystemCue(3)
    expect(stepSystemCue(cue, { parent: 'jupiter', entering: true, count: 3 }, 0)).toBe(false)
    expect(systemCueShowing(cue, 0)).toBe(false)
    expect(stepSystemCue(cue, { parent: 'jupiter', entering: false, count: 4 }, 1000)).toBe(true)
    expect(cue.text).toBe('Leaving Jupiter’s moons · scale change')
    expect(systemCueShowing(cue, 1000 + SYSTEM_CUE_MS - 1)).toBe(true)
    expect(systemCueShowing(cue, 1000 + SYSTEM_CUE_MS)).toBe(false)
    expect(stepSystemCue(cue, { parent: 'jupiter', entering: false, count: 4 }, 1100)).toBe(false)
  })
})
