import { describe, expect, it } from 'vitest'
import {
  LABEL_SIDES,
  SIDE_HYSTERESIS_PX,
  chooseLabelSide,
  emptyRect,
  emptyStrip,
  labelRect,
  rectAsStrip,
  rectRoom,
  stripClearance,
  type Strip,
} from './label-placement'

const rect = (x0: number, y0: number, x1: number, y1: number) => ({
  x0,
  y0,
  x1,
  y1,
})

describe('labelRect', () => {
  it('puts each side clear of the body disc', () => {
    const out = emptyRect()
    expect(labelRect('right', 0, 0, 5, 40, 10, out)).toEqual(rect(5, -5, 45, 5))
    expect(labelRect('left', 0, 0, 5, 40, 10, out)).toEqual(rect(-45, -5, -5, 5))
    expect(labelRect('above', 0, 0, 5, 40, 10, out)).toEqual(rect(-20, 5, 20, 15))
    expect(labelRect('below', 0, 0, 5, 40, 10, out)).toEqual(rect(-20, -15, 20, -5))
  })

  it('tucks diagonal sides against the disc', () => {
    const d = 10 * Math.SQRT1_2
    const r = labelRect('below-left', 0, 0, 10, 40, 10, emptyRect())
    expect(r.x1).toBeCloseTo(-d, 12)
    expect(r.y1).toBeCloseTo(-d, 12)
    expect(Math.hypot(r.x1, r.y1)).toBeCloseTo(10, 12)
  })

  it('writes into the rect it is given', () => {
    const out = emptyRect()
    for (const side of LABEL_SIDES) {
      expect(labelRect(side, 3, 4, 5, 40, 10, out)).toBe(out)
    }
  })
})

describe('rectAsStrip', () => {
  it('covers a wide rect with its centreline and margin', () => {
    const out = emptyStrip()
    expect(rectAsStrip(rect(0, 0, 40, 10), 2, out)).toBe(out)
    expect(out).toEqual({ ax: 5, ay: 5, bx: 35, by: 5, r: 7 })
  })

  it('covers a tall rect along its height', () => {
    expect(rectAsStrip(rect(0, 0, 10, 40), 0, emptyStrip())).toEqual({
      ax: 5,
      ay: 5,
      bx: 5,
      by: 35,
      r: 5,
    })
  })

  it('keeps another label off every point of the rect', () => {
    const placed = rect(0, 0, 40, 10)
    const strip = rectAsStrip(placed, 0, emptyStrip())
    // Boxes touching the placed one's edges and corners all overlap it.
    for (const probe of [
      rect(-5, 4, -0.1, 6),
      rect(40.1, 4, 45, 6),
      rect(20, 10.1, 22, 12),
      rect(-3, -3, -0.1, -0.1),
    ]) {
      expect(stripClearance(probe, strip)).toBeLessThan(5)
    }
  })
})

describe('stripClearance', () => {
  const box = rect(0, 0, 10, 10)

  it('is negative for a strip that passes through without an end inside', () => {
    expect(stripClearance(box, { ax: -5, ay: 5, bx: 15, by: 5, r: 0 })).toBeLessThanOrEqual(0)
    expect(stripClearance(box, { ax: 5, ay: -5, bx: 5, by: 15, r: 0 })).toBeLessThanOrEqual(0)
    expect(stripClearance(box, { ax: -5, ay: -5, bx: 15, by: 15, r: 0 })).toBeLessThanOrEqual(0)
  })

  it('is negative for a strip whose thickness reaches the rect', () => {
    expect(stripClearance(box, { ax: -5, ay: 12, bx: 15, by: 12, r: 2 })).toBeLessThanOrEqual(0)
    expect(stripClearance(box, { ax: 11, ay: 11, bx: 20, by: 20, r: 2 })).toBeLessThanOrEqual(0)
  })

  it('is the gap less the thickness for a strip that stays away', () => {
    expect(stripClearance(box, { ax: -5, ay: 20, bx: 15, by: 20, r: 2 })).toBeCloseTo(8, 12)
    expect(stripClearance(box, { ax: 12, ay: 12, bx: 20, by: 20, r: 2 })).toBeCloseTo(
      Math.SQRT2 * 2 - 2,
      12
    )
    // Diagonal past a corner: neither end nor the segment's sweep is inside.
    expect(stripClearance(box, { ax: 20, ay: -5, bx: 30, by: 30, r: 0 })).toBeGreaterThan(0)
  })
})

describe('rectRoom', () => {
  it('reads only the first count strips', () => {
    const strips: Strip[] = [
      { ax: 0, ay: 30, bx: 10, by: 30, r: 0 },
      { ax: 5, ay: 5, bx: 5, by: 5, r: 1 },
    ]
    expect(rectRoom(rect(0, 0, 10, 10), strips, 1)).toBeCloseTo(20, 12)
    expect(rectRoom(rect(0, 0, 10, 10), strips, 2)).toBeLessThan(0)
    expect(rectRoom(rect(0, 0, 10, 10), strips, 0)).toBe(Infinity)
  })
})

describe('chooseLabelSide', () => {
  // A 40 × 10 label 5 px off a body at the origin. Its right box spans
  // x 5–45, so a wall at x = 45 + w blocks it by `block` px.
  const wallRightOfLabel = (block: number): Strip => ({
    ax: 45 + 3 - block,
    ay: -50,
    bx: 45 + 3 - block,
    by: 50,
    r: 3,
  })

  it('prefers the right side when it is clear', () => {
    expect(chooseLabelSide('right', 0, 0, 5, 40, 10, [], 0)).toBe('right')
  })

  it('moves off a blocked side to the first clear one', () => {
    const wall: Strip = { ax: 30, ay: -50, bx: 30, by: 50, r: 3 }
    expect(chooseLabelSide('right', 0, 0, 5, 40, 10, [wall], 1)).toBe('above')
  })

  it('ignores strips past count', () => {
    const wall: Strip = { ax: 30, ay: -50, bx: 30, by: 50, r: 3 }
    expect(chooseLabelSide('right', 0, 0, 5, 40, 10, [wall], 0)).toBe('right')
  })

  it('stays on a side blocked by no more than the hysteresis', () => {
    const slight = wallRightOfLabel(SIDE_HYSTERESIS_PX - 0.5)
    expect(chooseLabelSide('right', 0, 0, 5, 40, 10, [slight], 1)).toBe('right')
    const more = wallRightOfLabel(SIDE_HYSTERESIS_PX + 0.5)
    expect(chooseLabelSide('right', 0, 0, 5, 40, 10, [more], 1)).not.toBe('right')
  })

  it('returns to a preferred side only once the current one is blocked', () => {
    // Left is clear and right is clear: a label already left stays left.
    expect(chooseLabelSide('left', 0, 0, 5, 40, 10, [], 0)).toBe('left')
  })

  describe('with every side blocked', () => {
    // A disc reaching past the body from the left: right is least blocked
    // (by 5 px), above-right next (by ~6.4), the rest far more.
    const disc: Strip[] = [{ ax: -100, ay: 0, bx: -100, by: 0, r: 110 }]

    it('takes the least-blocked side when it is clearly better', () => {
      expect(chooseLabelSide('below', 0, 0, 5, 40, 10, disc, 1)).toBe('right')
    })

    it('stays put unless another side beats it by the hysteresis', () => {
      expect(chooseLabelSide('above-right', 0, 0, 5, 40, 10, disc, 1)).toBe(
        'above-right'
      )
    })
  })
})
