import { describe, expect, it } from 'vitest'
import { PLANETS, sceneRadius } from '../planets'
import {
  MAIN_ZOOM,
  REFERENCE_VIEW_HEIGHT,
  mainViewRange,
  planetFramingZoom,
  targetUnitsPerPixel,
  zoomDistance,
} from '../main-view'
import { MOON_KEYS, moonRadius, moonsOf } from '../moons/moons'
import type { CameraFocus } from '../store'
import {
  LABEL_KEYS,
  createLabelLayout,
  eclipsed,
  resolveLabels,
  type LabelFrame,
  type LabelLayout,
  boxHitsDisc,
  boxesOverlap,
  bodyReach,
  labelClearance,
  labelDirection,
  labelDistancePx,
  labelOpacity,
  steerClearOfSun,
} from './label-visibility'

const EARTH_RADIUS = sceneRadius(12_742_000)
// Scene units per CSS px at the target with the eye where it frames what the
// ortho view did at `zoom` (1 / zoom, in a REFERENCE_VIEW_HEIGHT view).
const at = (zoom: number) => targetUnitsPerPixel(zoomDistance(zoom), REFERENCE_VIEW_HEIGHT)
const framed = (radius: number) => at(planetFramingZoom(radius, EARTH_RADIUS))
const JUPITER_FRAMED = framed(PLANETS.jupiter.radius)
const SATURN_FRAMED = framed(PLANETS.saturn.radius)

