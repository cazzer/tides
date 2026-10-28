import { Body, Equator, Horizon, MakeTime, Observer, SearchLocalSolarEclipse } from 'astronomy-engine'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SYSTEM_AIDS, isPlanetFocus } from '../../store'
import { minDistance } from '../../main-view'
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
