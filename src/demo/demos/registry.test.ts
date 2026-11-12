import {
  ApsisKind,
  Body,
  Equator,
  Horizon,
  MakeTime,
  NextMoonQuarter,
  Observer,
  SearchLocalSolarEclipse,
  SearchLunarApsis,
  SearchMoonQuarter,
  SearchPlanetApsis,
  Seasons,
} from 'astronomy-engine'
import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SYSTEM_AIDS, isPlanetFocus } from '../../store'
import { MAIN_FOV, maxDistance, minDistance } from '../../main-view'
import { MOON_UNITS_PER_KM, earthPosition, moonOffset } from '../../ephemeris'
import { positionsFor, type BodyKey } from '../../flight-scale'
import { PLANETS, PLANET_KEYS, sceneRadius } from '../../planets'
import {
  MOONS,
  MOON_PARENTS,
  SYSTEM_EXPANSION_MAX,
  moonOrbitRadius,
  moonRadius,
  moonSystemExtent,
  moonsOf,
  setMoonExpansion,
  type MoonParent,
} from '../../moons/moons'
import { expansionCap, resetMoonExpansions, stepMoonExpansions } from '../../moons/moon-expansion'
import {
  easeProgress,
  easedEye,
  eyeDirection,
  intoPoseFrame,
  outOfPoseFrame,
  poseDirection,
  poseDistance,
  type DemoFocus,
  type DemoPose,
  type PoseBodies,
} from '../demo-script'
import { DEMO_FLIGHT_SECONDS } from '../DemoPlayer'
import { FLIGHT_LEAD_SECONDS, MIN_LAP_FRAMES, lapSeconds } from '../moon-laps'
import { MOON_SHOWCASE } from './planets'
import { clampLook } from '../../sky-look'
import { demoAidAt } from '../demo-aids'
import { demoStepPatch, type DemoSaved } from '../demo-session'
import { DEMOS, findDemo } from '.'

// A user's view with nothing a demo might rely on turned on.
const bare: DemoSaved = {
  timestamp: null,
  timeScale: 1,
  cameraFocus: 'clock',
  mainPanel: 'main',
  layout: 'triple',
  location: null,
  showPlanets: false,
  showConstellations: false,
  showConstellationArt: false,
  showLunar: false,
  showZodiac: false,
  systemAids: { ...DEFAULT_SYSTEM_AIDS },
  skyLook: null,
  skyFov: null,
  compass: false,
}

const DEG = Math.PI / 180

// Ceilings, not targets: a body should aim for ~15 words (tides-zec.15).
const CAPTION_TITLE_WORDS = 4
const CAPTION_BODY_WORDS = 22

function words(text: string): number {
  return text.trim().split(/\s+/).length
}

/** Angle in degrees between two alt/az directions. */
function separation(a: { azimuth: number; altitude: number }, b: { azimuth: number; altitude: number }): number {
  const cos =
    Math.sin(a.altitude * DEG) * Math.sin(b.altitude * DEG) +
    Math.cos(a.altitude * DEG) * Math.cos(b.altitude * DEG) * Math.cos((a.azimuth - b.azimuth) * DEG)
  return Math.acos(Math.min(1, Math.max(-1, cos))) / DEG
}

