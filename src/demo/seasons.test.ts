import { Body, SearchPlanetApsis, Seasons } from 'astronomy-engine'
import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import { applyBodyTransform } from '../body-transform'
import { earthPosition, earthSpin, earthTilt } from '../ephemeris'
import { subsolarPoint } from '../geo-clouds'
import { MAIN_FOV } from '../main-view'
import { sceneRadius } from '../planets'
import { worldUnitsPerPixel } from '../system-aids/pixel-scale'
import { calculateLocationAndRotationForLatLng } from '../utils'
import { poseDistance } from './demo-script'
import { findDemo } from './demos'
import {
  apsisLabel,
  dailyTop,
  ghostDates,
  insolation,
  latitudeCircle,
  markerRadius,
  northAxis,
  SEASONS_APSIDES,
  standInFade,
  chromeBox,
  viewShift,
  holdSpot,
  keepInView,
  type HeldSpot,
  type LabelSideInput,
  type LabelSpot,
  type ScreenSegment,
  wideFade,
  SOLAR_CONSTANT,
  labelSide,
  seasonsLatitude,
  shownSubsolarPoint,
  sunForSeasons,
} from './seasons'
import { earthSpinLag, setEarthSpinHold, shownEarthSpin } from './demo-travel'

const DEG = Math.PI / 180
const seasons = Seasons(2026)
const perihelion = SearchPlanetApsis(Body.Earth, new Date('2026-12-25T00:00:00Z')).time.date.getTime()
const june = seasons.jun_solstice.date.getTime()
const december = seasons.dec_solstice.date.getTime()

function at(lat: number, ms: number) {
  const sun = sunForSeasons(ms)
  return insolation(lat, sun.dec, sun.distanceAu)
}

describe('dailyTop', () => {
  it('matches the textbook references', () => {
    // The equator at an equinox: S0/π.
    expect(dailyTop(0, 0, 1)).toBeCloseTo(SOLAR_CONSTANT / Math.PI, 2)
    expect(dailyTop(0, 0, 1)).toBeCloseTo(433.22, 2)
    // The pole at the June solstice, Sun up all day at 23.44°: S0 sin δ.
    expect(Math.abs(dailyTop(90, 23.44, 1) - 541.39)).toBeLessThan(0.1)
  })
})

describe('insolation at 45°N, 2026', () => {
  it('at the June solstice', () => {
    const q = at(45, june)
    expect(Math.abs(q.dailyTop - 483.5)).toBeLessThan(1) // tables: ~480–490 (Hartmann Fig. 2.6)
    expect(Math.abs(q.daylightHours - 15.62)).toBeLessThan(0.02)
    expect(Math.abs(q.noonAltitude - 68.4)).toBeLessThan(0.1)
    expect(Math.abs(q.noonGround - 843)).toBeLessThan(3)
    expect(Math.abs(q.tilt.percent! - 0.63)).toBeLessThan(0.005)
    expect(Math.abs(q.distance.percent - -0.0316)).toBeLessThan(0.0005)
  })

  it('at the December solstice and perihelion', () => {
    const q = at(45, december)
    expect(Math.abs(q.tilt.percent! - -0.62)).toBeLessThan(0.005)
    expect(Math.abs(q.distance.percent - 0.0333)).toBeLessThan(0.0005)
    expect(Math.abs(q.dailyTop - 120.4)).toBeLessThan(1)
    expect(Math.abs(at(45, perihelion).distance.percent - 0.0341)).toBeLessThan(0.0003)
  })

  it('swaps the solstices at 45°S', () => {
    expect(Math.abs(at(-45, december).tilt.percent! - 0.63)).toBeLessThan(0.01)
    expect(at(-45, december).dailyTop).toBeGreaterThan(at(45, june).dailyTop)
  })

  it('gives Meinel’s 0.625 of the beam through 1.5 air masses', () => {
    // Air mass 1.5 is the Sun 48.19° from the zenith: at the equinox, that
    // latitude's noon.
    const lat = 48.19
    const q = insolation(lat, 0, 1)
    expect(Math.abs(q.noonGround / q.noonTop - 0.625)).toBeLessThan(0.005)
  })
})

