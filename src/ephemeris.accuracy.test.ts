import * as THREE from 'three'
import { describe, expect, test, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  Body,
  DefineStar,
  Equator,
  Horizon,
  KM_PER_AU,
  Observer,
  SearchAltitude,
} from 'astronomy-engine'
import {
  MOON_UNITS_PER_KM,
  earthPosition,
  earthSpin,
  earthTilt,
  moonPosition,
  moonOrientation,
} from './ephemeris'
import { applyBodyTransform } from './body-transform'
import {
  everydaySkyScale,
  placeSurfaceCamera,
  skyDiscPositionsAt,
  surfaceView,
} from './sky'
import { SKY_SCALE, eclipseMoonDirection, eclipseSkyAt } from './eclipse-sky'
import { sceneRadius } from './planets'
import { calculateLocationAndRotationForLatLng } from './utils'
import {
  DEFAULT_RADIUS,
  centreStarfieldOn,
  orientStarfield,
  starDirectionsEQJ,
} from './renderers/Starfield'
import starsMeta from './assets/stars.meta.json'
import horizons from './__fixtures__/horizons-sun.json'
import horizonsMoon from './__fixtures__/horizons-moon.json'
import usno from './__fixtures__/usno-sun-rise-set.json'

// Reference data comes from the committed fixtures (see
// scripts/fetch-ephemeris-fixtures.mjs); everything compared against it is
// read back from the Earth's and Moon's scene transforms, built with
// OrbitingBody's code. (astronomy-engine is otherwise imported only for a unit
// constant, and as the reference for the sky seen from the surface.)

const DEG = 180 / Math.PI
const MINUTE = 60_000

// USNO's sunrise/sunset: Sun's centre 50′ below the horizon (16′ semidiameter
// plus 34′ refraction).
const USNO_HORIZON = -0.8333

function wrap180(deg: number): number {
  return deg - 360 * Math.round(deg / 360)
}

function earthAt(t: number): THREE.Object3D {
  const earth = new THREE.Object3D()
  applyBodyTransform(
    earth,
    { tiltAt: earthTilt, spinAt: earthSpin, positionAt: earthPosition },
    t
  )
  earth.updateMatrixWorld()
  return earth
}

function moonAt(t: number): THREE.Object3D {
  const moon = new THREE.Object3D()
  applyBodyTransform(
    moon,
    { orientationAt: moonOrientation, positionAt: moonPosition },
    t
  )
  moon.updateMatrixWorld()
  return moon
}

// Inverse of calculateLocationAndRotationForLatLng on a unit sphere.
function toLatLon(v: THREE.Vector3): { lat: number; lon: number } {
  return { lat: Math.asin(v.y) * DEG, lon: Math.atan2(-v.z, v.x) * DEG }
}

function surfaceNormal(lat: number, lon: number): THREE.Vector3 {
  const { position } = calculateLocationAndRotationForLatLng(lat, lon, 1)
  return new THREE.Vector3(position.x, position.y, position.z)
}

// The Sun sits at the scene origin.
function subsolarPoint(t: number) {
  const earth = earthAt(t)
  return toLatLon(earth.worldToLocal(new THREE.Vector3()).normalize())
}

function sunAltitude(t: number, lat: number, lon: number): number {
  const earth = earthAt(t)
  const up = surfaceNormal(lat, lon).applyQuaternion(earth.quaternion)
  const toSun = earth.position.clone().negate().normalize()
  return Math.asin(up.dot(toSun)) * DEG
}

// The rising or setting crossing of `horizon` nearest `near`, to 1 s.
function crossing(
  near: number,
  lat: number,
  lon: number,
  rising: boolean,
  horizon: number
): number | null {
  const above = (t: number) => sunAltitude(t, lat, lon) > horizon
  let best: number | null = null
  for (let start = near - 90 * MINUTE; start < near + 90 * MINUTE; start += MINUTE) {
    let lo = start
    let hi = start + MINUTE
    if (above(lo) !== !rising || above(hi) !== rising) continue
    while (hi - lo > 1000) {
      const mid = (lo + hi) / 2
      if (above(mid) === rising) hi = mid
      else lo = mid
    }
    const t = (lo + hi) / 2
    if (best == null || Math.abs(t - near) < Math.abs(best - near)) best = t
  }
  return best
}

