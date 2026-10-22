import { describe, expect, it } from 'vitest'
import { EARTH_ORBIT_RADIUS, type Vec3 } from '../ephemeris'
import { positionsFor } from '../flight-scale'
import { sceneDistance } from '../planets'
import {
  AU_RINGS,
  LABEL_ANGLE,
  LABEL_CLEARANCE,
  LABEL_NUDGE,
  RING_DASHES,
  RING_SEGMENTS,
  RING_TEXT_OFFSET,
  clearRingLabels,
  drawnRings,
  publishRingLabelBounds,
  publishRingLabels,
  ringLabelLayout,
  ringLabelPositions,
  ringArrays,
  ringLabel,
  ringLabelAngles,
  ringLabelPosition,
} from './ecliptic-grid'

const SCALES = ['system', 'flight'] as const

// The scene point r out at scene angle φ.
function at(r: number, angle: number): Vec3 {
  return [r * Math.cos(angle), 0, -r * Math.sin(angle)]
}

describe('drawnRings', () => {
  it("leaves the system view's 1 AU ring to Earth's month ring", () => {
    expect(sceneDistance(1)).toBe(50)
    expect(positionsFor('system').distance(1)).toBe(EARTH_ORBIT_RADIUS)
    expect(drawnRings(positionsFor('system').distance)).toEqual([2, 5, 10, 20, 30])
  })

  it('draws every ring at the flight spacing, which is linear', () => {
    const { distance } = positionsFor('flight')
    expect(drawnRings(distance)).toEqual(AU_RINGS)
    expect(distance(30)).toBe(30 * distance(1))
  })
})

describe('ringArrays', () => {
  it("draws each ring at its true AU through the scale's spacing, in the ecliptic", () => {
    for (const scale of SCALES) {
      const { distance } = positionsFor(scale)
      const rings = drawnRings(distance)
      const { positions } = ringArrays(distance, rings)
      expect(positions.length).toBe(rings.length * (RING_SEGMENTS + 1) * 3)
      rings.forEach((au, ring) => {
        for (let k = 0; k <= RING_SEGMENTS; k += 37) {
          const i = (ring * (RING_SEGMENTS + 1) + k) * 3
          expect(Math.hypot(positions[i], positions[i + 2])).toBeCloseTo(distance(au), 2)
          expect(positions[i + 1]).toBe(0)
        }
      })
    }
  })

  it('closes each ring and counts the same dashes round every ring', () => {
    const { positions, lineDistances } = ringArrays(sceneDistance, AU_RINGS)
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
    const { indices } = ringArrays(sceneDistance, AU_RINGS)
    const points = RING_SEGMENTS + 1
    expect(indices.length).toBe(AU_RINGS.length * RING_SEGMENTS * 2)
    for (let i = 0; i < indices.length; i += 2) {
      expect(indices[i + 1] - indices[i]).toBe(1)
      expect(Math.floor(indices[i] / points)).toBe(Math.floor(indices[i + 1] / points))
    }
  })
})

describe('ring labels', () => {
  it('state the true AU, not the scene distance', () => {
    expect(AU_RINGS.map(ringLabel)).toEqual(['1 AU', '2 AU', '5 AU', '10 AU', '20 AU', '30 AU'])
  })

  it('sit on their rings, the 1 AU one too', () => {
    for (const scale of SCALES) {
      const { distance } = positionsFor(scale)
      for (const au of AU_RINGS) {
        const [x, y, z] = ringLabelPosition(distance, au)
        expect(Math.hypot(x, z)).toBeCloseTo(distance(au), 6)
        expect(Math.atan2(-z, x)).toBeCloseTo(LABEL_ANGLE, 6)
        expect(y).toBe(0)
      }
    }
  })
})

describe('ringLabelAngles', () => {
  const d = sceneDistance
  const jupiterRing = AU_RINGS.indexOf(5)

  it('keeps every label at LABEL_ANGLE when nothing sits on it', () => {
    expect(ringLabelAngles(d, [])).toEqual(AU_RINGS.map(() => LABEL_ANGLE))
    // On the label's line but on another ring, or on the ring but well round it.
    const clear = [at(d(5.2), LABEL_ANGLE + Math.PI / 2), at(d(30), LABEL_ANGLE + 0.5 * LABEL_CLEARANCE)]
    expect(ringLabelAngles(d, clear)[jupiterRing]).toBe(LABEL_ANGLE)
  })

  it('moves a label aside, away from a planet on it', () => {
    const ahead = ringLabelAngles(d, [at(d(5.2), LABEL_ANGLE + 0.5 * LABEL_CLEARANCE)])
    expect(ahead[jupiterRing]).toBeCloseTo(LABEL_ANGLE - LABEL_NUDGE)
    const behind = ringLabelAngles(d, [at(d(5.2), LABEL_ANGLE - 0.5 * LABEL_CLEARANCE)])
    expect(behind[jupiterRing]).toBeCloseTo(LABEL_ANGLE + LABEL_NUDGE)
    // The other labels stay put.
    ahead.forEach((angle, i) => {
      if (i !== jupiterRing) expect(angle).toBe(LABEL_ANGLE)
    })
  })

  it('reads angles across the ±π seam', () => {
    const angle = Math.PI - 0.01
    const nudged = ringLabelAngles(d, [at(d(5), angle)])
    expect(nudged).toEqual(AU_RINGS.map(() => LABEL_ANGLE))
  })
})

describe('ringLabelLayout', () => {
  it('publishes the anchors ringLabelPositions gives and the text boxes from them', () => {
    const anchors = ringLabelPositions(sceneDistance, [])
    expect(anchors[0]).toEqual(ringLabelPosition(sceneDistance, 1))
    publishRingLabels(anchors, 13)
    expect(ringLabelLayout.count).toBe(AU_RINGS.length)
    expect([...ringLabelLayout.anchors.subarray(3, 6)]).toEqual(anchors[1])
    publishRingLabelBounds(2, [0, 0, 2.5, 1.2])
    const [dx, dy] = RING_TEXT_OFFSET
    expect([...ringLabelLayout.bounds.subarray(8, 12)]).toEqual([dx, dy, 2.5 + dx, 1.2 + dy])
    clearRingLabels()
    expect(ringLabelLayout.count).toBe(0)
  })
})