describe('DEMOS', () => {
  it('have unique ids, each found by findDemo', () => {
    const ids = DEMOS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const demo of DEMOS) expect(findDemo(demo.id)).toBe(demo)
    expect(findDemo('no-such-demo')).toBeUndefined()
  })

  describe.each(DEMOS.map((demo) => [demo.id, demo] as const))('%s', (_, demo) => {
    it('has a title, a blurb and at least one step', () => {
      expect(demo.title.trim()).not.toBe('')
      expect(demo.blurb.trim()).not.toBe('')
      expect(demo.steps.length).toBeGreaterThan(0)
    })

    // Few words, read at a glance in the larger caption (tides-zec.15).
    it.each(demo.steps.map((step, i) => [i, step] as const))('step %i caption fits the word budget', (_, step) => {
      expect(words(step.caption.title)).toBeLessThanOrEqual(CAPTION_TITLE_WORDS)
      expect(words(step.caption.body)).toBeLessThanOrEqual(CAPTION_BODY_WORDS)
    })

    it.each(demo.steps.map((step, i) => [i, step] as const))('step %i is well formed', (i, step) => {
      const date = Date.parse(step.date)
      expect(Number.isFinite(date)).toBe(true)
      if (step.until !== undefined) {
        expect(Date.parse(step.until)).toBeGreaterThan(date)
      }
      if (step.loop) {
        const from = Date.parse(step.loop.from)
        const to = Date.parse(step.loop.to)
        expect(from).toBeGreaterThanOrEqual(date)
        expect(to).toBeGreaterThan(from)
        expect(Number.isInteger(step.loop.times) && step.loop.times >= 1).toBe(true)
        expect(step.loop.holdMs ?? 0).toBeGreaterThanOrEqual(0)
        // A stop short of `to` would end the first pass there.
        if (step.until !== undefined) expect(Date.parse(step.until)).toBeGreaterThanOrEqual(to)
      }
      for (const speed of step.speeds ?? []) {
        expect(Date.parse(speed.at)).toBeGreaterThanOrEqual(date)
        expect(speed.timeScale).toBeGreaterThan(0)
      }
      if (step.timeScale !== undefined) {
        expect(Number.isFinite(step.timeScale)).toBe(true)
        expect(step.timeScale).toBeGreaterThanOrEqual(0)
      }
      // A planet focus needs the planets shown, whatever the user had on.
      const patch = demoStepPatch(bare, demo, i)
      // A desktop, and the tightest the system view fits: a phone held
      // upright, where a pose's fit backs the eye off the most.
      const views = [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
      ]
      const poseFits = (pose: Omit<DemoPose, 'focus'>, focus: DemoFocus) => {
        expect(pose.distance).toBeGreaterThanOrEqual(minDistance(focus))
        if (pose.fit !== undefined) expect(pose.fit).toBeGreaterThan(0)
        for (const view of views) {
          const distance = poseDistance(pose, MAIN_FOV, view.width / view.height)
          expect(distance).toBeLessThanOrEqual(maxDistance(patch.showPlanets, view))
        }
        expect(Number.isFinite(pose.azimuth)).toBe(true)
        expect(Math.abs(pose.elevation)).toBeLessThanOrEqual(90)
      }
      if (step.camera) poseFits(step.camera, step.camera.focus)
      if (step.travel) {
        const { seconds, rate } = step.travel
        expect((seconds === undefined) !== (rate === undefined)).toBe(true)
        expect(seconds ?? rate).toBeGreaterThan(0)
        // The travel's pose is about the step's focus, which it can't change
        // on the way: the focus is the one the step before left.
        if (step.travel.camera) {
          expect(step.camera).toBeDefined()
          poseFits(step.travel.camera, step.camera!.focus)
        }
        if (i > 0 && step.camera) {
          expect(demoStepPatch(bare, demo, i - 1).cameraFocus).toBe(step.camera.focus)
        }
        if (step.travel.hold?.includes('moon')) expect(patch.cameraFocus).not.toBe('moon')
      }
      if (step.location) {
        expect(Math.abs(step.location.lat)).toBeLessThanOrEqual(90)
        expect(Math.abs(step.location.lon)).toBeLessThanOrEqual(180)
      }
      if (step.skyLook) expect(clampLook(step.skyLook)).toEqual(step.skyLook)
      if (step.skyFov != null) expect(step.skyFov).toBeGreaterThan(0)
      expect(step.caption.title.trim()).not.toBe('')
      expect(step.caption.body.trim()).not.toBe('')

      if (isPlanetFocus(patch.cameraFocus)) expect(patch.showPlanets).toBe(true)

      // Only what exit puts back: nothing else (demo-only aids) is stored.
      const restored = new Set([...Object.keys(bare).filter((k) => k !== 'compass'), 'jumpDate', 'demoTravel', 'demo'])
      for (const key of Object.keys(patch)) expect(restored).toContain(key)
      for (const key of Object.keys(patch.systemAids)) expect(Object.keys(DEFAULT_SYSTEM_AIDS)).toContain(key)
    })
  })
})

