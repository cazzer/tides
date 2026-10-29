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
import { describe, expect, it } from 'vitest'
import { DEFAULT_SYSTEM_AIDS, isPlanetFocus } from '../../store'
import { MAIN_FOV, minDistance } from '../../main-view'
import { MOON_UNITS_PER_KM, earthPosition, moonOffset } from '../../ephemeris'
import { positionsFor } from '../../flight-scale'
import { sceneRadius } from '../../planets'
import { eyeDirection } from '../demo-script'
import { clampLook } from '../../sky-look'
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

    it.each(demo.steps.map((step, i) => [i, step] as const))('step %i is well formed', (i, step) => {
      const date = Date.parse(step.date)
      expect(Number.isFinite(date)).toBe(true)
      if (step.until !== undefined) {
        expect(Date.parse(step.until)).toBeGreaterThan(date)
      }
      if (step.timeScale !== undefined) {
        expect(Number.isFinite(step.timeScale)).toBe(true)
        expect(step.timeScale).toBeGreaterThanOrEqual(0)
      }
      if (step.camera) {
        expect(step.camera.distance).toBeGreaterThanOrEqual(minDistance(step.camera.focus))
        expect(Number.isFinite(step.camera.azimuth)).toBe(true)
        expect(Math.abs(step.camera.elevation)).toBeLessThanOrEqual(90)
      }
      if (step.location) {
        expect(Math.abs(step.location.lat)).toBeLessThanOrEqual(90)
        expect(Math.abs(step.location.lon)).toBeLessThanOrEqual(180)
      }
      if (step.skyLook) expect(clampLook(step.skyLook)).toEqual(step.skyLook)
      if (step.skyFov != null) expect(step.skyFov).toBeGreaterThan(0)
      expect(step.caption.title.trim()).not.toBe('')
      expect(step.caption.body.trim()).not.toBe('')
      expect(step.caption.title.length).toBeLessThanOrEqual(40)
      expect(step.caption.body.length).toBeLessThanOrEqual(220)

      // A planet focus needs the planets shown, whatever the user had on.
      const patch = demoStepPatch(bare, demo, i)
      if (isPlanetFocus(patch.cameraFocus)) expect(patch.showPlanets).toBe(true)

      // Only what exit puts back: nothing else (demo-only aids) is stored.
      const restored = new Set([...Object.keys(bare).filter((k) => k !== 'compass'), 'jumpDate', 'demo'])
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

  it('stops the partial phase at second contact and plays totality inside it', () => {
    expect(Date.parse(demo.steps[1].until!)).toBeLessThanOrEqual(totalBegin)
    expect(Date.parse(demo.steps[2].date)).toBeGreaterThan(totalBegin)
    expect(Date.parse(demo.steps[2].until!)).toBeLessThan(totalEnd)
  })

  it('stops the shadow’s track as the umbra leaves Earth', () => {
    expect(Date.parse(demo.steps[3].until!)).toBeLessThanOrEqual(Date.parse('2024-04-08T19:56:00Z'))
  })
})

describe('seasons', () => {
  const demo = findDemo('seasons')!
  const year = Seasons(2026)
  const perihelion = SearchPlanetApsis(Body.Earth, new Date('2026-12-25T00:00:00Z')).time.date
  const instants = [year.mar_equinox, year.jun_solstice, year.sep_equinox, year.dec_solstice].map((t) => t.date)

  it('steps through the 2026 equinoxes and solstices, then perihelion', () => {
    const expected = [...instants, perihelion]
    expect(demo.steps).toHaveLength(expected.length)
    demo.steps.forEach((step, i) => {
      expect(Math.abs(Date.parse(step.date) - expected[i].getTime())).toBeLessThan(60_000)
    })
  })

  it('plays one day at each, from the user’s own location', () => {
    for (const step of demo.steps) {
      expect(Date.parse(step.until!) - Date.parse(step.date)).toBe(86_400_000)
      expect(step.location).toBeUndefined()
    }
  })
})

describe('tides', () => {
  const demo = findDemo('tides')!
  const HOUR = 3_600_000

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

  it.each(demo.steps.map((_, i) => [i] as const))('step %i looks from the Moon’s side, with the Moon off frame', (i) => {
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
    expect(Math.abs(((moonAz - pose.azimuth + 540) % 360) - 180)).toBeLessThan(15)

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
      const halfV = (MAIN_FOV / 2) * DEG
      const halfH = Math.atan(Math.tan(halfV) * aspect)
      const reach = Math.asin(moonRadius / c.length())
      const offV = Math.atan(Math.abs(c.y) / -c.z) - reach
      const offH = Math.atan(Math.abs(c.x) / -c.z) - reach
      expect(c.z > 0 || offV > halfV || offH > halfH).toBe(true)
    }
  })

  it('fits the globe and its bulge across a phone', () => {
    const R = sceneRadius(12742000)
    for (const step of demo.steps) {
      if (!step.camera) continue
      expect(1.25 * R).toBeLessThanOrEqual(Math.tan((MAIN_FOV / 2) * DEG) * (390 / 844) * step.camera.distance)
    }
  })
})

function moonDistanceKm(t: number): number {
  return moonOffset(t).reduce((sum, v) => sum + v * v, 0) ** 0.5 / MOON_UNITS_PER_KM
}
