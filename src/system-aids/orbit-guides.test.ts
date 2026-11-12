import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { moonOffset } from '../ephemeris'
import {
  MOON_PARENTS,
  SYSTEM_EXPANSION_MAX,
  moonOffsetInto,
  moonOrbitRadius,
  moonsOf,
  setMoonExpansion,
} from '../moons/moons'
import { EXPANSION_SNAP } from '../moons/moon-expansion'
import {
  GUIDE_PARENTS,
  MOON_ORBIT_SEGMENTS,
  ORBIT_GUIDE_HIDE_PX,
  ORBIT_GUIDE_REFRESH_DAYS,
  ORBIT_GUIDE_SHOW_PX,
  earthMoonOrbitPath,
  guideExpansion,
  guideExtent,
  guideLoopCount,
  loopIndices,
  orbitGuideFade,
  orbitGuideIsStale,
  orbitGuideNeedsRebuild,
  writeGuidePaths,
  type GuideParent,
} from './orbit-guides'

const MS_PER_DAY = 86_400_000
const SEG = MOON_ORBIT_SEGMENTS

const DATES = ['1979-03-05T12:00:00Z', '2026-10-22T00:00:00Z', '2061-07-28T18:30:00Z'].map((d) =>
  Date.parse(d)
)

// Shortest distance from p to the closed polyline `loop` (segments points).
function distanceToLoop(p: readonly number[], loop: Float32Array): number {
  const n = loop.length / 3
  let best = Infinity
  for (let i = 0; i < n; i++) {
    const a = i * 3
    const b = ((i + 1) % n) * 3
    const dx = loop[b] - loop[a]
    const dy = loop[b + 1] - loop[a + 1]
    const dz = loop[b + 2] - loop[a + 2]
    const px = p[0] - loop[a]
    const py = p[1] - loop[a + 1]
    const pz = p[2] - loop[a + 2]
    const u = Math.min(1, Math.max(0, (px * dx + py * dy + pz * dz) / (dx * dx + dy * dy + dz * dz)))
    best = Math.min(best, Math.hypot(px - u * dx, py - u * dy, pz - u * dz))
  }
  return best
}

function guidePaths(parent: GuideParent, t: number): Float32Array {
  return writeGuidePaths(parent, t, SEG, 'system', new Float32Array(guideLoopCount(parent) * SEG * 3))
}

const offset = new THREE.Vector3()

// Each moon's offset at t, with the loop it should ride.
function moonsAgainstLoops(parent: GuideParent, pathT: number, t: number): number[] {
  const paths = guidePaths(parent, pathT)
  if (parent === 'earth') return [distanceToLoop(moonOffset(t), paths)]
  return moonsOf(parent).map((key, i) => {
    moonOffsetInto(key, t, offset, 'system')
    return distanceToLoop(offset.toArray(), paths.subarray(i * SEG * 3, (i + 1) * SEG * 3))
  })
}

describe('orbit guide paths', () => {
  it('covers Earth and every planet with moons, one loop per moon', () => {
    expect(GUIDE_PARENTS).toEqual(['earth', ...MOON_PARENTS])
    expect(guideLoopCount('earth')).toBe(1)
    for (const parent of MOON_PARENTS) {
      expect(guideLoopCount(parent)).toBe(moonsOf(parent).length)
    }
  })

  it('passes through every moon when built', () => {
    for (const t of DATES) {
      for (const parent of GUIDE_PARENTS) {
        for (const d of moonsAgainstLoops(parent, t, t)) expect(d).toBeLessThan(1e-4)
      }
    }
  })

  it("keeps every moon within 0.02 units of its line until it's rebuilt", () => {
    for (const t of DATES) {
      for (const parent of GUIDE_PARENTS) {
        const step = ORBIT_GUIDE_REFRESH_DAYS[parent] * MS_PER_DAY
        // Either side of the build time: a reversed or scrubbed clock too.
        for (const later of [t + step, t - step, t + step / 3]) {
          for (const d of moonsAgainstLoops(parent, t, later)) expect(d).toBeLessThan(0.02)
        }
      }
    }
  })

  it("puts the Moon at t in the middle of Earth's month", () => {
    const t = DATES[1]
    const path = earthMoonOrbitPath(t, SEG)
    const [x, y, z] = moonOffset(t)
    const mid = (SEG / 2) * 3
    expect(path[mid]).toBeCloseTo(x, 5)
    expect(path[mid + 1]).toBeCloseTo(y, 5)
    expect(path[mid + 2]).toBeCloseTo(z, 5)
  })

  it('writes into the buffer it is given', () => {
    const out = new Float32Array(guideLoopCount('saturn') * SEG * 3)
    expect(writeGuidePaths('saturn', DATES[0], SEG, 'system', out)).toBe(out)
    expect(out.every(Number.isFinite)).toBe(true)
    expect(out.some((v) => v !== 0)).toBe(true)
  })

  it('reaches no further than the extent the fade measures', () => {
    for (const t of DATES) {
      for (const parent of GUIDE_PARENTS) {
        const paths = guidePaths(parent, t)
        let reach = 0
        for (let i = 0; i < paths.length; i += 3) {
          reach = Math.max(reach, Math.hypot(paths[i], paths[i + 1], paths[i + 2]))
        }
        expect(reach).toBeLessThanOrEqual(guideExtent(parent, 'system'))
      }
    }
  })
})

