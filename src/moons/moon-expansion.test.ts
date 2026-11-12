import { afterEach, describe, expect, it } from 'vitest'
import { PLANETS, PLANET_KEYS } from '../planets'
import { positionsFor } from '../flight-scale'
import { framingDistance } from '../main-view'
import { useStore } from '../store'
import {
  EXPANSION_FAR_RATIO,
  expansionCap,
  expansionTarget,
  resetMoonExpansions,
  stepExpansion,
  stepMoonExpansions,
} from './moon-expansion'
import {
  MOON_PARENTS,
  SYSTEM_EXPANSION_MAX,
  moonExpansion,
  moonPosition,
  moonRadius,
  moonSystemExtent,
  moonsOf,
  setMoonExpansion,
  type MoonParent,
} from './moons'

const DAY = 86_400_000
const SYSTEM = positionsFor('system')
const EARTH = SYSTEM.radius.earth
const zf = (parent: MoonParent) => framingDistance(SYSTEM.radius[parent], EARTH)

afterEach(resetMoonExpansions)

describe('expansionTarget', () => {
  it('is 0 for a focus outside the system', () => {
    for (const focus of ['earth', 'sun', 'clock', 'moon', 'saturn', 'titan', 'location'] as const) {
      expect(expansionTarget(focus, zf('jupiter'), 'jupiter'), focus).toBe(0)
    }
  })

  it('is 1 at the planet’s framing distance and in from it, 0 from EXPANSION_FAR_RATIO of it out', () => {
    for (const parent of MOON_PARENTS) {
      expect(expansionTarget(parent, zf(parent), parent)).toBe(1)
      expect(expansionTarget(parent, zf(parent) / 2, parent)).toBe(1)
      expect(expansionTarget(parent, zf(parent) * EXPANSION_FAR_RATIO, parent)).toBe(0)
      expect(expansionTarget(parent, zf(parent) * 10, parent)).toBe(0)
      expect(expansionTarget(parent, Infinity, parent)).toBe(0)
    }
  })

  it('only grows as the eye comes in', () => {
    let previous = -Infinity
    for (let z = zf('jupiter') * 6; z > zf('jupiter') / 2; z *= 0.97) {
      const target = expansionTarget('jupiter', z, 'jupiter')
      expect(target).toBeGreaterThanOrEqual(previous)
      previous = target
    }
    expect(expansionTarget('jupiter', zf('jupiter') * 2, 'jupiter')).toBeGreaterThan(0)
    expect(expansionTarget('jupiter', zf('jupiter') * 2, 'jupiter')).toBeLessThan(1)
  })

  it('is 1 at any zoom with one of the parent’s moons focused', () => {
    for (const z of [1, zf('jupiter'), 1e4, Infinity]) {
      expect(expansionTarget('callisto', z, 'jupiter')).toBe(1)
      expect(expansionTarget('callisto', z, 'saturn')).toBe(0)
    }
    expect(expansionTarget('triton', 1e4, 'neptune')).toBe(1)
  })
})

describe('stepExpansion', () => {
  it('eases toward the target without overshooting, and lands on it', () => {
    for (const [from, to] of [
      [0, SYSTEM_EXPANSION_MAX],
      [SYSTEM_EXPANSION_MAX, 0],
    ]) {
      let e = from
      let frames = 0
      while (e !== to && frames < 600) {
        const next = stepExpansion(e, to, 1 / 60, false)
        expect(Math.abs(to - next)).toBeLessThan(Math.abs(to - e))
        expect(Math.sign(to - next) === Math.sign(to - from) || next === to).toBe(true)
        e = next
        frames++
      }
      expect(e).toBe(to)
      // Most of the way in about a time constant, all of it in a few seconds.
      expect(frames).toBeLessThan(5 * 60)
    }
    expect(stepExpansion(0, 0.6, 0.35, false)).toBeCloseTo(0.6 * (1 - Math.exp(-1)), 9)
  })

  it('snaps under reduced motion', () => {
    expect(stepExpansion(0, 0.6, 1 / 60, true)).toBe(0.6)
    expect(stepExpansion(0.6, 0, 1 / 60, true)).toBe(0)
  })
})