describe('lunar eclipse', () => {
  const demo = findDemo('lunar-eclipse')!

  it('looks at the eclipsed Moon, high in Honolulu’s sky, at greatest eclipse', () => {
    const step = demo.steps[3]
    const patch = demoStepPatch(bare, demo, 3)
    expect(patch.mainPanel).toBe('top')
    expect(patch.location).toEqual({ lat: 21.31, lon: -157.86 })
    const observer = new Observer(patch.location!.lat, patch.location!.lon, 0)
    const date = new Date(step.date)
    const eq = Equator(Body.Moon, date, observer, true, true)
    const moon = Horizon(date, observer, eq.ra, eq.dec, 'normal')
    expect(moon.altitude).toBeGreaterThan(45)
    expect(separation(patch.skyLook!, moon)).toBeLessThan(15)
  })

  it('only runs time forward, each step starting where the last one stops', () => {
    for (let i = 1; i < demo.steps.length; i++) {
      expect(Date.parse(demo.steps[i].date)).toBeGreaterThanOrEqual(Date.parse(demo.steps[i - 1].until!))
    }
  })
})

describe('solar eclipse', () => {
  const demo = findDemo('solar-eclipse')!
  const torreon = new Observer(25.54, -103.41, 0)
  const local = SearchLocalSolarEclipse(MakeTime(new Date('2024-04-01T00:00:00Z')), torreon)
  const totalBegin = local.total_begin!.time.date.getTime()
  const totalEnd = local.total_end!.time.date.getTime()

  function sunAt(iso: string) {
    const date = new Date(iso)
    const eq = Equator(Body.Sun, date, torreon, true, true)
    return Horizon(date, torreon, eq.ra, eq.dec, 'normal')
  }

  it('matches the contacts its header quotes', () => {
    // To the nearest second.
    const fmt = (t: number) => new Date(Math.round(t / 1000) * 1000).toISOString().slice(11, 19)
    expect(fmt(local.partial_begin.time.date.getTime())).toBe('17:00:03')
    expect(fmt(totalBegin)).toBe('18:17:01')
    expect(fmt(totalEnd)).toBe('18:21:13')
    expect(fmt(local.peak.time.date.getTime())).toBe('18:19:07')
    expect(fmt(local.partial_end.time.date.getTime())).toBe('19:41:32')
  })

  it.each([1, 2])('step %i looks at the high Sun from Torreón', (i) => {
    const patch = demoStepPatch(bare, demo, i)
    expect(patch.mainPanel).toBe('top')
    expect(patch.location).toEqual({ lat: 25.54, lon: -103.41 })
    const sun = sunAt(demo.steps[i].date)
    expect(sun.altitude).toBeGreaterThan(45)
    expect(separation(patch.skyLook!, sun)).toBeLessThan(i === 1 ? 30 : 5)
  })

  it('stops the partial phase just before second contact and plays totality through third', () => {
    // Totality carries straight on from the partial phase, so second contact
    // plays live a few seconds in.
    expect(demo.steps[2].date).toBe(demo.steps[1].until)
    expect(Date.parse(demo.steps[2].date)).toBeLessThan(totalBegin)
    expect(totalBegin - Date.parse(demo.steps[2].date)).toBeLessThanOrEqual(30_000)
    // On past third contact, so the diamond ring and the light coming back play.
    expect(Date.parse(demo.steps[2].until!)).toBeGreaterThan(totalEnd)
    expect(Date.parse(demo.steps[2].until!)).toBeLessThanOrEqual(totalEnd + 30_000)
  })

  it('stops the shadow’s track as the umbra leaves Earth, both times', () => {
    for (const i of [3, 4]) {
      expect(Date.parse(demo.steps[i].until!)).toBeLessThanOrEqual(Date.parse('2024-04-08T19:56:00Z'))
    }
  })

  it('runs its clock on from step to step but for the replayed crossing', () => {
    demo.steps.forEach((step, i) => {
      if (i === 0) return
      const replay = i === 4
      expect(step.date).toBe(replay ? demo.steps[3].date : demo.steps[i - 1].until)
    })
    expect(demo.steps[4].camera?.frame).toBe('earth')
  })
})