describe('insolation in the polar circle', () => {
  it('70°N in December: polar night, nothing finite missing', () => {
    const q = at(70, december)
    expect(q.daylightHours).toBe(0)
    expect(q.dailyTop).toBe(0)
    expect(q.noonGround).toBe(0)
    expect(q.noonTop).toBe(0)
    expect(q.noonAltitude).toBeLessThan(0)
    expect(Number.isFinite(q.tilt.wm2)).toBe(true)
    expect(q.tilt.percent).not.toBeNull()
  })

  it('70°N in June: the midnight Sun', () => {
    expect(at(70, june).daylightHours).toBe(24)
  })

  it('has no tilt percent where the equinox day is dark', () => {
    expect(insolation(90, 10, 1).tilt.percent).toBeNull()
  })
})

describe('seasonsLatitude', () => {
  it('falls back to 45°N without a pin', () => {
    expect(seasonsLatitude(null)).toEqual({ lat: 45, pinned: false })
    expect(seasonsLatitude({ lat: -33.9, lon: 18.4 })).toEqual({ lat: -33.9, pinned: true })
  })
})

describe('latitudeCircle', () => {
  it('puts the circle through the latitude’s points', () => {
    const R = 2
    const circle = latitudeCircle(-34, R)
    // Any point at −34°, as the globe's pins place it, is on the circle.
    for (const lon of [0, 18.4, 90, -170]) {
      const { x, y, z } = calculateLocationAndRotationForLatLng(-34, lon, R).position
      expect(y).toBeCloseTo(circle.y, 5)
      expect(Math.hypot(x, z)).toBeCloseTo(circle.radius, 5)
    }
  })
})

describe('the subsolar dot', () => {
  const instants = [
    seasons.mar_equinox.date.getTime(),
    june,
    seasons.sep_equinox.date.getTime(),
    december,
    perihelion,
  ]

  it.each(instants)('faces the Sun in the globe’s frame at %i', (t) => {
    const globe = new THREE.Object3D()
    applyBodyTransform(globe, { tiltAt: earthTilt, spinAt: earthSpin, positionAt: earthPosition }, t)
    globe.updateMatrixWorld(true)
    const p = subsolarPoint(t)
    const { x, y, z } = calculateLocationAndRotationForLatLng(p.lat, p.lon, 1).position
    const dot = globe.localToWorld(new THREE.Vector3(x, y, z)).sub(globe.position).normalize()
    const toSun = globe.position.clone().negate().normalize()
    expect(Math.acos(Math.min(1, dot.dot(toSun))) / DEG).toBeLessThan(0.5)
  })

  describe('on a globe a travel holds', () => {
    afterEach(() => setEarthSpinHold(null))
    // June to the September equinox, the globe setting out a third of a turn
    // off the true spin: well short of it, or past it, on the way.
    const from = june
    const to = seasons.sep_equinox.date.getTime()

    it.each([0.1, 0.35, 0.6, 0.9])('stays under the Sun %f of the way', (p) => {
      setEarthSpinHold({ from, to, spinFrom: earthSpin(from) + 2 })
      const t = from + (to - from) * p
      expect(Math.abs(earthSpinLag(t))).toBeGreaterThan(0.1)
      const globe = new THREE.Object3D()
      applyBodyTransform(globe, { tiltAt: earthTilt, spinAt: shownEarthSpin, positionAt: earthPosition }, t)
      globe.updateMatrixWorld(true)
      const shown = shownSubsolarPoint(t)
      const { x, y, z } = calculateLocationAndRotationForLatLng(shown.lat, shown.lon, 1).position
      const dot = globe.localToWorld(new THREE.Vector3(x, y, z)).sub(globe.position).normalize()
      const toSun = globe.position.clone().negate().normalize()
      expect(Math.acos(Math.min(1, dot.dot(toSun))) / DEG).toBeLessThan(0.5)
    })
  })
})