describe('labelOpacity', () => {
  it('names the Sun, Earth and the outer planets zoomed all the way out', () => {
    const upp = at(1)
    for (const key of ['sun', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'] as const) {
      expect(labelOpacity(key, upp, 'clock', upp), key).toBeGreaterThan(0.9)
    }
  })

  it('names the giants at a phone’s lower zoom floor, where Mars gives way', () => {
    // Earth and Mars orbit ~11 px apart there, too close for two names.
    const phone = { width: 390, height: 844 }
    const upp = targetUnitsPerPixel(mainViewRange(true, phone).maxDistance, phone.height)
    for (const key of ['sun', 'earth', 'jupiter', 'saturn'] as const) {
      expect(labelOpacity(key, upp, 'clock', upp), key).toBeGreaterThan(0.9)
    }
    for (const key of ['uranus', 'neptune'] as const) {
      expect(labelOpacity(key, upp, 'clock', upp), key).toBeGreaterThan(0.4)
    }
    expect(labelOpacity('mars', upp, 'clock', upp)).toBe(0)
  })

  it('fades Mercury and Venus in as the inner system opens up', () => {
    expect(labelOpacity('mercury', at(1), 'clock', at(1))).toBe(0)
    expect(labelOpacity('venus', at(1), 'clock', at(1))).toBeLessThan(0.05)
    expect(labelOpacity('venus', at(2), 'clock', at(2))).toBe(1)
    expect(labelOpacity('mercury', at(2), 'clock', at(2))).toBeLessThan(0.1)
    expect(labelOpacity('mercury', at(4), 'clock', at(4))).toBe(1)
  })

  it('names the Moon at the default zoom but not zoomed out', () => {
    expect(labelOpacity('moon', at(MAIN_ZOOM), 'clock', at(MAIN_ZOOM))).toBe(1)
    expect(labelOpacity('moon', at(1), 'clock', at(1))).toBe(0)
  })

  it("hides Jupiter's moons zoomed out and names all four with Jupiter framed", () => {
    for (const key of moonsOf('jupiter')) {
      expect(labelOpacity(key, at(1), 'clock', at(1)), key).toBe(0)
      expect(labelOpacity(key, JUPITER_FRAMED, 'jupiter', JUPITER_FRAMED), key).toBeGreaterThan(0.9)
    }
  })

  it("names Saturn's widely spaced moons first, with Saturn framed", () => {
    expect(labelOpacity('titan', SATURN_FRAMED, 'saturn', SATURN_FRAMED)).toBeGreaterThan(0.9)
    expect(labelOpacity('iapetus', SATURN_FRAMED, 'saturn', SATURN_FRAMED)).toBeGreaterThan(0.9)
    expect(labelOpacity('enceladus', SATURN_FRAMED, 'saturn', SATURN_FRAMED)).toBe(0)
    expect(labelOpacity('mimas', SATURN_FRAMED, 'saturn', SATURN_FRAMED)).toBe(0)
    // Rhea next, zooming on in; Enceladus only closer still.
    expect(labelOpacity('rhea', SATURN_FRAMED / 1.5, 'saturn', SATURN_FRAMED / 1.5)).toBeGreaterThan(0.9)
    expect(labelOpacity('enceladus', SATURN_FRAMED / 1.5, 'saturn', SATURN_FRAMED / 1.5)).toBeLessThan(0.25)
    expect(labelOpacity('enceladus', SATURN_FRAMED / 2.5, 'saturn', SATURN_FRAMED / 2.5)).toBe(1)
  })

  it('names Triton with Neptune framed', () => {
    expect(labelOpacity('triton', framed(PLANETS.neptune.radius), 'neptune', framed(PLANETS.neptune.radius))).toBeGreaterThan(0.9)
  })

  it('always names the focused body', () => {
    for (const key of LABEL_KEYS) {
      for (const upp of [at(1), at(10), at(40), at(400)]) {
        expect(labelOpacity(key, upp, key as CameraFocus, upp), `${key} @ ${upp}`).toBe(1)
      }
    }
  })

  it('fades out names outside the focused system when zoomed far in on it', () => {
    // Saturn framed, then four times closer: Saturn ~120 px in radius.
    const close = SATURN_FRAMED / 4
    expect(labelOpacity('jupiter', SATURN_FRAMED, 'saturn', SATURN_FRAMED)).toBeGreaterThan(0.9)
    // Under BodyLabels' 0.01 cut-off: gone.
    expect(labelOpacity('jupiter', close, 'saturn', close)).toBeLessThan(0.01)
    expect(labelOpacity('sun', close, 'saturn', close)).toBeLessThan(0.01)
    expect(labelOpacity('io', close, 'saturn', close)).toBeLessThan(0.01)
    // ...but not Saturn's own moons.
    expect(labelOpacity('titan', close, 'saturn', close)).toBe(1)
    expect(labelOpacity('enceladus', close, 'saturn', close)).toBeGreaterThan(0.9)
    // A moon's focus spares its siblings and parent.
    const titanClose = at(4 * planetFramingZoom(moonRadius('titan'), EARTH_RADIUS))
    expect(labelOpacity('saturn', titanClose, 'titan', titanClose)).toBe(1)
    expect(labelOpacity('rhea', titanClose, 'titan', titanClose)).toBe(1)
    expect(labelOpacity('mars', titanClose, 'titan', titanClose)).toBeLessThan(0.01)
  })

  it("measures how far in the view is by the scale at the target, not a far body's", () => {
    // Saturn four times closer than framed, Jupiter ten times as deep: its
    // own upp alone would read as zoomed out.
    const close = SATURN_FRAMED / 4
    expect(labelOpacity('jupiter', 10 * close, 'saturn', 10 * close)).toBeGreaterThan(0.5)
    expect(labelOpacity('jupiter', 10 * close, 'saturn', close)).toBeLessThan(0.01)
  })

  it('counts the clock and a location as Earth, keeping the Moon close in', () => {
    const close = at(40)
    expect(labelOpacity('moon', close, 'clock', close)).toBe(1)
    expect(labelOpacity('moon', close, 'location', close)).toBe(1)
    expect(labelOpacity('sun', close, 'clock', close)).toBeLessThan(0.01)
  })

  it('spares everything with the camera on the Sun, whose system is all of them', () => {
    expect(labelOpacity('earth', at(40), 'sun', at(40))).toBe(1)
    expect(labelOpacity('mars', at(40), 'sun', at(40))).toBe(1)
  })

  it("never brightens a moon's name as the view zooms out", () => {
    for (const key of [...MOON_KEYS, 'moon'] as const) {
      let previous = Infinity
      for (let zoom = 40; zoom >= 1; zoom /= 1.05) {
        const opacity = labelOpacity(key, at(zoom), 'sun', at(zoom))
        expect(opacity, `${key} @ zoom ${zoom}`).toBeLessThanOrEqual(previous + 1e-12)
        previous = opacity
      }
    }
  })
})

describe('labelClearance', () => {
  it('is the gap to the nearest neighbouring orbit', () => {
    // Mercury's nearest is the Sun's surface, Venus' Earth's orbit.
    expect(labelClearance('mercury')).toBeCloseTo(7.6, 0)
    expect(labelClearance('venus')).toBeCloseTo(15, 0)
    expect(labelClearance('moon')).toBeCloseTo(10 - EARTH_RADIUS, 6)
    expect(labelClearance('earth')).toBe(Infinity)
    expect(labelClearance('triton')).toBe(Infinity)
    // Enceladus is between Mimas and Tethys, much tighter than Titan.
    expect(labelClearance('enceladus')).toBeLessThan(labelClearance('titan') / 3)
  })
})

describe('bodyReach', () => {
  it("reaches Saturn's and Uranus' ring edges face-on, the globe edge-on", () => {
    expect(bodyReach('saturn')).toBeCloseTo(PLANETS.saturn.radius * 2.27, 6)
    expect(bodyReach('uranus')).toBeCloseTo(PLANETS.uranus.radius * 2.001, 6)
    expect(bodyReach('saturn', 1)).toBe(PLANETS.saturn.radius)
    // 60° from the pole: the ring foreshortened to sin 60°.
    expect(bodyReach('saturn', 0.5)).toBeCloseTo(PLANETS.saturn.radius * 2.27 * Math.sqrt(0.75), 6)
    expect(bodyReach('jupiter', 0)).toBe(PLANETS.jupiter.radius)
  })
})

describe('label placement', () => {
  const HALF_W = 20
  const HALF_H = 6

  it('clears the disc by the gap plus the half-extent along the direction', () => {
    expect(labelDistancePx(1, 0, 30, HALF_W, HALF_H, 6)).toBe(30 + 6 + HALF_W)
    expect(labelDistancePx(0, -1, 30, HALF_W, HALF_H, 6)).toBe(30 + 6 + HALF_H)
    const d = Math.SQRT1_2
    expect(labelDistancePx(d, d, 30, HALF_W, HALF_H, 6)).toBeCloseTo(36 + d * (HALF_W + HALF_H), 9)
  })

  it('normalises the direction, falling back to straight up', () => {
    const out = { x: 0, y: 0 }
    expect(labelDirection(3, 4, out)).toEqual({ x: 0.6, y: 0.8 })
    expect(labelDirection(0, 0, out)).toEqual({ x: 0, y: 1 })
  })

  it('turns the Moon off a sunward heading, along its orbit', () => {
    // The Sun is to the left of the Moon: away from it is +x.
    expect(steerClearOfSun({ x: 0, y: 1 }, 1, 0)).toEqual({ x: 0, y: 1 })
    expect(steerClearOfSun({ x: 1, y: 0 }, 1, 0)).toEqual({ x: 1, y: 0 })
    const turned = steerClearOfSun({ x: -Math.SQRT1_2, y: Math.SQRT1_2 }, 1, 0)
    expect(turned.x).toBeCloseTo(0, 12)
    expect(turned.y).toBeCloseTo(1, 12)
    // Head-on: a perpendicular, still unit length.
    const headOn = steerClearOfSun({ x: -1, y: 0 }, 1, 0)
    expect(Math.abs(headOn.x)).toBeCloseTo(0, 12)
    expect(Math.abs(headOn.y)).toBeCloseTo(1, 12)
  })
})

describe('collisions', () => {
  it('overlaps boxes only when both axes overlap', () => {
    expect(boxesOverlap(0, 0, 10, 5, 15, 0, 6, 5)).toBe(true)
    expect(boxesOverlap(0, 0, 10, 5, 17, 0, 6, 5)).toBe(false)
    expect(boxesOverlap(0, 0, 10, 5, 0, 11, 10, 5)).toBe(false)
  })

  it('hits a disc by its nearest point, not its bounding box', () => {
    expect(boxHitsDisc(0, 0, 10, 5, 0, 12, 8)).toBe(true)
    // Diagonal from the corner (10, 5): 5√2 ≈ 7.07 away.
    expect(boxHitsDisc(0, 0, 10, 5, 15, 10, 7)).toBe(false)
    expect(boxHitsDisc(0, 0, 10, 5, 15, 10, 7.1)).toBe(true)
  })
})

describe('resolveLabels', () => {
  // Names 40 × 12 px; bodies' default side to the right; a big view.
  function setup(bodies: [x: number, y: number, r: number][]): LabelLayout {
    const layout = createLabelLayout(bodies.length, 1)
    bodies.forEach(([x, y, r], i) => {
      layout.discX[i] = x
      layout.discY[i] = y
      layout.discR[i] = r
      layout.inView[i] = 1
      layout.wanted[i] = 1
      layout.halfW[i] = 20
      layout.halfH[i] = 6
      layout.dirX[i] = 1
      layout.dirY[i] = 0
    })
    return layout
  }
  function frame(layout: LabelLayout, over: Partial<LabelFrame> = {}): LabelFrame {
    return {
      focus: -1,
      obstacleRank: Infinity,
      left: -1000,
      right: 1000,
      bottom: -1000,
      top: 1000,
      // Long enough for any fade to finish in one call.
      delta: 1,
      gapPx: 6,
      reach: (i) => layout.discR[i],
      ...over,
    }
  }

  it('keeps the higher-priority name where it is and moves the other', () => {
    // Name 0 lands at (36, 0); name 1's default, (36, 14), would cover it.
    const layout = setup([
      [0, 0, 10],
      [0, 14, 10],
    ])
    resolveLabels(layout, frame(layout))
    expect(layout.side[0]).toBe(0)
    expect(layout.boxX[0]).toBe(36)
    expect(layout.side[1]).not.toBe(0)
    expect([...layout.shown]).toEqual([1, 1])
  })

  it('places the focused name first', () => {
    const layout = setup([
      [0, 0, 10],
      [0, 14, 10],
    ])
    resolveLabels(layout, frame(layout, { focus: 1 }))
    expect(layout.side[1]).toBe(0)
    expect(layout.side[0]).not.toBe(0)
  })

  it('fades out a name with no side free, but never the focused one', () => {
    // A view just big enough for the bodies: no name fits anywhere.
    const layout = setup([
      [0, 0, 10],
      [30, 0, 10],
    ])
    const tight = { left: -15, right: 45, bottom: -15, top: 15 }
    resolveLabels(layout, frame(layout, tight))
    expect([...layout.shown]).toEqual([0, 0])
    resolveLabels(layout, frame(layout, { ...tight, focus: 1 }))
    expect([...layout.shown]).toEqual([0, 1])
  })

  it('eases a name out as its globe leaves the view, rather than dropping it', () => {
    // Just past the right edge, where its name would fit on the inner side.
    const layout = setup([[1012, 0, 10]])
    layout.shown[0] = 1
    resolveLabels(layout, frame(layout, { delta: 0.1 }))
    expect(layout.shown[0]).toBeCloseTo(0.6, 9)
  })

  it('keeps the focused name off another globe when no side is clear of everything', () => {
    // A view too small for any name; a big globe on the default side.
    const layout = setup([
      [0, 0, 10],
      [36, 0, 20],
    ])
    layout.wanted[1] = 0
    resolveLabels(layout, frame(layout, { focus: 0, left: -15, right: 15, bottom: -15, top: 15 }))
    expect(layout.side[0]).not.toBe(0)
    expect(boxHitsDisc(layout.boxX[0], layout.boxY[0], layout.halfW[0], layout.halfH[0], 36, 0, 20)).toBe(false)
    expect(layout.shown[0]).toBe(1)
  })

  it('fades the focused name only while all of its body is behind a nearer globe', () => {
    const layout = setup([
      [0, 0, 10],
      [5, 0, 50],
    ])
    layout.nearness[1] = 1
    layout.wanted[1] = 0
    resolveLabels(layout, frame(layout, { focus: 0 }))
    expect(layout.shown[0]).toBe(0)
    // Its centre covered but its top showing: named, above, off the globe.
    layout.discY[1] = -45
    resolveLabels(layout, frame(layout, { focus: 0 }))
    expect(layout.shown[0]).toBe(1)
    expect(boxHitsDisc(layout.boxX[0], layout.boxY[0], layout.halfW[0], layout.halfH[0], 5, -45, 50)).toBe(false)
  })

  it('eases a name out over LABEL_COLLISION_FADE_S rather than at once', () => {
    const layout = setup([[0, 0, 10]])
    layout.shown[0] = 1
    resolveLabels(layout, frame(layout, { left: -15, right: 15, bottom: -15, top: 15, delta: 0.1 }))
    expect(layout.shown[0]).toBeCloseTo(0.6, 9)
  })

  it('lets a shown name graze its neighbour, but a hidden one waits until it is clear', () => {
    // Name 1 at (29, 15) is 15 px above name 0: inside the 16 px they keep
    // apart, but within the hysteresis pad.
    const shown = setup([
      [0, 0, 10],
      [0, 15, 3],
    ])
    shown.shown[1] = 1
    resolveLabels(shown, frame(shown))
    expect(shown.side[1]).toBe(0)

    const hidden = setup([
      [0, 0, 10],
      [0, 15, 3],
    ])
    resolveLabels(hidden, frame(hidden))
    expect(hidden.side[1]).not.toBe(0)
  })

  it('turns a name that would run off the view to a side that fits', () => {
    // Near the right edge, where "Sun" would read "Su".
    const layout = setup([[50, 0, 10]])
    resolveLabels(layout, frame(layout, { right: 70 }))
    expect(layout.side[0]).not.toBe(0)
    expect(layout.boxX[0] + layout.halfW[0]).toBeLessThanOrEqual(70)
    expect(layout.shown[0]).toBe(1)
  })

  it('keeps off obstacles only the names it does not outrank', () => {
    const layout = setup([
      [0, 0, 10],
      [0, 100, 10],
    ])
    layout.obstacleCount = 1
    layout.obstacleHalfW[0] = 20
    layout.obstacleHalfH[0] = 6
    // On name 0's default spot: name 0 (rank 0) outranks it and stays.
    layout.obstacleX[0] = 36
    layout.obstacleY[0] = 0
    resolveLabels(layout, frame(layout, { obstacleRank: 0 }))
    expect(layout.side[0]).toBe(0)
    // On name 1's: it moves.
    layout.obstacleY[0] = 100
    resolveLabels(layout, frame(layout, { obstacleRank: 0 }))
    expect(layout.side[1]).not.toBe(0)
  })

  it('drops the name of a body behind a larger, nearer globe, whatever its priority', () => {
    const layout = setup([
      [0, 0, 5],
      [2, 0, 30],
    ])
    layout.nearness[1] = 10
    expect(eclipsed(layout, 0)).toBe(true)
    layout.nearness[1] = -10
    expect(eclipsed(layout, 0)).toBe(false)
  })
})

describe('resolveLabels sides', () => {
  function one(): LabelLayout {
    const layout = createLabelLayout(1, 0, 1)
    layout.discR[0] = 10
    layout.inView[0] = 1
    layout.wanted[0] = 1
    layout.halfW[0] = 20
    layout.halfH[0] = 6
    layout.dirX[0] = 1
    return layout
  }
  const frame = (layout: LabelLayout): LabelFrame => ({
    focus: -1,
    obstacleRank: Infinity,
    left: -1000,
    right: 1000,
    bottom: -1000,
    top: 1000,
    delta: 1,
    gapPx: 6,
    reach: () => layout.discR[0],
  })

  it('keeps off a blocker (the clock), and goes back to its own side once that is clear', () => {
    const layout = one()
    layout.blockerCount = 1
    layout.blockerX[0] = 36
    layout.blockerR[0] = 5
    resolveLabels(layout, frame(layout))
    expect(layout.side[0]).not.toBe(0)
    layout.blockerX[0] = 500
    resolveLabels(layout, frame(layout))
    expect(layout.side[0]).toBe(0)
  })
})
