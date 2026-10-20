import { describe, expect, it } from 'vitest'
import {
  ORBIT_REFRESH_FRACTION,
  PLANETS,
  PLANET_KEYS,
  PLANET_ORBIT_SEGMENTS,
  orbitPathIsStale,
  planetOrbitPath,
  planetPosition,
} from './planets'

const MS_PER_DAY = 86_400_000

const DATES = ['1975-03-14T06:00:00Z', '2026-10-20T00:00:00Z', '2061-07-28T18:30:00Z'].map(
  (d) => Date.parse(d)
)

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
    const u = Math.min(
      1,
      Math.max(0, (px * dx + py * dy + pz * dz) / (dx * dx + dy * dy + dz * dz))
    )
    best = Math.min(best, Math.hypot(px - u * dx, py - u * dy, pz - u * dz))
  }
  return best
}

describe('orbitPathIsStale', () => {
  it('keeps a path until the clock moves the refresh share of a period', () => {
    const period = 100
    const limit = ORBIT_REFRESH_FRACTION * period * MS_PER_DAY
    expect(orbitPathIsStale(0, 0, period)).toBe(false)
    expect(orbitPathIsStale(0, limit, period)).toBe(false)
    expect(orbitPathIsStale(0, -limit, period)).toBe(false)
    expect(orbitPathIsStale(0, limit + 1, period)).toBe(true)
    expect(orbitPathIsStale(0, -limit - 1, period)).toBe(true)
  })
})

describe('planetOrbitPath', () => {
  it('fills a given buffer in place with the same points', () => {
    const t = DATES[1]
    const out = new Float32Array(PLANET_ORBIT_SEGMENTS * 3)
    const filled = planetOrbitPath(PLANETS.mars.body, t, PLANET_ORBIT_SEGMENTS, out)
    expect(filled).toBe(out)
    expect(Array.from(out)).toEqual(
      Array.from(planetOrbitPath(PLANETS.mars.body, t, PLANET_ORBIT_SEGMENTS))
    )
  })
})

describe('planet orbit lines', () => {
  // The bead's bar: planet centre within 0.5% of its orbit radius of the line,
  // for every sim time the line is kept (up to the refresh threshold).
  it.each(PLANET_KEYS)('keep %s on its line until the line is redrawn', (key) => {
    const { body, period } = PLANETS[key]
    const positionAt = planetPosition(body)
    const span = ORBIT_REFRESH_FRACTION * period * MS_PER_DAY
    for (const t0 of DATES) {
      const loop = planetOrbitPath(body, t0, PLANET_ORBIT_SEGMENTS)
      for (let k = -10; k <= 10; k++) {
        const p = positionAt(t0 + (k / 10) * span)
        expect(distanceToLoop(p, loop) / Math.hypot(...p)).toBeLessThan(0.005)
      }
    }
  })
})