describe('seasons', () => {
  const demo = findDemo('seasons')!
  const year = Seasons(2026)
  const perihelion = SearchPlanetApsis(Body.Earth, new Date('2026-12-25T00:00:00Z')).time.date
  const instants = [year.mar_equinox, year.jun_solstice, year.sep_equinox, year.dec_solstice].map((t) => t.date)

  const stops = demo.steps.slice(0, 5)
  const yearStep = demo.steps[5]

  it('steps through the 2026 equinoxes and solstices, then perihelion, then a year', () => {
    const expected = [...instants, perihelion]
    expect(demo.steps).toHaveLength(expected.length + 1)
    stops.forEach((step, i) => {
      expect(Math.abs(Date.parse(step.date) - expected[i].getTime())).toBeLessThan(60_000)
    })
  })

  it('plays one day at each stop, from the user’s own location', () => {
    for (const step of stops) {
      expect(Date.parse(step.until!) - Date.parse(step.date)).toBe(86_400_000)
    }
    for (const step of demo.steps) expect(step.location).toBeUndefined()
  })

  it('hides the Moon throughout and looks against the stars, so the axis keeps its lean on screen', () => {
    demo.steps.forEach((step, i) => {
      expect(demoAidAt(demo, i, 'hideMoon')).toBe(true)
      expect(step.camera?.frame).toBe('stars')
      if (i > 0 && step.travel) expect(step.travel.camera?.frame).toBe('stars')
    })
  })

  it('shows the sea ice at every step', () => {
    demo.steps.forEach((_, i) => expect(demoAidAt(demo, i, 'seaIce')).toBe(true))
  })

  // tides-zec.19: the whole orbit, from where the last stop ends, the spin
  // held so the globe doesn't strobe, about the Sun from the stops' side.
  it('plays a whole year from where the last stop ends, twice, the spin held, about the Sun', () => {
    expect(Date.parse(yearStep.date)).toBe(Date.parse(stops[4].until!))
    const span = Date.parse(yearStep.loop!.to) - Date.parse(yearStep.loop!.from)
    expect(span).toBe(365 * 86_400_000)
    expect(yearStep.loop).toMatchObject({ from: yearStep.date, to: yearStep.until, holdSpin: true })
    expect(yearStep.loop!.times).toBeGreaterThanOrEqual(2)
    const seconds = span / 1000 / yearStep.timeScale!
    expect(seconds).toBeGreaterThanOrEqual(20)
    expect(seconds).toBeLessThanOrEqual(40)
    expect(yearStep.camera).toMatchObject({ focus: 'sun', frame: 'stars', azimuth: stops[0].camera!.azimuth, elevation: stops[0].camera!.elevation })
    // The orbit (50 units) and Earth's axis about it in view.
    expect(yearStep.camera!.fit).toBeGreaterThan(50)
  })
})