describe('expansion cap, 1900–2100', () => {
  const times: number[] = []
  for (let t = Date.UTC(1900, 0, 1); t <= Date.UTC(2100, 0, 1); t += 23 * DAY) times.push(t)

  // Every other body's centre at t and the sphere around it to keep clear
  // of: the Sun, Earth, its Moon, the planets (Saturn's and Uranus' ring
  // edges) and the other systems at their (compact) extent.
  function obstacles(parent: MoonParent, t: number): [string, number[], number][] {
    const list: [string, number[], number][] = [
      ['sun', [0, 0, 0], SYSTEM.radius.sun],
      ['earth', [...SYSTEM.positionAt.earth(t)], EARTH],
      ['moon', [...SYSTEM.positionAt.moon(t)], SYSTEM.radius.moon],
    ]
    for (const key of PLANET_KEYS) {
      if (key === parent) continue
      const { radius, rings } = PLANETS[key]
      list.push([key, [...SYSTEM.positionAt[key](t)], radius * (rings?.outer ?? 1)])
    }
    for (const other of MOON_PARENTS) {
      if (other !== parent) list.push([`${other} system`, [...SYSTEM.positionAt[other](t)], moonSystemExtent(other, 'system')])
    }
    return list
  }

  it('keeps every moon of an expanded system 2+ units clear of every other body and system', () => {
    for (const parent of MOON_PARENTS) {
      let least = Infinity
      for (const t of times) {
        const e = Math.min(SYSTEM_EXPANSION_MAX, expansionCap(parent, t))
        expect(e).toBeGreaterThanOrEqual(0)
        setMoonExpansion(parent, e)
        const around = obstacles(parent, t)
        for (const key of moonsOf(parent)) {
          const p = moonPosition(key, t, 'system')
          for (const [, centre, reach] of around) {
            least = Math.min(least, Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]) - reach - moonRadius(key, 'system'))
          }
        }
      }
      setMoonExpansion(parent, 0)
      expect(least, parent).toBeGreaterThanOrEqual(2)
    }
  })

  it('lets Jupiter’s system expand all the way at least 90% of the time', () => {
    const full = times.filter((t) => expansionCap('jupiter', t) >= SYSTEM_EXPANSION_MAX).length
    expect(full / times.length).toBeGreaterThanOrEqual(0.9)
  })

  it('gives way to a neighbouring system as it expands', () => {
    // 2000 May: Jupiter and Saturn at conjunction.
    const t = Date.UTC(2000, 4, 28)
    const alone = expansionCap('jupiter', t)
    expect(alone).toBeLessThan(SYSTEM_EXPANSION_MAX)
    setMoonExpansion('saturn', expansionCap('saturn', t))
    expect(expansionCap('jupiter', t)).toBeLessThan(alone)
  })
})

describe('stepMoonExpansions', () => {
  // A date with room for Jupiter's system to expand all the way.
  const T = Date.UTC(2026, 9, 22)
  const run = (focus: Parameters<typeof stepMoonExpansions>[0], distance: number, seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) stepMoonExpansions(focus, distance, T, 1 / 60, false)
  }

  it('grows only the focused system, and eases it back once the camera leaves', () => {
    expect(expansionCap('jupiter', T)).toBe(SYSTEM_EXPANSION_MAX)
    run('jupiter', zf('jupiter'), 0.2)
    const partway = moonExpansion('jupiter')
    expect(partway).toBeGreaterThan(0)
    expect(partway).toBeLessThan(SYSTEM_EXPANSION_MAX)
    run('jupiter', zf('jupiter'), 5)
    expect(moonExpansion('jupiter')).toBe(SYSTEM_EXPANSION_MAX)
    for (const parent of MOON_PARENTS) if (parent !== 'jupiter') expect(moonExpansion(parent), parent).toBe(0)
    run('earth', zf('jupiter'), 0.2)
    expect(moonExpansion('jupiter')).toBeGreaterThan(0)
    expect(moonExpansion('jupiter')).toBeLessThan(SYSTEM_EXPANSION_MAX)
    run('earth', zf('jupiter'), 5)
    expect(moonExpansion('jupiter')).toBe(0)
  })

  it('holds a moon’s system expanded however far out the eye is', () => {
    run('titan', 1e4, 5)
    expect(moonExpansion('saturn')).toBe(Math.min(SYSTEM_EXPANSION_MAX, expansionCap('saturn', T)))
    expect(moonExpansion('saturn')).toBeGreaterThan(0)
  })

  it('does nothing once settled, and never touches the store (no re-render)', () => {
    let notified = 0
    const unsubscribe = useStore.subscribe(() => notified++)
    run('jupiter', zf('jupiter'), 5)
    const extent = moonSystemExtent('jupiter', 'system')
    // Settled: every parent's set is the no-op path.
    for (const parent of MOON_PARENTS) expect(setMoonExpansion(parent, moonExpansion(parent)), parent).toBe(false)
    stepMoonExpansions('jupiter', zf('jupiter'), T, 1 / 60, false)
    expect(moonSystemExtent('jupiter', 'system')).toBe(extent)
    unsubscribe()
    expect(notified).toBe(0)
  })
})
