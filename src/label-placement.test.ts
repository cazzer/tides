import { describe, expect, it } from 'vitest'
import {
  chooseLabelSide,
  labelRect,
  stripClearance,
  type Strip,
} from './label-placement'

describe('labelRect', () => {
  it('puts each side clear of the body disc', () => {
    expect(labelRect('right', 0, 0, 5, 40, 10)).toEqual({ x0: 5, y0: -5, x1: 45, y1: 5 })
    expect(labelRect('left', 0, 0, 5, 40, 10)).toEqual({ x0: -45, y0: -5, x1: -5, y1: 5 })
    expect(labelRect('above', 0, 0, 5, 40, 10)).toEqual({ x0: -20, y0: 5, x1: 20, y1: 15 })
    expect(labelRect('below', 0, 0, 5, 40, 10)).toEqual({ x0: -20, y0: -15, x1: 20, y1: -5 })
  })

  it('tucks diagonal sides against the disc', () => {
    const d = 10 * Math.SQRT1_2
    const r = labelRect('below-left', 0, 0, 10, 40, 10)
    expect(r.x1).toBeCloseTo(-d, 12)
    expect(r.y1).toBeCloseTo(-d, 12)
    expect(Math.hypot(r.x1, r.y1)).toBeCloseTo(10, 12)
  })
})

describe('stripClearance', () => {
  const rect = { x0: 0, y0: 0, x1: 10, y1: 10 }

  it('hits a strip that passes through without an end inside', () => {
    expect(stripClearance(rect, { ax: -5, ay: 5, bx: 15, by: 5, r: 0 })).toBeLessThanOrEqual(0)
  })

  it('hits a strip whose thickness reaches the rect', () => {
    expect(stripClearance(rect, { ax: -5, ay: 12, bx: 15, by: 12, r: 2 })).toBeLessThanOrEqual(0)
    expect(stripClearance(rect, { ax: 12, ay: 12, bx: 20, by: 20, r: 2 })).toBeGreaterThan(0)
    expect(stripClearance(rect, { ax: 11, ay: 11, bx: 20, by: 20, r: 2 })).toBeLessThanOrEqual(0)
  })

  it('misses a strip that stays away', () => {
    expect(stripClearance(rect, { ax: -5, ay: 20, bx: 15, by: 20, r: 2 })).toBeGreaterThan(0)
    expect(stripClearance(rect, { ax: 20, ay: -5, bx: 30, by: 30, r: 2 })).toBeGreaterThan(0)
  })
})

describe('chooseLabelSide', () => {
  // A vertical strip just right of the body.
  const rightWall: Strip = { ax: 30, ay: -50, bx: 30, by: 50, r: 3 }

  it('prefers the right side when it is clear', () => {
    expect(chooseLabelSide(0, 0, 5, 40, 10, [])).toBe('right')
  })

  it('moves off a blocked side to the first clear one', () => {
    expect(chooseLabelSide(0, 0, 5, 40, 10, [rightWall])).toBe('above')
  })

  it('takes the least-blocked side when none is clear', () => {
    // A thin wall through the right side, a thick one through the others.
    const walls: Strip[] = [
      { ax: 30, ay: -100, bx: 30, by: 100, r: 1 },
      { ax: -100, ay: 0, bx: 0, by: 0, r: 30 },
      { ax: -100, ay: 20, bx: 100, by: 20, r: 30 },
      { ax: -100, ay: -20, bx: 100, by: -20, r: 30 },
    ]
    expect(chooseLabelSide(0, 0, 5, 40, 10, walls)).toBe('right')
  })
})
