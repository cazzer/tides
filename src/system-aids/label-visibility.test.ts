import { describe, expect, it } from 'vitest'
import { PLANETS, sceneRadius } from '../planets'
import { MAIN_ZOOM, PLANETS_MIN_ZOOM, planetFramingZoom } from '../main-view'
import { MOON_KEYS, moonRadius, moonsOf } from '../moons/moons'
import type { CameraFocus } from '../store'
import {
  LABEL_KEYS,
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
// Scene units per CSS px at a zoom: the main view's is 1 / zoom.
const at = (zoom: number) => 1 / zoom
const framed = (radius: number) => at(planetFramingZoom(radius, EARTH_RADIUS))
const JUPITER_FRAMED = framed(PLANETS.jupiter.radius)
const SATURN_FRAMED = framed(PLANETS.saturn.radius)

describe('labelOpacity', () => {
  it('names the Sun, Earth and the outer planets zoomed all the way out', () => {
    const upp = at(PLANETS_MIN_ZOOM)
    for (const key of ['sun', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'] as const) {
      expect(labelOpacity(key, upp, 'clock'), key).toBeGreaterThan(0.9)
    }
  })

  it('fades Mercury and Venus in as the inner system opens up', () => {
    expect(labelOpacity('mercury', at(1), 'clock')).toBe(0)
    expect(labelOpacity('venus', at(1), 'clock')).toBeLessThan(0.05)
    expect(labelOpacity('venus', at(2), 'clock')).toBe(1)
    expect(labelOpacity('mercury', at(2), 'clock')).toBeLessThan(0.1)
    expect(labelOpacity('mercury', at(4), 'clock')).toBe(1)
  })

  it('names the Moon at the default zoom but not zoomed out', () => {
    expect(labelOpacity('moon', at(MAIN_ZOOM), 'clock')).toBe(1)
    expect(labelOpacity('moon', at(1), 'clock')).toBe(0)
  })

  it("hides Jupiter's moons zoomed out and names all four with Jupiter framed", () => {
    for (const key of moonsOf('jupiter')) {
      expect(labelOpacity(key, at(1), 'clock'), key).toBe(0)
      expect(labelOpacity(key, JUPITER_FRAMED, 'jupiter'), key).toBeGreaterThan(0.9)
    }
  })

  it("names Saturn's widely spaced moons first, with Saturn framed", () => {
    expect(labelOpacity('titan', SATURN_FRAMED, 'saturn')).toBeGreaterThan(0.9)
    expect(labelOpacity('iapetus', SATURN_FRAMED, 'saturn')).toBeGreaterThan(0.9)
    expect(labelOpacity('enceladus', SATURN_FRAMED, 'saturn')).toBe(0)
    expect(labelOpacity('mimas', SATURN_FRAMED, 'saturn')).toBe(0)
    // Rhea next, zooming on in; Enceladus only closer still.
    expect(labelOpacity('rhea', SATURN_FRAMED / 1.5, 'saturn')).toBeGreaterThan(0.9)
    expect(labelOpacity('enceladus', SATURN_FRAMED / 1.5, 'saturn')).toBeLessThan(0.25)
    expect(labelOpacity('enceladus', SATURN_FRAMED / 2.5, 'saturn')).toBe(1)
  })

  it('names Triton with Neptune framed', () => {
    expect(labelOpacity('triton', framed(PLANETS.neptune.radius), 'neptune')).toBeGreaterThan(0.9)
  })

  it('always names the focused body', () => {
    for (const key of LABEL_KEYS) {
      for (const upp of [at(1), at(10), at(40), at(400)]) {
        expect(labelOpacity(key, upp, key as CameraFocus), `${key} @ ${upp}`).toBe(1)
      }
    }
  })

  it('fades out names outside the focused system when zoomed far in on it', () => {
    // Saturn framed, then four times closer: Saturn ~120 px in radius.
    const close = SATURN_FRAMED / 4
    expect(labelOpacity('jupiter', SATURN_FRAMED, 'saturn')).toBeGreaterThan(0.9)
    // Under BodyLabels' 0.01 cut-off: gone.
    expect(labelOpacity('jupiter', close, 'saturn')).toBeLessThan(0.01)
    expect(labelOpacity('sun', close, 'saturn')).toBeLessThan(0.01)
    expect(labelOpacity('io', close, 'saturn')).toBeLessThan(0.01)
    // ...but not Saturn's own moons.
    expect(labelOpacity('titan', close, 'saturn')).toBe(1)
    expect(labelOpacity('enceladus', close, 'saturn')).toBeGreaterThan(0.9)
    // A moon's focus spares its siblings and parent.
    const titanClose = at(4 * planetFramingZoom(moonRadius('titan'), EARTH_RADIUS))
    expect(labelOpacity('saturn', titanClose, 'titan')).toBe(1)
    expect(labelOpacity('rhea', titanClose, 'titan')).toBe(1)
    expect(labelOpacity('mars', titanClose, 'titan')).toBeLessThan(0.01)
  })

  it('counts the clock and a location as Earth, keeping the Moon close in', () => {
    const close = at(40)
    expect(labelOpacity('moon', close, 'clock')).toBe(1)
    expect(labelOpacity('moon', close, 'location')).toBe(1)
    expect(labelOpacity('sun', close, 'clock')).toBeLessThan(0.01)
  })

  it('spares everything with the camera on the Sun, whose system is all of them', () => {
    expect(labelOpacity('earth', at(40), 'sun')).toBe(1)
    expect(labelOpacity('mars', at(40), 'sun')).toBe(1)
  })

  it("never brightens a moon's name as the view zooms out", () => {
    for (const key of [...MOON_KEYS, 'moon'] as const) {
      let previous = Infinity
      for (let zoom = 40; zoom >= 1; zoom /= 1.05) {
        const opacity = labelOpacity(key, at(zoom), 'sun')
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
