import { Body, Equator, Horizon, Observer } from 'astronomy-engine'
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