describe('tides', () => {
  const demo = findDemo('tides')!
  const HOUR = 3_600_000
  // The screen's top 13%, in the -1..1 units below: on a 390×844 phone the
  // readout's three lines end 11.6% down.
  const READOUT_BAND = 1 - 2 * 0.13

  /** The quarter (0 new, 1 first quarter, 2 full) nearest `t`. */
  function nearestQuarter(t: number, quarter: number) {
    let q = SearchMoonQuarter(new Date(t - 20 * 24 * HOUR))
    let best = Infinity
    for (let i = 0; i < 8; i++, q = NextMoonQuarter(q)) {
      if (q.quarter !== quarter) continue
      const gap = q.time.date.getTime() - t
      if (Math.abs(gap) < Math.abs(best)) best = gap
    }
    return best
  }

  it('steps through a New Moon, a first quarter and a Full Moon', () => {
    const quarters = [0, 0, 0, 1, 2]
    demo.steps.forEach((step, i) => {
      expect(Math.abs(nearestQuarter(Date.parse(step.date), quarters[i]))).toBeLessThan(60_000)
    })
  })

  it('ends on 2026’s nearest Full Moon, with perigee within 12 h', () => {
    const king = Date.parse(demo.steps[4].date)
    const perigee = SearchLunarApsis(new Date(king - 7 * 24 * HOUR))
    expect(perigee.kind).toBe(ApsisKind.Pericenter)
    expect(Math.abs(perigee.time.date.getTime() - king)).toBeLessThan(12 * HOUR)
    // Every other Full Moon of 2026 is farther.
    const kingKm = moonDistanceKm(king)
    let q = SearchMoonQuarter(new Date('2026-01-01T00:00:00Z'))
    for (; q.time.date.getUTCFullYear() === 2026; q = NextMoonQuarter(q)) {
      if (q.quarter !== 2) continue
      const t = q.time.date.getTime()
      if (Math.abs(t - king) > 60_000) expect(moonDistanceKm(t)).toBeGreaterThan(kingKm)
    }
  })

  it('plays one lunar day on the daily step and holds the clock on the rest', () => {
    const daily = demo.steps[2]
    expect(Date.parse(daily.until!) - Date.parse(daily.date)).toBe(89_400_000)
    expect(daily.timeScale).toBeGreaterThan(0)
    for (const i of [0, 1, 3, 4]) expect(demo.steps[i].timeScale).toBe(0)
    for (const step of demo.steps) expect(step.location).toBeUndefined()
  })

  it.each(demo.steps.map((_, i) => [i] as const))('step %i has the Moon in frame above Earth, clear of the readout', (i) => {
    const patch = demoStepPatch(bare, demo, i)
    expect(patch.cameraFocus).toBe('earth')
    const pose = demo.steps.slice(0, i + 1).reverse().find((s) => s.camera)!.camera!
    const t = Date.parse(demo.steps[i].date)
    const earth = new THREE.Vector3(...earthPosition(t))
    const moon = new THREE.Vector3(...moonOffset(t))
    // The Moon's angle from the Sun about ecliptic north, as eyeDirection
    // measures the azimuth.
    const toSun = earth.clone().negate()
    const moonAz = (Math.atan2(-moon.z, moon.x) - Math.atan2(-toSun.z, toSun.x)) / DEG
    // The eye is on the far side of Earth from the Moon.
    expect(Math.abs(((moonAz + 180 - pose.azimuth + 540) % 360) - 180)).toBeLessThan(15)

    const eye = eyeDirection(earth, new THREE.Vector3(), earth, pose.azimuth, pose.elevation)
      .multiplyScalar(pose.distance)
      .add(earth)
    const moonRadius = positionsFor('system').radius.moon
    for (const aspect of [1440 / 900, 390 / 844]) {
      const camera = new THREE.PerspectiveCamera(MAIN_FOV, aspect, 0.1, 1000)
      camera.position.copy(eye)
      camera.lookAt(earth)
      camera.updateMatrixWorld(true)
      const c = moon.clone().add(earth).applyMatrix4(camera.matrixWorldInverse)
      // In screen units, -1..1 bottom to top: the Moon's whole disc above
      // Earth and below the readout's band at the top.
      const tanHalf = Math.tan((MAIN_FOV / 2) * DEG)
      const y = c.y / -c.z / tanHalf
      const reach = moonRadius / -c.z / tanHalf
      const x = c.x / -c.z / tanHalf / aspect
      expect(c.z).toBeLessThan(0)
      expect(Math.abs(x) + reach / aspect).toBeLessThan(1)
      expect(y - reach).toBeGreaterThan(0.3)
      expect(y + reach).toBeLessThan(READOUT_BAND)
    }
  })

  it('fits the globe and its bulge across a phone', () => {
    const R = sceneRadius(12742000)
    for (const step of demo.steps) {
      if (!step.camera) continue
      expect(1.35 * R).toBeLessThanOrEqual(Math.tan((MAIN_FOV / 2) * DEG) * (390 / 844) * step.camera.distance)
    }
  })
})

