import { describe, expect, it } from 'vitest'
import { positionsFor } from '../flight-scale'
import { sceneDistance } from '../planets'
import {
  AU_RINGS,
  RING_DASHES,
  RING_SEGMENTS,
  SPOKES,
  ringArrays,
  ringLabel,
  ringLabelPosition,
  spokePositions,
} from './ecliptic-grid'

const SCALES = ['system', 'flight'] as const

describe('ringArrays', () => {
  it("draws each ring at its true AU through the scale's spacing, in the ecliptic", () => {
    for (const scale of SCALES) {
      const { distance } = positionsFor(scale)
      const { positions } = ringArrays(distance)
      AU_RINGS.forEach((au, ring) => {
        for (let k = 0; k <= RING_SEGMENTS; k += 37) {
          const at = (ring * (RING_SEGMENTS + 1) + k) * 3
          expect(Math.hypot(positions[at], positions[at + 2])).toBeCloseTo(distance(au), 2)
          expect(positions[at + 1]).toBe(0)
        }
      })
    }
  })

  it('puts the 1 AU ring on Earth\'s system orbit and spaces flight linearly', () => {
    expect(sceneDistance(1)).toBe(50)
    expect(positionsFor('system').distance(1)).toBe(50)
    expect(positionsFor('flight').distance(30)).toBe(30 * positionsFor('flight').distance(1))
  })

  it('closes each ring and counts the same dashes round every ring', () => {
    const { positions, lineDistances } = ringArrays(sceneDistance)
    const points = RING_SEGMENTS + 1
    AU_RINGS.forEach((_, ring) => {
      const first = ring * points
      const last = first + RING_SEGMENTS
      expect(positions[last * 3]).toBeCloseTo(positions[first * 3], 3)
      expect(positions[last * 3 + 2]).toBeCloseTo(positions[first * 3 + 2], 3)
      expect(lineDistances[first]).toBe(0)
      expect(lineDistances[last]).toBe(RING_DASHES)
    })
  })

  it('joins only neighbouring points of the same ring', () => {
    const { indices } = ringArrays(sceneDistance)
    const points = RING_SEGMENTS + 1
    expect(indices.length).toBe(AU_RINGS.length * RING_SEGMENTS * 2)
    for (let i = 0; i < indices.length; i += 2) {
      expect(indices[i + 1] - indices[i]).toBe(1)
      expect(Math.floor(indices[i] / points)).toBe(Math.floor(indices[i + 1] / points))
    }
  })
})

describe('spokePositions', () => {
  it('runs every 30° of longitude from the innermost ring to the outermost', () => {
    for (const scale of SCALES) {
      const { distance } = positionsFor(scale)
      const spokes = spokePositions(distance)
      expect(spokes.length).toBe(SPOKES * 6)
      for (let k = 0; k < SPOKES; k++) {
        const [x0, y0, z0, x1, y1, z1] = spokes.subarray(k * 6, k * 6 + 6)
        expect(Math.hypot(x0, z0)).toBeCloseTo(distance(AU_RINGS[0]), 2)
        expect(Math.hypot(x1, z1)).toBeCloseTo(distance(AU_RINGS[AU_RINGS.length - 1]), 2)
        expect(y0).toBe(0)
        expect(y1).toBe(0)
        const angle = Math.atan2(-z1, x1)
        const expected = (2 * Math.PI * k) / SPOKES
        expect(Math.cos(angle - expected)).toBeCloseTo(1, 6)
      }
    }
  })
})

describe('ring labels', () => {
  it('state the true AU, not the scene distance', () => {
    expect(AU_RINGS.map(ringLabel)).toEqual(['1 AU', '2 AU', '5 AU', '10 AU', '20 AU', '30 AU'])
  })

  it('sit on their rings', () => {
    for (const scale of SCALES) {
      const { distance } = positionsFor(scale)
      for (const au of AU_RINGS) {
        const [x, y, z] = ringLabelPosition(distance, au)
        expect(Math.hypot(x, z)).toBeCloseTo(distance(au), 6)
        expect(y).toBe(0)
      }
    }
  })
})
