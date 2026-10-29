import * as THREE from 'three'
import { MakeTime, Observer, SearchLocalSolarEclipse, SearchMoonPhase } from 'astronomy-engine'
import { describe, expect, it } from 'vitest'
import { coveredFraction } from './eclipse'
import { SKY_SCALE, coronaFade, eclipseSkyAt } from './eclipse-sky'
import { sceneRadius } from './planets'
import {
  GROUND_RADIUS,
  eclipseDemoSkyScale,
  everydaySkyScale,
  skyDiscPositionsAt,
  skyObserverAt,
  type SkyScale,
} from './sky'
import { DEFAULT_RADIUS } from './renderers/Starfield'

// View from Earth's Sun and Moon end to end (tides-zec.8): placed by
// skyDiscPositionsAt, measured from the observer's eye as the camera sees
// them, against eclipseSkyAt's true sky and astronomy-engine's own contacts.

const SECOND = 1000
const HOUR = 3600 * SECOND
const DAY = 24 * HOUR
const EARTH_RADIUS = sceneRadius(12742000)
const RADII = { sun: sceneRadius(1392700000), moon: sceneRadius(3474800) }

const torreon = { name: 'Torreón', lat: 25.54, lon: -103.41, from: '2024-04-01' }
const dallas = { name: 'Dallas', lat: 32.78, lon: -96.8, from: '2024-04-01' }
// On the 2026-08-12 centre line, totality ~18:26:59–18:28:49 UT.
const asturias = { name: 'Asturias', lat: 43.3, lon: -5.5, from: '2026-08-01' }
const sites = [torreon, dallas, asturias]

function contacts(lat: number, lon: number, from: string) {
  const e = SearchLocalSolarEclipse(MakeTime(new Date(from)), new Observer(lat, lon, 0))
  return {
    partialBegin: e.partial_begin.time.date.getTime(),
    totalBegin: e.total_begin!.time.date.getTime(),
    totalEnd: e.total_end!.time.date.getTime(),
    partialEnd: e.partial_end.time.date.getTime(),
  }
}

function angle(a: THREE.Vector3, b: THREE.Vector3) {
  return Math.atan2(new THREE.Vector3().crossVectors(a, b).length(), a.dot(b))
}

/** The drawn discs as the eye sees them, and the true sky at that moment. */
function drawnSky(lat: number, lon: number, t: number, scale: SkyScale = everydaySkyScale) {
  const discs = skyDiscPositionsAt(lat, lon, EARTH_RADIUS, RADII, scale)
  const eye = new THREE.Vector3(...skyObserverAt(lat, lon, EARTH_RADIUS)(t))
  const sun = new THREE.Vector3(...discs.sun(t)).sub(eye)
  const moon = new THREE.Vector3(...discs.moon(t)).sub(eye)
  const sunDistance = sun.length()
  const moonDistance = moon.length()
  const drawn = {
    sun: sun.normalize(),
    moon: moon.normalize(),
    sunDistance,
    moonDistance,
    sunRadius: Math.asin(RADII.sun / sunDistance),
    moonRadius: Math.asin(RADII.moon / moonDistance),
    separation: angle(sun, moon),
  }
  // Read after the discs: eclipseSkyAt hands back one shared object.
  const e = eclipseSkyAt(t, lat, lon)
  return {
    drawn,
    e: {
      sun: e.sun.clone(),
      moon: e.moon.clone(),
      sunRadius: e.sunRadius,
      moonRadius: e.moonRadius,
      separation: e.separation,
      visible: e.visible,
    },
  }
}