describe('the orbit aid', () => {
  // Earth's drawn radius (solar-system.tsx's EARTH_DIAMETER, used as one).
  const radius = sceneRadius(12742000)
  const tour = findDemo('seasons')!
  const wide = tour.steps[1].travel!.camera!
  const desk = { width: 1440, height: 900 }
  const phone = { width: 390, height: 844 }

  // Scene units a CSS px spans at the focus, the eye `distance` from it.
  function uppAt(distance: number, view: { width: number; height: number }) {
    const camera = new THREE.PerspectiveCamera(MAIN_FOV, view.width / view.height, 0.1, 1e5)
    camera.position.set(0, 0, distance)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()
    return worldUnitsPerPixel(camera, new THREE.Vector3(), view.height)
  }
  const eyeAt = (pose: { distance: number; fit?: number }, view: { width: number; height: number }) =>
    poseDistance(pose, MAIN_FOV, view.width / view.height)

  it('pins the apsides on either side of the tour', () => {
    const aphelion = SearchPlanetApsis(Body.Earth, new Date('2026-06-01T00:00:00Z'))
    const next = SearchPlanetApsis(Body.Earth, new Date('2026-12-25T00:00:00Z'))
    const [far, near] = SEASONS_APSIDES
    expect(Math.abs(far.t - aphelion.time.date.getTime())).toBeLessThan(1000)
    expect(far.distanceAu).toBeCloseTo(aphelion.dist_au, 5)
    expect(Math.abs(near.t - next.time.date.getTime())).toBeLessThan(1000)
    expect(Math.abs(near.t - perihelion)).toBeLessThan(1000)
    expect(near.distanceAu).toBeCloseTo(next.dist_au, 5)
    expect(apsisLabel(near.kind, near.distanceAu)).toBe('Closest · 147.1 million km')
    expect(apsisLabel(far.kind, far.distanceAu)).toBe('Farthest · 152.1 million km')
  })

  it('sizes the stand-in on screen, never under the true globe', () => {
    const upp = uppAt(1000, desk)
    expect(markerRadius(upp, radius, desk.width) / upp).toBeCloseTo(14)
    expect(markerRadius(upp, radius, phone.width) / upp).toBeCloseTo(10)
    // Close in, the true globe is the larger.
    expect(markerRadius(uppAt(tour.steps[0].camera!.distance, desk), radius, desk.width)).toBe(radius)
  })

  it('shows on the tour’s way between stops and through the year, not at any stop, on a desktop and a phone', () => {
    for (const view of [desk, phone]) {
      expect(wideFade(radius / uppAt(eyeAt(wide, view), view))).toBe(1)
      tour.steps.forEach((step) => {
        const fade = wideFade(radius / uppAt(eyeAt(step.camera!, view), view))
        // The year's view is about the Sun: Earth is farther still.
        if (step.camera!.focus === 'sun') expect(fade).toBe(1)
        else expect(fade).toBeLessThan(0.01)
      })
    }
  })

  it('draws the stand-in over the true globe only once clearly larger', () => {
    expect(standInFade(1.1)).toBe(0)
    expect(standInFade(1.3)).toBe(0)
    expect(standInFade(2)).toBe(1)
    expect(standInFade(1.65)).toBeCloseTo(0.5)
  })

  it('leaves a ghost at every stop reached', () => {
    const dates = [10, 20, 30, 40, 50]
    expect(ghostDates(dates, 0, false)).toEqual([])
    expect(ghostDates(dates, 0, true)).toEqual([10])
    expect(ghostDates(dates, 3, false)).toEqual([10, 20, 30])
    expect(ghostDates(dates, 3, true)).toEqual([10, 20, 30, 40])
    expect(ghostDates(dates, 4, true)).toEqual(dates)
  })

  it('points the axis where the globe’s north is', () => {
    const globe = new THREE.Object3D()
    applyBodyTransform(globe, { tiltAt: earthTilt, spinAt: earthSpin, positionAt: earthPosition }, june)
    const north = new THREE.Vector3(0, 1, 0).applyQuaternion(globe.quaternion)
    const [x, y, z] = northAxis(earthTilt(june))
    expect(north.distanceTo(new THREE.Vector3(x, y, z))).toBeLessThan(1e-9)
    expect(z).toBeGreaterThan(0.39)
  })

  describe('labelSide', () => {
    const base: LabelSideInput = {
      dotX: 100,
      dotY: 0,
      outX: 1,
      outY: 0.2,
      halfW: 70,
      halfH: 7,
      clearPx: 9,
      viewW: 1440,
      viewH: 900,
      obstacles: [],
      segments: [],
      passing: [],
      passingSegments: [],
      boxes: [],
      held: null,
    }
    const side = (input: Partial<LabelSideInput>) => {
      const { x, y } = labelSide({ ...base, ...input }, { x: 0, y: 0, spot: 0, better: null })
      return { x, y }
    }

    it('goes beside the dot, away from the Sun', () => {
      expect(side({})).toEqual({ x: 100 + 9 + 70, y: 0 })
      expect(side({ outX: -1 })).toEqual({ x: 100 - 9 - 70, y: 0 })
      // Nearly straight up: above.
      expect(side({ outX: 0.1, outY: 1 })).toEqual({ x: 100, y: 9 + 7 })
    })

    it('goes the other side at the view’s edge', () => {
      expect(side({ dotX: 600 })).toEqual({ x: 600 - 9 - 70, y: 0 })
      expect(side({ dotX: -170, outX: -1, viewW: 390, viewH: 844 })).toEqual({ x: -170 + 9 + 70, y: 0 })
    })

    it('keeps off Earth at the dot and off the Sun', () => {
      // Earth on the dot, its axis reaching 40 px: the label clears it.
      expect(side({ obstacles: [{ x: 100, y: 0, r: 40 }] })).toEqual({ x: 100 + 40 + 70, y: 0 })
      expect(side({ obstacles: [{ x: 105, y: 0, r: 40 }] })).toEqual({ x: 100 + 45 + 70, y: 0 })
      // The Sun on the outward side: the other side.
      expect(side({ obstacles: [{ x: 250, y: 0, r: 30 }] })).toEqual({ x: 100 - 9 - 70, y: 0 })
    })

    it('stays on the first side when none fits', () => {
      expect(side({ viewW: 120, viewH: 120 })).toEqual({ x: 179, y: 0 })
    })

    // The base's spots: right (179, 0), left (21, 0), above (100, 16), below
    // (100, -16); a cross through the dot takes all four.
    const cross: ScreenSegment[] = [
      { ax: -100, ay: 0, bx: 300, by: 0, r: 2 },
      { ax: 100, ay: -60, bx: 100, by: 60, r: 2 },
    ]

    it('keeps off the demo’s boxes, with a margin', () => {
      expect(side({ boxes: [{ left: 150, right: 300, bottom: -20, top: 20 }] })).toEqual({ x: 21, y: 0 })
      // The label's right edge is at 249: a box 5 px past it is within the margin.
      expect(side({ boxes: [{ left: 254, right: 400, bottom: -20, top: 20 }] })).toEqual({ x: 21, y: 0 })
      expect(side({ boxes: [{ left: 260, right: 400, bottom: -20, top: 20 }] })).toEqual({ x: 179, y: 0 })
    })

    it('keeps off an axis drawn through its spot', () => {
      expect(side({ segments: [{ ax: 179, ay: -50, bx: 179, by: 50, r: 2 }] })).toEqual({ x: 21, y: 0 })
      // Slanted, missing the label's box by more than its width: no matter.
      expect(side({ segments: [{ ax: 260, ay: -50, bx: 300, by: 50, r: 2 }] })).toEqual({ x: 179, y: 0 })
    })

    it('goes to a corner with all four sides taken', () => {
      const at = side({ segments: cross })
      expect(at.x).toBeCloseTo(100 + 9 * Math.SQRT1_2 + 70)
      expect(at.y).toBeCloseTo(9 * Math.SQRT1_2 + 7)
    })

    it('goes the next corner round when the first is taken', () => {
      // The Sun on the first corner (toward +x, +y).
      const at = side({ segments: cross, obstacles: [{ x: 200, y: 30, r: 15 }] })
      expect(at.x).toBeCloseTo(100 + 9 * Math.SQRT1_2 + 70)
      expect(at.y).toBeCloseTo(-9 * Math.SQRT1_2 - 7)
    })

    it('goes a ring farther out when the first ring is taken', () => {
      // A thick bar along the dot's row takes every spot of the first ring
      // but above and below, which the thin axis takes.
      const segments: ScreenSegment[] = [
        { ax: -100, ay: 0, bx: 300, by: 0, r: 8 },
        { ax: 100, ay: -60, bx: 100, by: 60, r: 2 },
      ]
      const at = side({ segments })
      const clear = 9 + 8
      expect(at.x).toBeCloseTo(100 + clear * Math.SQRT1_2 + 70)
      expect(at.y).toBeCloseTo(clear * Math.SQRT1_2 + 7)
    })

    it('covers a drawn shape rather than a box when it must', () => {
      // Every spot crosses the bar; the first is under a box too.
      const segments: ScreenSegment[] = [{ ax: -700, ay: 0, bx: 700, by: 0, r: 200 }]
      expect(side({ segments, boxes: [{ left: 150, right: 300, bottom: -20, top: 20 }] })).toEqual({ x: 21, y: 0 })
    })

    it('would rather sit where Earth goes by than over the Sun', () => {
      // A bar over every spot, and the Sun on the first.
      const bar: ScreenSegment[] = [{ ax: -700, ay: 0, bx: 700, by: 0, r: 200 }]
      const sun = [{ x: 250, y: 0, r: 30 }]
      expect(side({ passingSegments: bar, obstacles: sun })).toEqual({ x: 21, y: 0 })
      // A bar that stays put is no better than the Sun: the first spot.
      expect(side({ segments: bar, obstacles: sun })).toEqual({ x: 179, y: 0 })
    })

    it('eases out round something just off the dot', () => {
      // Earth 12 px above the dot, 10 px across: off it, but still widening.
      expect(side({ passing: [{ x: 100, y: 12, r: 10 }] })).toEqual({ x: 100 + 18 + 70, y: 0 })
      expect(side({ passing: [{ x: 100, y: 40, r: 10 }] })).toEqual({ x: 179, y: 0 })
    })

    it('slides a label above its dot into the view', () => {
      // Straight up, the dot 70 px from the view's left edge.
      expect(side({ dotX: -650, outX: 0.1, outY: 1 })).toEqual({ x: -720 + 8 + 70, y: 16 })
    })

    it('holds last frame’s spot while it is as clear as any', () => {
      // Spot 1, the other side; spot 0, the first, is as clear.
      expect(side({ held: 1 })).toEqual({ x: 21, y: 0 })
      expect(labelSide({ ...base, held: 1 }, { x: 0, y: 0, spot: 0, better: null })).toMatchObject({ spot: 1, better: 0 })
      expect(labelSide({ ...base, held: 0 }, { x: 0, y: 0, spot: 0, better: null })).toMatchObject({ spot: 0, better: null })
      expect(side({ held: 1, boxes: [{ left: -60, right: 60, bottom: -20, top: 20 }] })).toEqual({ x: 179, y: 0 })
      // Earth over it, the first spot clear: the clear one.
      const earth: ScreenSegment[] = [{ ax: 21, ay: -50, bx: 21, by: 50, r: 2 }]
      expect(side({ held: 1, passingSegments: earth })).toEqual({ x: 179, y: 0 })
      // Nothing clear of Earth: still held.
      expect(side({ held: 1, passingSegments: [...earth, { ax: 179, ay: -50, bx: 179, by: 50, r: 200 }] })).toEqual({ x: 21, y: 0 })
    })

    it('gives a held spot back to a better one once that has stayed clear', () => {
      const held: HeldSpot = { spot: 1, better: null, betterFor: 0 }
      const at: LabelSpot = { x: 0, y: 0, spot: 0, better: null }
      const frame = (input: Partial<LabelSideInput> = {}) => {
        labelSide({ ...base, ...input, held: held.spot }, at)
        holdSpot(held, at, 1 / 60)
        return { x: at.x, y: at.y }
      }
      // A box over the first spot for a while: the label holds the other side.
      for (let i = 0; i < 30; i++) expect(frame({ boxes: [{ left: 150, right: 300, bottom: -20, top: 20 }] })).toEqual({ x: 21, y: 0 })
      // The box gone: still held for 0.3 s, the first spot clear all along,
      // then back to it.
      let frames = 1
      while (frame().x !== 179 && frames < 100) frames++
      expect(frames / 60).toBeCloseTo(0.3 + 1 / 60, 1)
      expect(held).toMatchObject({ spot: 0, better: null })
      // Clear only now and then, it never wins back.
      held.spot = 1
      for (let i = 0; i < 120; i++) {
        expect(frame(i % 10 === 0 ? { boxes: [{ left: 150, right: 300, bottom: -20, top: 20 }] } : {})).toEqual({ x: 21, y: 0 })
      }
    })

    it('finds a clear spot at a phone’s perihelion', () => {
      // 390x844, the readout over the top, the caption over the bottom; the
      // dot near the right edge with the January stop's axis through it, the
      // December stop's 30 px below, the Sun up and to the left.
      const axis = (x: number, y: number, reach: number): ScreenSegment[] => {
        const ax = 0.35
        const ay = 0.94
        const tipX = x + ax * reach
        const tipY = y + ay * reach
        return [
          { ax: x - ax * reach, ay: y - ay * reach, bx: tipX, by: tipY, r: 1.25 + 4 },
          { ax: tipX, ay: tipY, bx: tipX + ax * 11, by: tipY + ay * 11, r: 5 + 4 },
        ]
      }
      const input: LabelSideInput = {
        ...base,
        dotX: 150,
        dotY: -40,
        outX: 210,
        outY: -60,
        halfW: 68,
        halfH: 6.5,
        viewW: 390,
        viewH: 844,
        obstacles: [
          { x: -60, y: 20, r: 30 },
          { x: 150, y: -40, r: 8 },
          { x: 145, y: -70, r: 8 },
        ],
        segments: [...axis(150, -40, 26), ...axis(145, -70, 22)],
        boxes: [
          { left: -179, right: 179, bottom: 140, top: 414 },
          { left: -187, right: 187, bottom: -414, top: -250 },
        ],
      }
      const at = labelSide(input, { x: 0, y: 0, spot: 0, better: null })
      const x0 = at.x - input.halfW
      const x1 = at.x + input.halfW
      const y0 = at.y - input.halfH
      const y1 = at.y + input.halfH
      expect(Math.abs(at.x) + input.halfW).toBeLessThanOrEqual(195 - 8)
      expect(Math.abs(at.y) + input.halfH).toBeLessThanOrEqual(422 - 8)
      for (const b of input.boxes) expect(x1 < b.left || x0 > b.right || y1 < b.bottom || y0 > b.top).toBe(true)
      // Every shape's distance from the label's box, sampled.
      const gap = (px: number, py: number) => Math.hypot(Math.max(x0 - px, 0, px - x1), Math.max(y0 - py, 0, py - y1))
      for (const c of input.obstacles) expect(gap(c.x, c.y)).toBeGreaterThanOrEqual(c.r)
      for (const s of input.segments) {
        for (let t = 0; t <= 1; t += 1 / 64) {
          expect(gap(s.ax + (s.bx - s.ax) * t, s.ay + (s.by - s.ay) * t)).toBeGreaterThanOrEqual(s.r)
        }
      }
    })
  })

  describe('keepInView', () => {
    const input = { halfW: 70, halfH: 7, viewW: 390, viewH: 844 } as LabelSideInput
    it('moves a label inside the view’s margin, and only then', () => {
      expect(keepInView({ x: 150, y: 0 }, input)).toEqual({ x: 195 - 8 - 70, y: 0 })
      expect(keepInView({ x: -20, y: -500 }, input)).toEqual({ x: -20, y: -(422 - 8 - 7) })
      expect(keepInView({ x: 50, y: 10 }, input)).toEqual({ x: 50, y: 10 })
      // A view narrower than the label: left be.
      expect(keepInView({ x: 50, y: 10 }, { ...input, viewW: 120 })).toEqual({ x: 50, y: 10 })
    })
  })

  describe('viewShift', () => {
    it('is the shift setViewOffset gives the picture, px with y up', () => {
      const width = 390
      const height = 844
      const camera = new THREE.PerspectiveCamera(MAIN_FOV, width / height, 0.1, 1000)
      const point = new THREE.Vector3(1, 2, -10)
      const onScreen = () => {
        const ndc = point.clone().project(camera)
        return { x: (ndc.x * width) / 2, y: (ndc.y * height) / 2 }
      }
      const centred = onScreen()
      expect(viewShift(camera.view, { x: 1, y: 1 })).toEqual({ x: 0, y: 0 })
      camera.setViewOffset(width, height, 0, -88, width, height)
      const shift = viewShift(camera.view, { x: 0, y: 0 })
      expect(shift).toEqual({ x: -0, y: -88 })
      expect(onScreen().x).toBeCloseTo(centred.x + shift.x)
      expect(onScreen().y).toBeCloseTo(centred.y + shift.y)
      camera.setViewOffset(width, height, 30, 105, width, height)
      viewShift(camera.view, shift)
      expect(onScreen().x).toBeCloseTo(centred.x + shift.x)
      expect(onScreen().y).toBeCloseTo(centred.y + shift.y)
      camera.clearViewOffset()
      expect(viewShift(camera.view, shift)).toEqual({ x: 0, y: 0 })
    })
  })

  describe('chromeBox', () => {
    const view = { left: 0, top: 0, width: 390, height: 844 }
    const box = { left: 0, right: 0, bottom: 0, top: 0 }

    it('measures a box from the view’s centre, y up', () => {
      // A phone's readout over the top of the view.
      expect(chromeBox({ left: 8, top: 8, right: 382, bottom: 288 }, view, box)).toBe(true)
      expect(box).toEqual({ left: -187, right: 187, top: 414, bottom: 134 })
      // A view lower down the page.
      expect(chromeBox({ left: 8, top: 108, right: 382, bottom: 388 }, { ...view, top: 100 }, box)).toBe(true)
      expect(box).toEqual({ left: -187, right: 187, top: 414, bottom: 134 })
    })

    it('says when a box is off the view', () => {
      expect(chromeBox({ left: 8, top: 900, right: 382, bottom: 1000 }, view, box)).toBe(false)
      expect(chromeBox({ left: 400, top: 8, right: 500, bottom: 100 }, view, box)).toBe(false)
    })
  })
})