const horizonsReport: Record<string, unknown>[] = []
const moonReport: Record<string, unknown>[] = []
const usnoReport: Record<string, unknown>[] = []
const skyReport: Record<string, unknown>[] = []
afterAll(() => {
  console.table(horizonsReport)
  console.table(moonReport)
  console.table(usnoReport)
  console.table(skyReport)
})

describe('scene geometry vs JPL Horizons', () => {
  test.each(horizons.rows)('$t', (row) => {
    const t = Date.parse(row.t)
    const subsolar = subsolarPoint(t)
    const { x, z } = earthAt(t).position

    const latError = subsolar.lat - row.decDeg
    const lonError = wrap180(subsolar.lon - (row.raDeg - row.gastHours * 15))
    // Earth's scene angle is the Sun's geocentric ecliptic longitude.
    const eclError = wrap180(Math.atan2(-z, x) * DEG - row.eclipticLonDeg)
    horizonsReport.push({
      t: row.t,
      'subsolar lat err°': +latError.toFixed(4),
      'subsolar lon err°': +lonError.toFixed(4),
      'ecliptic lon err°': +eclError.toFixed(4),
    })

    // Measured max 0.0011°, mostly the fixture site's 8.8″ solar parallax;
    // the old fixed J2000 tilt was 0.011° off by 2100.
    expect(Math.abs(latError)).toBeLessThan(0.005)
    expect(Math.abs(lonError)).toBeLessThan(0.25)
    expect(Math.abs(eclError)).toBeLessThan(0.05)
  })
})

describe('scene Moon vs JPL Horizons', () => {
  test.each(horizonsMoon.rows)('$t', (row) => {
    const t = Date.parse(row.t)
    const earth = earthAt(t).position
    const moon = moonAt(t)
    const geocentric = moon.position.clone().sub(earth)
    const range = geocentric.length()

    // Scene angle φ is ecliptic longitude + 180° (see ephemeris.ts).
    const lon = Math.atan2(-geocentric.z, geocentric.x) * DEG + 180
    const lat = Math.asin(geocentric.y / range) * DEG
    const lonError = wrap180(lon - row.eclipticLonDeg)
    const latError = lat - row.eclipticLatDeg
    const rangeError = range / MOON_UNITS_PER_KM / KM_PER_AU / row.rangeAu - 1

    // Phase from the Sun's direction as seen from Earth. The scene's Sun is
    // only 5 Moon-distances away (389 in reality), so the direction from the
    // Moon to the scene origin is up to ~11° off and inflates the fraction by
    // up to 0.10 near the quarters; tides-2e6 lights the Moon along this
    // direction instead.
    const toSun = earth.clone().negate()
    const toEarth = earth.clone().sub(moon.position)
    const phaseAngle = toSun.angleTo(toEarth) * DEG
    const fraction = (1 + Math.cos(phaseAngle / DEG)) / 2
    const fractionError = fraction - row.illuminatedPercent / 100

    // The point on the Moon's texture that faces the Earth.
    const subEarth = toLatLon(moon.worldToLocal(earth.clone()).normalize())
    const subEarthLonError = wrap180(subEarth.lon - row.subEarthLonDeg)
    const subEarthLatError = subEarth.lat - row.subEarthLatDeg

    moonReport.push({
      t: row.t,
      'lon err°': +lonError.toFixed(4),
      'lat err°': +latError.toFixed(4),
      'range err %': +(rangeError * 100).toFixed(3),
      'illum': +fraction.toFixed(4),
      'illum err': +fractionError.toFixed(4),
      'phase err°': +(phaseAngle - row.phaseAngleDeg).toFixed(3),
      'sub-Earth lon°': +subEarth.lon.toFixed(2),
      'sub-Earth lon err°': +subEarthLonError.toFixed(3),
      'sub-Earth lat°': +subEarth.lat.toFixed(2),
      'sub-Earth lat err°': +subEarthLatError.toFixed(3),
    })

    expect(Math.abs(lonError)).toBeLessThan(0.1)
    expect(Math.abs(latError)).toBeLessThan(0.1)
    expect(Math.abs(rangeError)).toBeLessThan(0.001)
    expect(Math.abs(fractionError)).toBeLessThan(0.01)
    // The fraction is flat near new and full moon, so check the angle too.
    expect(Math.abs(phaseAngle - row.phaseAngleDeg)).toBeLessThan(0.3)
    // Libration reaches ~8°; measured max is 0.01°.
    expect(Math.abs(subEarthLonError)).toBeLessThan(0.05)
    expect(Math.abs(subEarthLatError)).toBeLessThan(0.05)
  })
})