describe('orbitGuideIsStale', () => {
  it('rebuilds only once the clock moves the refresh step, either way', () => {
    const t = DATES[1]
    for (const parent of GUIDE_PARENTS) {
      const step = ORBIT_GUIDE_REFRESH_DAYS[parent] * MS_PER_DAY
      expect(orbitGuideIsStale(parent, t, t)).toBe(false)
      expect(orbitGuideIsStale(parent, t, t + 0.9 * step)).toBe(false)
      expect(orbitGuideIsStale(parent, t, t + 1.1 * step)).toBe(true)
      expect(orbitGuideIsStale(parent, t, t - 1.1 * step)).toBe(true)
    }
  })

  it('never rebuilds every frame at the fastest clock (a month per second, 60 fps)', () => {
    const perFrame = (30 * MS_PER_DAY) / 60
    for (const parent of GUIDE_PARENTS) {
      expect(ORBIT_GUIDE_REFRESH_DAYS[parent] * MS_PER_DAY).toBeGreaterThan(4 * perFrame)
    }
  })
})

describe('loopIndices', () => {
  it('closes each loop on itself', () => {
    const indices = loopIndices(2, 4)
    expect(Array.from(indices)).toEqual([0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4])
  })

  it('fits the largest set in 16-bit indices', () => {
    const most = Math.max(...GUIDE_PARENTS.map(guideLoopCount))
    expect(most * SEG).toBeLessThan(65_536)
  })
})

describe('orbitGuideFade', () => {
  it('hides a set too small to read and shows a large one in full', () => {
    expect(orbitGuideFade(0)).toBe(0)
    expect(orbitGuideFade(ORBIT_GUIDE_HIDE_PX)).toBe(0)
    expect(orbitGuideFade(ORBIT_GUIDE_SHOW_PX)).toBe(1)
    expect(orbitGuideFade(1000)).toBe(1)
  })

  it('rises steadily in between', () => {
    let last = 0
    for (let px = ORBIT_GUIDE_HIDE_PX; px <= ORBIT_GUIDE_SHOW_PX; px += 2) {
      const f = orbitGuideFade(px)
      expect(f).toBeGreaterThanOrEqual(last)
      last = f
    }
  })
})

describe('orbitGuideNeedsRebuild (tides-ufyr.6.3)', () => {
  afterEach(() => {
    for (const parent of MOON_PARENTS) setMoonExpansion(parent, 0)
  })
  const t = DATES[1]

  it('rebuilds a system-view set once its expansion differs from the one it was built at', () => {
    const built = guideExpansion('jupiter', 'system')
    expect(built).toBe(0)
    expect(orbitGuideNeedsRebuild('jupiter', 'system', t, built, t)).toBe(false)
    setMoonExpansion('jupiter', 0.3)
    expect(orbitGuideNeedsRebuild('jupiter', 'system', t, built, t)).toBe(true)
    expect(orbitGuideNeedsRebuild('jupiter', 'system', t, guideExpansion('jupiter', 'system'), t)).toBe(false)
    // Still on the clock's refresh too.
    const stale = t + 2 * ORBIT_GUIDE_REFRESH_DAYS.jupiter * MS_PER_DAY
    expect(orbitGuideNeedsRebuild('jupiter', 'system', t, guideExpansion('jupiter', 'system'), stale)).toBe(true)
  })

  it('lets a sub-threshold drift (a cap following the clock) ride, but not a real change or a landing', () => {
    setMoonExpansion('jupiter', 0.4)
    const built = guideExpansion('jupiter', 'system')
    setMoonExpansion('jupiter', 0.4 - 0.5 * EXPANSION_SNAP)
    expect(orbitGuideNeedsRebuild('jupiter', 'system', t, built, t)).toBe(false)
    setMoonExpansion('jupiter', 0.4 + 0.9 * EXPANSION_SNAP)
    expect(orbitGuideNeedsRebuild('jupiter', 'system', t, built, t)).toBe(false)
    setMoonExpansion('jupiter', 0.4 - 2 * EXPANSION_SNAP)
    expect(orbitGuideNeedsRebuild('jupiter', 'system', t, built, t)).toBe(true)
    // Landing on either end rebuilds however small the last step.
    setMoonExpansion('jupiter', 0)
    expect(orbitGuideNeedsRebuild('jupiter', 'system', t, 0.5 * EXPANSION_SNAP, t)).toBe(true)
    expect(orbitGuideNeedsRebuild('jupiter', 'system', t, 0, t)).toBe(false)
    setMoonExpansion('jupiter', SYSTEM_EXPANSION_MAX)
    expect(orbitGuideNeedsRebuild('jupiter', 'system', t, SYSTEM_EXPANSION_MAX - 0.5 * EXPANSION_SNAP, t)).toBe(true)
  })

  it('ignores the expansion in flight, and for Earth', () => {
    setMoonExpansion('jupiter', 0.3)
    expect(guideExpansion('jupiter', 'flight')).toBe(0)
    expect(orbitGuideNeedsRebuild('jupiter', 'flight', t, 0, t)).toBe(false)
    expect(orbitGuideNeedsRebuild('earth', 'system', t, 0, t)).toBe(false)
  })

  it('builds the loops at the expanded radii', () => {
    setMoonExpansion('jupiter', 0.6)
    const positions = new Float32Array(guideLoopCount('jupiter') * SEG * 3)
    writeGuidePaths('jupiter', t, SEG, 'system', positions)
    moonsOf('jupiter').forEach((key, i) => {
      const at = i * SEG * 3
      expect(Math.hypot(positions[at], positions[at + 1], positions[at + 2]), key).toBeCloseTo(
        moonOrbitRadius(key, 'system'),
        4
      )
    })
  })
})