describe('planets', () => {
  const demo = findDemo('planets')!
  const SYSTEM = positionsFor('system')
  const HOUR = 3_600_000
  const DESKTOP = 1440 / 900
  const at = (key: BodyKey, t: number) => new THREE.Vector3(...SYSTEM.positionAt[key](t))
  // The pose's frame needs no Earth turn: no flight here is in Earth's.
  const bodiesAt = (focus: DemoFocus, t: number): PoseBodies => ({
    focus: at(focus as BodyKey, t),
    sun: at('sun', t),
    earth: at('earth', t),
    earthTurn: new THREE.Quaternion(),
  })
  const span = (i: number) => ({ from: Date.parse(demo.steps[i].date), to: Date.parse(demo.steps[i].until!) })
  const sampled = (from: number, to: number, every: number) => {
    const times: number[] = []
    for (let t = from; t <= to; t += every) times.push(t)
    return times
  }

  afterEach(resetMoonExpansions)

  it('visits Mercury to Neptune in order, each stop starting where the last one stops', () => {
    expect(demo.steps.map((step) => step.camera?.focus)).toEqual([
      'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune',
    ])
    demo.steps.forEach((step, i) => {
      expect(step.until).toBeDefined()
      expect(step.timeScale).toBeGreaterThan(0)
      expect(step.travel).toBeUndefined()
      if (i > 0) expect(step.date).toBe(demo.steps[i - 1].until)
    })
  })

  it('turns the planets on, and spreads the moon systems at every step', () => {
    expect(demoStepPatch(bare, demo, 0)).toMatchObject({ showPlanets: true, layout: 'single', mainPanel: 'main' })
    demo.steps.forEach((_, i) => expect(demoAidAt(demo, i, 'moonSystems')).toBe(true))
  })

  const moonStops = demo.steps.flatMap((step, i) =>
    MOON_PARENTS.includes(step.camera!.focus as MoonParent) ? [[step.camera!.focus as MoonParent, i] as const] : []
  )

  it('stops at every planet with moons', () => {
    expect(moonStops.map(([parent]) => parent)).toEqual(MOON_PARENTS)
  })

  describe.each(moonStops)('%s', (parent, i) => {
    const step = demo.steps[i]
    const { named, laps, framed } = MOON_SHOWCASE[parent]
    const { from, to } = span(i)

    it('plays the named moon’s laps after the flight in, and no moon strobes', () => {
      expect(MOONS[named].parent).toBe(parent)
      const dwell = (to - from) / 1000 / step.timeScale! - FLIGHT_LEAD_SECONDS
      expect(laps * lapSeconds(MOONS[named].periodDays, step.timeScale!)).toBeLessThanOrEqual(dwell)
      for (const key of moonsOf(parent)) {
        expect(lapSeconds(MOONS[key].periodDays, step.timeScale!) * 60, key).toBeGreaterThanOrEqual(MIN_LAP_FRAMES)
      }
    })

    it('has room to spread the system all the way throughout', () => {
      for (const t of sampled(from, to, 6 * HOUR)) expect(expansionCap(parent, t)).toBe(SYSTEM_EXPANSION_MAX)
    })

    it('fits the outermost moon it frames, and the named one, spread', () => {
      expect(MOONS[framed].parent).toBe(parent)
      setMoonExpansion(parent, SYSTEM_EXPANSION_MAX)
      const reach = (key: typeof framed) => moonOrbitRadius(key, 'system') + moonRadius(key, 'system')
      expect(reach(named)).toBeLessThanOrEqual(reach(framed))
      expect(step.camera!.fit).toBeGreaterThanOrEqual(reach(framed))
    })
  })

  // At four days a second Earth spins four times a second: kept out of view.
  it.each([0, 1])('keeps Earth’s disc out of view at stop %i', (i) => {
    const pose = demo.steps[i].camera!
    const { from, to } = span(i)
    const halfDiagonal = Math.atan(Math.tan((MAIN_FOV / 2) * DEG) * Math.hypot(1, DESKTOP))
    const distance = poseDistance(pose, MAIN_FOV, DESKTOP)
    for (const t of sampled(from, to, 12 * HOUR)) {
      const bodies = bodiesAt(pose.focus, t)
      const eye = poseDirection(pose, bodies).multiplyScalar(distance).add(bodies.focus)
      const toEarth = bodies.earth.clone().sub(eye)
      const toFocus = bodies.focus.clone().sub(eye)
      const disc = Math.asin(SYSTEM.radius.earth / toEarth.length())
      expect(toEarth.angleTo(toFocus) - disc).toBeGreaterThan(halfDiagonal)
    }
  })
})