describe('scene terminator vs USNO sunrise/sunset', () => {
  test.each(usno.events)('$place $phen $t', (event) => {
    const t = Date.parse(event.t)
    const rising = event.phen === 'Rise'
    const atUsnoHorizon = crossing(t, event.lat, event.lon, rising, USNO_HORIZON)
    // The bare terminator (centre at 0°), for reference only: it runs a few
    // minutes after sunrise and before sunset by definition.
    const atTerminator = crossing(t, event.lat, event.lon, rising, 0)
    expect(atUsnoHorizon).not.toBeNull()

    const error = (atUsnoHorizon! - t) / MINUTE
    usnoReport.push({
      t: event.t,
      place: event.place,
      phen: event.phen,
      'err min (−0.833°)': +error.toFixed(2),
      'err min (0°)':
        atTerminator == null ? null : +((atTerminator - t) / MINUTE).toFixed(2),
    })

    expect(Math.abs(error)).toBeLessThan(2)
  })
})

// The scene Earth's radius (solar-system.tsx); the directions below don't
// depend on it, since the sky bodies are placed relative to the observer.
const EARTH_RADIUS = 2.95
const SKY_RADII = { sun: sceneRadius(1392700000), moon: sceneRadius(3474800) }

// The "View from Earth" camera, inside the observer that OrbitingBody stands
// on the spinning Earth.
function surfaceCameraAt(t: number, lat: number, lon: number): THREE.Object3D {
  const earth = earthAt(t)
  const observer = new THREE.Object3D()
  const camera = new THREE.Object3D()
  placeSurfaceCamera(observer, camera, lat, lon, EARTH_RADIUS)
  earth.add(observer)
  observer.add(camera)
  earth.updateMatrixWorld()
  return camera
}

// Alt/az of a world point, read from the camera's frame by undoing the view's
// azimuth and tilt (surfaceView).
function cameraAltAz(camera: THREE.Object3D, point: THREE.Vector3, lat: number) {
  const d = camera.worldToLocal(point.clone()).normalize()
  const { azimuth, altitude } = surfaceView(lat)
  const h = altitude / DEG
  const ahead = -d.z * Math.cos(h) - d.y * Math.sin(h)
  const upward = -d.z * Math.sin(h) + d.y * Math.cos(h)
  return {
    alt: Math.asin(upward) * DEG,
    az: azimuth + Math.atan2(d.x, ahead) * DEG,
  }
}

const skySites = [
  ...new Map(usno.events.map((e) => [e.place, e])).values(),
  // The view's edge cases: facing south from the equator, and near the poles.
  { place: 'Equator', lat: 0, lon: 30 },
  { place: 'North Pole', lat: 89.9, lon: 0 },
  { place: 'South Pole', lat: -89.9, lon: 0 },
]
const skyTimes = horizonsMoon.rows.map((row) => row.t).filter((t) => t >= '2026')
const skyCases = skySites.flatMap(({ place, lat, lon }) =>
  skyTimes.map((t) => ({ place, lat, lon, t }))
)

