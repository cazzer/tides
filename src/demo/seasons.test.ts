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
  type LabelSideInput,
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

  it('shows on the tour’s way between stops and not at any stop, on a desktop and a phone', () => {
    for (const view of [desk, phone]) {
      expect(wideFade(radius / uppAt(eyeAt(wide, view), view))).toBe(1)
      tour.steps.forEach((step) => {
        expect(wideFade(radius / uppAt(eyeAt(step.camera!, view), view))).toBeLessThan(0.01)
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
    }
    const side = (input: Partial<LabelSideInput>) => labelSide({ ...base, ...input }, { x: 0, y: 0 })

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
  })
})