describe('View from Earth draws the Sun and Moon at one scale (tides-zec.8)', () => {
  it('both at SKY_SCALE times their true size outside the demos', () => {
    const { drawn, e } = drawnSky(dallas.lat, dallas.lon, Date.parse('2026-10-29T18:00:00Z'))
    expect(Math.abs(drawn.sunRadius / e.sunRadius / SKY_SCALE - 1)).toBeLessThan(1e-9)
    expect(Math.abs(drawn.moonRadius / e.moonRadius / SKY_SCALE - 1)).toBeLessThan(1e-9)
  })

  it('the solar eclipse demo keeps its Sun at the system Sun’s distance', () => {
    const { drawn } = drawnSky(
      dallas.lat,
      dallas.lon,
      Date.parse('2026-10-29T18:00:00Z'),
      eclipseDemoSkyScale(RADII.sun)
    )
    expect(Math.abs(drawn.sunDistance - 50)).toBeLessThan(1e-9)
  })

  it.each(sites)('$name: every phase covers as much of the drawn Sun as of the real one', (site) => {
    const c = contacts(site.lat, site.lon, site.from)
    let samples = 0
    for (let t = c.partialBegin; t <= c.partialEnd; t += 60 * SECOND) {
      const { drawn, e } = drawnSky(site.lat, site.lon, t)
      const shown = coveredFraction(drawn.sunRadius, drawn.moonRadius, drawn.separation)
      expect(Math.abs(shown - coveredFraction(e.sunRadius, e.moonRadius, e.separation))).toBeLessThan(1e-6)
      expect(Math.abs(shown - (1 - e.visible))).toBeLessThan(1e-4)
      samples += 1
    }
    expect(samples).toBeGreaterThan(100)
  })

  it.each(sites)('$name: the drawn Sun is covered, and the corona full, only in totality', (site) => {
    const c = contacts(site.lat, site.lon, site.from)
    for (const t of [c.totalBegin + 10 * SECOND, c.totalEnd - 10 * SECOND]) {
      const { drawn, e } = drawnSky(site.lat, site.lon, t)
      expect(drawn.separation + drawn.sunRadius).toBeLessThanOrEqual(drawn.moonRadius)
      expect(coronaFade(e.visible)).toBe(1)
    }
    for (const t of [c.totalBegin - 15 * SECOND, c.totalEnd + 15 * SECOND]) {
      const { drawn, e } = drawnSky(site.lat, site.lon, t)
      expect(drawn.separation + drawn.sunRadius).toBeGreaterThan(drawn.moonRadius)
      expect(coronaFade(e.visible)).toBeLessThan(1)
    }
    for (const t of [c.totalBegin - 60 * SECOND, c.totalEnd + 60 * SECOND]) {
      expect(coronaFade(drawnSky(site.lat, site.lon, t).e.visible)).toBe(0)
    }
  })

  it('the drawn Moon stays within (k − 1)× the sum of the radii of the true one', () => {
    const k = SKY_SCALE
    for (let t = Date.parse('2026-10-01T00:00:00Z'); t < Date.parse('2026-11-01T00:00:00Z'); t += 6 * HOUR) {
      const { drawn, e } = drawnSky(torreon.lat, torreon.lon, t)
      expect(angle(drawn.moon, e.moon)).toBeLessThanOrEqual((k - 1) * (e.sunRadius + e.moonRadius) + 1e-9)
    }
  })

  it('no overlap at the non-eclipse new moon of 2026-10-10', () => {
    const newMoon = Date.parse('2026-10-10T15:50:37Z')
    for (const t of [newMoon - 12 * HOUR, newMoon, newMoon + 12 * HOUR]) {
      const { drawn } = drawnSky(torreon.lat, torreon.lon, t)
      expect(drawn.separation).toBeGreaterThan(drawn.sunRadius + drawn.moonRadius)
    }
  })

  it('around the full moon of 2026-10-26 the drawn Moon keeps moving, short of the antisolar point', () => {
    const fullMoon = SearchMoonPhase(180, MakeTime(new Date('2026-10-20T00:00:00Z')), 10)!.date.getTime()
    let previous: ReturnType<typeof drawnSky> | undefined
    for (let t = fullMoon - 12 * HOUR; t <= fullMoon + 12 * HOUR; t += 10 * 60 * SECOND) {
      const sky = drawnSky(torreon.lat, torreon.lon, t)
      expect(angle(sky.drawn.moon, sky.drawn.sun.clone().negate())).toBeGreaterThan(1e-6)
      if (previous) {
        // Against the stars, at nearly the true Moon's pace: not parked
        // opposite the Sun, which moves ~13× slower.
        const drawnStep = angle(sky.drawn.moon, previous.drawn.moon)
        const trueStep = angle(sky.e.moon, previous.e.moon)
        expect(drawnStep).toBeGreaterThan(0.5 * trueStep)
      }
      previous = sky
    }
  })

  it('the Sun inside the starfield and the Moon outside the ground, all year', () => {
    for (let t = Date.parse('2026-01-01T00:00:00Z'); t < Date.parse('2027-01-01T00:00:00Z'); t += 30 * DAY) {
      const { drawn } = drawnSky(torreon.lat, torreon.lon, t)
      expect(drawn.sunDistance).toBeLessThan(DEFAULT_RADIUS)
      expect(drawn.moonDistance).toBeGreaterThan(GROUND_RADIUS)
    }
  })
})