describe('View from Earth vs astronomy-engine Horizon()', () => {
  test.each(skyCases)('$place $t', ({ place, lat, lon, t: iso }) => {
    const t = Date.parse(iso)
    const camera = surfaceCameraAt(t, lat, lon)

    // A level horizon: the camera's right axis is horizontal, and its up axis
    // leans toward the zenith (the Earth's centre to the observer).
    const zenith = camera
      .getWorldPosition(new THREE.Vector3())
      .sub(earthAt(t).position)
      .normalize()
    const right = new THREE.Vector3(1, 0, 0).transformDirection(camera.matrixWorld)
    const up = new THREE.Vector3(0, 1, 0).transformDirection(camera.matrixWorld)
    expect(Math.abs(right.dot(zenith))).toBeLessThan(1e-9)
    expect(up.dot(zenith)).toBeGreaterThan(0)

    const site = new Observer(lat, lon, 0)
    const discs = skyDiscPositionsAt(lat, lon, EARTH_RADIUS, SKY_RADII, everydaySkyScale)
    const eye = camera.getWorldPosition(new THREE.Vector3())
    // The Sun is drawn on its true direction. The Moon is turned from its
    // true one by the scaled offset (eclipse-sky.ts), so the discs overlap
    // only when the real ones do: its true direction is checked against
    // Horizon() here, and the drawn one against eclipseMoonDirection.
    const e = eclipseSkyAt(t, lat, lon)
    const trueMoon = e.moon.clone().add(eye)
    const drawnMoon = new THREE.Vector3(...discs.moon(t)).sub(eye).normalize()
    expect(drawnMoon.distanceTo(eclipseMoonDirection(e, SKY_SCALE))).toBeLessThan(1e-9)
    for (const [name, body, point] of [
      ['Sun', Body.Sun, new THREE.Vector3(...discs.sun(t))],
      ['Moon', Body.Moon, trueMoon],
    ] as const) {
      const scene = cameraAltAz(camera, point, lat)
      const { ra, dec } = Equator(body, new Date(t), site, true, true)
      const expected = Horizon(new Date(t), site, ra, dec)
      const altError = scene.alt - expected.altitude
      // Azimuth error as an arc on the sky, so it stays meaningful near the zenith.
      const azError =
        wrap180(scene.az - expected.azimuth) * Math.cos(expected.altitude / DEG)
      skyReport.push({
        t: iso,
        place,
        body: name,
        'alt°': +expected.altitude.toFixed(2),
        'az°': +expected.azimuth.toFixed(2),
        'alt err°': +altError.toFixed(4),
        'az err° (arc)': +azError.toFixed(4),
      })
      // The ticket asks for 0.5°; measured max is 0.006°, and 0.05° still
      // catches a J2000/of-date mix-up (~0.36° by 2026).
      expect(Math.abs(altError)).toBeLessThan(0.05)
      expect(Math.abs(azError)).toBeLessThan(0.05)
    }
  })
})

// The sky Sun is SKY_SCALE times its true size about its true centre, so its
// upper limb clears the horizon (k − 1) × its true radius before the real one.
describe('View from Earth sunrise (tides-zec.8)', () => {
  test.each([
    { place: 'Torreón', lat: 25.54, lon: -103.41, day: '2024-04-08' },
    { place: 'Asturias', lat: 43.3, lon: -5.5, day: '2026-08-12' },
  ])('$place $day: the drawn upper limb leads the real one by (k − 1) × its radius', ({ lat, lon, day }) => {
    const site = new Observer(lat, lon, 0)
    const start = Date.parse(`${day}T00:00:00Z`)
    const radius = eclipseSkyAt(start, lat, lon).sunRadius * DEG
    // SearchAltitude is geometric (no refraction) and for the Sun's centre:
    // the true upper limb is on the horizon here.
    const t = SearchAltitude(Body.Sun, site, +1, new Date(start), 1, -radius)!.date.getTime()
    const trueRadius = eclipseSkyAt(t, lat, lon).sunRadius * DEG
    const camera = surfaceCameraAt(t, lat, lon)
    const eye = camera.getWorldPosition(new THREE.Vector3())
    const sun = new THREE.Vector3(
      ...skyDiscPositionsAt(lat, lon, EARTH_RADIUS, SKY_RADII, everydaySkyScale).sun(t)
    )
    const drawnRadius = Math.asin(SKY_RADII.sun / sun.distanceTo(eye)) * DEG
    const upperLimb = cameraAltAz(camera, sun, lat).alt + drawnRadius
    expect(Math.abs(upperLimb - (SKY_SCALE - 1) * trueRadius)).toBeLessThan(0.05)
  })
})

