import { afterEach, describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import {
  NO_OFFSET,
  OPENING_MOVE,
  interruptOpening,
  opening,
  openingAllowed,
  openingOffset,
  resetOpening,
  shiftOpening,
  startOpening,
} from './opening'

describe('openingOffset', () => {
  const move = OPENING_MOVE

  it('starts at its offset and lands on none', () => {
    expect(openingOffset(move, 0)).toEqual(move.from)
    expect(openingOffset(move, -50)).toEqual(move.from)
    const end = openingOffset(move, move.duration)
    expect(end.azimuth).toBeCloseTo(0, 12)
    expect(end.elevation).toBeCloseTo(0, 12)
    expect(end.scale).toBeCloseTo(1, 12)
    expect(openingOffset(move, move.duration * 2)).toEqual(end)
  })

  it('closes in without overshooting', () => {
    let last = Infinity
    for (let ms = 0; ms <= move.duration; ms += move.duration / 40) {
      const o = openingOffset(move, ms)
      const left = Math.abs(Math.log(o.scale)) + Math.abs(o.azimuth) + Math.abs(o.elevation)
      expect(left).toBeLessThanOrEqual(last + 1e-12)
      last = left
    }
  })
})

describe('shiftOpening', () => {
  const target = new Vector3(3, -1, 2)

  it('puts the eye back where it was when shifted out and back', () => {
    const eye = new Vector3(40, 30, -20)
    const own = eye.clone()
    const from = { azimuth: -1.2, elevation: 0.3, scale: 1.5 }
    shiftOpening(eye, target, NO_OFFSET, from)
    expect(eye.distanceTo(own)).toBeGreaterThan(1)
    shiftOpening(eye, target, from, NO_OFFSET)
    expect(eye.distanceTo(own)).toBeLessThan(1e-9)
  })

  it('scales the distance to the target and raises the eye', () => {
    const eye = new Vector3(13, -1, 2)
    shiftOpening(eye, target, NO_OFFSET, { azimuth: 0, elevation: 0.3, scale: 2 })
    expect(eye.distanceTo(target)).toBeCloseTo(20, 9)
    expect(eye.y - target.y).toBeCloseTo(20 * Math.sin(0.3), 9)
  })

  it('keeps a turn made by something else between frames', () => {
    const eye = new Vector3(10, 5, 0).add(target)
    const step = { azimuth: 0.2, elevation: 0, scale: 1 }
    shiftOpening(eye, target, NO_OFFSET, step)
    // The clock ride turns the eye round the target by 0.1.
    eye.sub(target).applyAxisAngle(new Vector3(0, 1, 0), 0.1).add(target)
    shiftOpening(eye, target, step, NO_OFFSET)
    const expected = new Vector3(10, 5, 0)
      .applyAxisAngle(new Vector3(0, 1, 0), 0.1)
      .add(target)
    expect(eye.distanceTo(expected)).toBeLessThan(1e-9)
  })
})

describe('openingAllowed', () => {
  const view = { focus: 'clock', reducedMotion: false, restored: false, perspective: true }

  it('plays in the default clock view only', () => {
    expect(openingAllowed(view)).toBe(true)
    for (const focus of ['earth', 'location', 'sun', 'moon', 'jupiter']) {
      expect(openingAllowed({ ...view, focus })).toBe(false)
    }
  })

  it('not under reduced motion, over a restored pose, or through an orthographic camera', () => {
    expect(openingAllowed({ ...view, reducedMotion: true })).toBe(false)
    expect(openingAllowed({ ...view, restored: true })).toBe(false)
    expect(openingAllowed({ ...view, perspective: false })).toBe(false)
  })
})

describe('the opening state', () => {
  afterEach(resetOpening)

  it('starts once, at the first fade', () => {
    startOpening(100)
    startOpening(900)
    expect(opening.startedAt).toBe(100)
  })

  it('ignores a touch on the loading screen, before the move starts', () => {
    interruptOpening()
    expect(opening.done).toBe(false)
    startOpening(100)
    interruptOpening()
    expect(opening.done).toBe(true)
  })
})