// Every step that moves the camera to another body flies there (DemoPlayer):
// the eye sets out from the last pose's, about the new focus, and arcs to
// the step's pose over DEMO_FLIGHT_SECONDS as the clock runs at the step's
// speed. It must keep clear of the Sun and every planet on the way, and not
// turn so near half round that the arc's way round is a toss-up.
describe('flights between bodies', () => {
  const SYSTEM = positionsFor('system')
  const SUN_CLEARANCE = 15
  const MAX_TURN = 170
  const at = (key: BodyKey, t: number) => new THREE.Vector3(...SYSTEM.positionAt[key](t))
  const bodiesAt = (focus: DemoFocus, t: number): PoseBodies => ({
    focus: at(focus as BodyKey, t),
    sun: at('sun', t),
    earth: at('earth', t),
    earthTurn: new THREE.Quaternion(),
  })
  // Each body's reach as drawn now: Earth's with its Moon's orbit, a
  // planet's rings or its moons at their live spread (moon-expansion.ts').
  const reachOf = (key: BodyKey): number => {
    if (key === 'earth') return 406_700 * MOON_UNITS_PER_KM + SYSTEM.radius.moon
    const planet = PLANETS[key as keyof typeof PLANETS]
    const rings = planet.radius * (planet.rings?.outer ?? 1)
    return MOON_PARENTS.includes(key as MoonParent)
      ? Math.max(rings, moonSystemExtent(key as MoonParent, 'system'))
      : rings
  }
  const obstacles: BodyKey[] = ['earth', ...PLANET_KEYS]
  const isParent = (focus: DemoFocus): focus is MoonParent => MOON_PARENTS.includes(focus as MoonParent)

  afterEach(resetMoonExpansions)

  it('takes as long as the planets tour allows for', () => {
    expect(DEMO_FLIGHT_SECONDS).toBeLessThanOrEqual(FLIGHT_LEAD_SECONDS)
  })

  const flights = DEMOS.flatMap((demo) =>
    demo.steps.flatMap((step, i) => {
      const before = demo.steps.slice(0, i).reverse().find((s) => s.camera)?.camera
      if (!step.camera || !before || before.focus === step.camera.focus) return []
      return [[`${demo.id} step ${i}`, demo, i, before] as const]
    })
  )

  it('include the planets tour’s and the seasons’ Earth-to-Sun', () => {
    expect(flights.map(([name]) => name)).toEqual(expect.arrayContaining(['seasons step 5', 'planets step 6']))
  })

  it.each(flights)('%s keeps clear of the Sun and the planets', (_, demo, i, before) => {
    const pose = demo.steps[i].camera!
    expect(pose.frame).not.toBe('earth')
    expect(before.frame).not.toBe('earth')
    expect(demo.steps[i].travel).toBeUndefined()
    const spread = demoAidAt(demo, i, 'moonSystems')
    const t0 = Date.parse(demo.steps[i].date)
    const { timeScale } = demoStepPatch(bare, demo, i)
    const frame = pose.frame ?? 'sun'
    for (const aspect of [1440 / 900, 390 / 844]) {
      // The system left as spread as it was, easing in as the new one grows.
      resetMoonExpansions()
      if (isParent(before.focus)) {
        setMoonExpansion(before.focus, Math.min(SYSTEM_EXPANSION_MAX, expansionCap(before.focus, t0)))
      }
      const last = bodiesAt(before.focus, t0)
      const lastEye = poseDirection(before, last)
        .multiplyScalar(poseDistance(before, MAIN_FOV, aspect))
        .add(last.focus)
      const start = bodiesAt(pose.focus, t0)
      const from = intoPoseFrame(lastEye.clone().sub(start.focus), frame, start)
      const distance = poseDistance(pose, MAIN_FOV, aspect)
      for (let k = 0; k <= 60; k++) {
        const seconds = (k / 60) * DEMO_FLIGHT_SECONDS
        const t = t0 + seconds * 1000 * timeScale
        if (k > 0) stepMoonExpansions(pose.focus, distance, t, DEMO_FLIGHT_SECONDS / 60, false, undefined, spread)
        const bodies = bodiesAt(pose.focus, t)
        const goal = poseDirection(pose, bodies)
        const fromNow = outOfPoseFrame(from, frame, bodies)
        expect(fromNow.angleTo(goal) / DEG).toBeLessThan(MAX_TURN)
        const eye = easedEye(fromNow, goal, bodies.focus, easeProgress(seconds, DEMO_FLIGHT_SECONDS), distance)
        expect(eye.distanceTo(bodies.sun)).toBeGreaterThanOrEqual(SUN_CLEARANCE)
        for (const key of obstacles) {
          expect(eye.distanceTo(at(key, t)), key).toBeGreaterThan(reachOf(key))
        }
      }
    }
  })
})

function moonDistanceKm(t: number): number {
  return moonOffset(t).reduce((sum, v) => sum + v * v, 0) ** 0.5 / MOON_UNITS_PER_KM
}