// J2000 positions from the catalog (src/assets/ybsc5, HR 424 and HR 2491).
const brightStars = [
  { name: 'Polaris', ra: 2 + 31 / 60 + 48.7 / 3600, dec: 89 + 15 / 60 + 51 / 3600, vmag: 2.02 },
  { name: 'Sirius', ra: 6 + 45 / 60 + 8.9 / 3600, dec: -(16 + 42 / 60 + 58 / 3600), vmag: -1.46 },
]

const starData = new Float32Array(
  readFileSync(new URL('./assets/stars.bin', import.meta.url)).buffer.slice(0)
)
const starDirections = starDirectionsEQJ(starData, starsMeta.stride)

// The Starfield vertex for a catalog star: the one of its magnitude nearest
// its position.
function starVertex({ ra, dec, vmag }: (typeof brightStars)[number]) {
  const a = (ra * 15) / DEG
  const d = dec / DEG
  const target = new THREE.Vector3(
    Math.cos(d) * Math.cos(a),
    Math.cos(d) * Math.sin(a),
    Math.sin(d)
  )
  let best = new THREE.Vector3()
  let bestDot = -Infinity
  for (let i = 0; i < starDirections.length / 3; i++) {
    if (Math.abs(starData[i * starsMeta.stride + 6] - vmag) > 0.005) continue
    const v = new THREE.Vector3().fromArray(starDirections, i * 3)
    if (v.dot(target) > bestDot) {
      bestDot = v.dot(target)
      best = v
    }
  }
  return best
}

describe('View from Earth stars vs astronomy-engine Horizon()', () => {
  test.each(skyCases)('$place $t', ({ place, lat, lon, t: iso }) => {
    const t = Date.parse(iso)
    const camera = surfaceCameraAt(t, lat, lon)

    // The Starfield's transform when that camera draws it.
    const scene = new THREE.Object3D()
    const stars = new THREE.Object3D()
    scene.add(stars)
    stars.scale.setScalar(DEFAULT_RADIUS)
    orientStarfield(stars, t)
    centreStarfieldOn(stars, camera)

    const site = new Observer(lat, lon, 0)
    for (const star of brightStars) {
      const point = starVertex(star).applyMatrix4(stars.matrixWorld)
      const rendered = cameraAltAz(camera, point, lat)
      DefineStar(Body.Star1, star.ra, star.dec, 1000)
      const { ra, dec } = Equator(Body.Star1, new Date(t), site, true, true)
      const expected = Horizon(new Date(t), site, ra, dec)
      const altError = rendered.alt - expected.altitude
      const azError =
        wrap180(rendered.az - expected.azimuth) * Math.cos(expected.altitude / DEG)
      skyReport.push({
        t: iso,
        place,
        body: star.name,
        'alt°': +expected.altitude.toFixed(2),
        'az°': +expected.azimuth.toFixed(2),
        'alt err°': +altError.toFixed(4),
        'az err° (arc)': +azError.toFixed(4),
      })
      expect(Math.abs(altError)).toBeLessThan(0.1)
      expect(Math.abs(azError)).toBeLessThan(0.1)
    }
  })
})

test('location math matches the Earth texture mapping', () => {
  // SphereGeometry's equirectangular UVs: u = 0.5 is 0°E, v = 1 is the pole.
  const sphere = new THREE.SphereGeometry(1, 24, 12)
  const position = sphere.getAttribute('position')
  const uv = sphere.getAttribute('uv')
  for (let i = 0; i < position.count; i++) {
    const lat = (uv.getY(i) - 0.5) * 180
    if (Math.abs(lat) > 89) continue
    const lon = uv.getX(i) * 360 - 180
    const expected = surfaceNormal(lat, lon)
    const actual = new THREE.Vector3().fromBufferAttribute(position, i)
    // Float32 vertex positions.
    expect(actual.distanceTo(expected)).toBeLessThan(1e-6)
  }
})
