// The tides-b5i accuracy check: every body's scene position and orientation,
// read back from the transforms OrbitingBody applies, against JPL Horizons at
// twelve epochs from 1900 to 2100 (scripts/fetch-orbitcheck-fixtures.mjs).
// `ORBIT_REPORT=1 npx vitest run src/orbit-accuracy.test.ts` also rewrites the
// tables in reports/orbit-accuracy.md.
import * as THREE from 'three'
import { afterAll, describe, expect, test } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import {
  EARTH_ORBIT_RADIUS,
  MOON_UNITS_PER_KM,
  earthPosition,
  earthSpin,
  earthTilt,
  moonOrientation,
  moonPosition,
  sunOrientation,
} from './ephemeris'
import { applyBodyTransform, type BodyMotion } from './body-transform'
import {
  PLANETS,
  PLANET_KEYS,
  bodyOrientation,
  planetPosition,
  sceneDistance,
  type PlanetKey,
} from './planets'
import fixture from './__fixtures__/horizons-orbitcheck.json'

const DEG = 180 / Math.PI
const MINUTE = 60_000
const KM_PER_AU = 149_597_870.7

type BodyKey = 'earth' | 'sun' | 'moon' | PlanetKey
type Fixture = typeof fixture
type BodyFixture = Fixture['bodies'][keyof Fixture['bodies']]

function wrap180(deg: number): number {
  return deg - 360 * Math.round(deg / 360)
}

function wrap360(deg: number): number {
  return deg - 360 * Math.floor(deg / 360)
}

// The props solar-system.tsx and PlanetBodies.tsx give each OrbitingBody.
const MOTION: Record<BodyKey, BodyMotion> = {
  earth: { tiltAt: earthTilt, spinAt: earthSpin, positionAt: earthPosition },
  sun: { orientationAt: sunOrientation },
  moon: { orientationAt: moonOrientation, positionAt: moonPosition },
  ...(Object.fromEntries(
    PLANET_KEYS.map((key) => [
      key,
      {
        positionAt: planetPosition(PLANETS[key].body),
        orientationAt: bodyOrientation(PLANETS[key].body),
      },
    ])
  ) as Record<PlanetKey, BodyMotion>),
}

function bodyAt(key: BodyKey, t: number): THREE.Object3D {
  const object = new THREE.Object3D()
  applyBodyTransform(object, MOTION[key], t)
  object.updateMatrixWorld()
  return object
}

// Scene axes ↔ ecliptic of date: φ = atan2(−z, x) = λ + 180°, +Y north.
function eclipticOf(v: THREE.Vector3) {
  return {
    lon: wrap360(Math.atan2(-v.z, v.x) * DEG + 180),
    lat: Math.asin(v.y / v.length()) * DEG,
  }
}

function sceneDirection(lonDeg: number, latDeg: number): THREE.Vector3 {
  const l = lonDeg / DEG
  const b = latDeg / DEG
  return new THREE.Vector3(-Math.cos(b) * Math.cos(l), Math.sin(b), Math.cos(b) * Math.sin(l))
}

// Local +Y is the pole, +X 0° longitude and −Z east (the texture mapping).
function bodyLatLon(body: THREE.Object3D, worldDirection: THREE.Vector3) {
  const d = worldDirection
    .clone()
    .applyQuaternion(body.quaternion.clone().invert())
    .normalize()
  return { lat: Math.asin(d.y) * DEG, lon: wrap360(Math.atan2(-d.z, d.x) * DEG) }
}

function poleOf(body: THREE.Object3D): THREE.Vector3 {
  return new THREE.Vector3(0, 1, 0).applyQuaternion(body.quaternion)
}

// Horizons' sub-points are planetodetic, in the body's own longitude sense;
// the scene's spheres are planetocentric and east-positive.
function horizonsSubPoint(body: BodyFixture, lon: number, lat: number) {
  const [a, , c] = body.radiiKm
  return {
    lon: wrap360(body.longitude === 'west' ? -lon : lon),
    lat: Math.atan((c / a) ** 2 * Math.tan(lat / DEG)) * DEG,
  }
}

// Position angle of `pole` on the sky seen along `sightline`, from celestial
// north `north` through east.
function positionAngle(pole: THREE.Vector3, sightline: THREE.Vector3, north: THREE.Vector3) {
  const d = sightline.clone().normalize()
  const n = north.clone().addScaledVector(d, -north.dot(d)).normalize()
  const e = north.clone().cross(d).normalize()
  return wrap360(Math.atan2(pole.dot(e), pole.dot(n)) * DEG)
}

function inverseSceneDistance(units: number): number {
  let lo = 0
  let hi = 100
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (sceneDistance(mid) < units) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

const centuries = (t: number) => (t - Date.UTC(2000, 0, 1, 12)) / (36525 * 86_400_000)

// Nutation in longitude and obliquity, degrees: the four largest IAU 1980
// terms (Meeus, Astronomical Algorithms ch. 22; good to 0.5″ and 0.1″).
function nutation(t: number) {
  const T = centuries(t)
  const omega = (125.04452 - 1934.136261 * T) / DEG
  const sun = (280.4665 + 36000.7698 * T) / DEG
  const moon = (218.3165 + 481267.8813 * T) / DEG
  return {
    psi:
      (-17.2 * Math.sin(omega) - 1.32 * Math.sin(2 * sun) -
        0.23 * Math.sin(2 * moon) + 0.21 * Math.sin(2 * omega)) / 3600,
    eps:
      (9.2 * Math.cos(omega) + 0.57 * Math.cos(2 * sun) +
        0.1 * Math.cos(2 * moon) - 0.09 * Math.cos(2 * omega)) / 3600,
  }
}

// IAU 2006 mean obliquity (Capitaine et al. 2003) plus nutation.
function trueObliquity(t: number): number {
  const T = centuries(t)
  const arcsec =
    84381.406 - 46.836769 * T - 0.0001831 * T ** 2 + 0.0020034 * T ** 3
  return arcsec / 3600 + nutation(t).eps
}

// J2000 ecliptic → true ecliptic and equinox of date: IAU 1976 (Lieske)
// precession of the ecliptic (Meeus eq. 21.5) plus nutation in longitude.
function eclipticOfDate(lonJ2000: number, latJ2000: number, t: number) {
  const T = centuries(t)
  const eta = (47.0029 * T - 0.03302 * T ** 2 + 0.00006 * T ** 3) / 3600 / DEG
  const node = (174.876384 - (869.8089 * T - 0.03536 * T ** 2) / 3600) / DEG
  const p = (5029.0966 * T + 1.11113 * T ** 2 - 0.000006 * T ** 3) / 3600 / DEG
  const l0 = lonJ2000 / DEG
  const b0 = latJ2000 / DEG
  const A = Math.cos(eta) * Math.cos(b0) * Math.sin(node - l0) - Math.sin(eta) * Math.sin(b0)
  const B = Math.cos(b0) * Math.cos(node - l0)
  const C = Math.cos(eta) * Math.sin(b0) + Math.sin(eta) * Math.cos(b0) * Math.sin(node - l0)
  return {
    lon: wrap360((p + node - Math.atan2(A, B)) * DEG + nutation(t).psi),
    lat: Math.asin(C) * DEG,
  }
}

interface Row {
  body: BodyKey
  epoch: string
  quantity: string
  expected: number
  actual: number
  delta: number
  unit: string
}
const rows: Row[] = []

function record(
  body: BodyKey,
  epoch: string,
  quantity: string,
  expected: number,
  actual: number,
  unit: string,
  angle = unit === '°'
) {
  const delta = angle ? wrap180(actual - expected) : actual - expected
  rows.push({ body, epoch, quantity, expected, actual, delta, unit })
  return delta
}

const epochs = fixture.epochs.map((e, i) => ({ ...e, i, ms: Date.parse(e.t) }))

describe('Earth vs Horizons', () => {
  test.each(epochs)('$label', ({ label, i, ms }) => {
    const ref = fixture.earth[i]
    const earth = bodyAt('earth', ms)
    const toSun = earth.position.clone().negate()

    const sun = eclipticOf(toSun)
    const lonError = record('earth', label, 'Sun geocentric λ', ref.sunEclipticLonDeg, sun.lon, '°')
    // The Earth rides a circle of 1 AU (by design).
    record('earth', label, 'Sun distance', ref.sunRangeAu, toSun.length() / EARTH_ORBIT_RADIUS, 'AU')

    const subsolar = bodyLatLon(earth, toSun)
    const latError = record('earth', label, 'sub-solar latitude', ref.decDeg, subsolar.lat, '°')
    const subLonError = record(
      'earth', label, 'sub-solar longitude',
      wrap360(ref.raDeg - ref.gastHours * 15), subsolar.lon, '°'
    )

    // GAST read off the globe: the right ascension of its 0° meridian,
    // measured from the equinox where its equator crosses the ecliptic.
    const pole = poleOf(earth)
    const equinox = pole.clone().cross(new THREE.Vector3(0, 1, 0)).normalize()
    const ra90 = pole.clone().cross(equinox)
    const greenwich = new THREE.Vector3(1, 0, 0).applyQuaternion(earth.quaternion)
    const gast = wrap360(Math.atan2(greenwich.dot(ra90), greenwich.dot(equinox)) * DEG)
    const gastError = record('earth', label, 'GAST', wrap360(ref.gastHours * 15), gast, '°')

    const obliquity = pole.angleTo(new THREE.Vector3(0, 1, 0)) * DEG
    const tiltError = record('earth', label, 'obliquity of date', trueObliquity(ms), obliquity, '°')

    expect(Math.abs(lonError)).toBeLessThan(0.005)
    expect(Math.abs(latError)).toBeLessThan(0.002)
    expect(Math.abs(subLonError)).toBeLessThan(0.005)
    expect(Math.abs(gastError)).toBeLessThan(0.005)
    expect(Math.abs(tiltError)).toBeLessThan(0.001)
  })
})

// Orientation from the geocentre: the sub-Earth point and the pole's position
// angle, taking the body's rotation one light time back (Horizons'
// apparent quantities) and the true sightline (the scene's compressed
// distances bend it).
function geocentricOrientation(key: BodyKey, label: string, i: number, ms: number) {
  const ref = fixture.bodies[key as keyof Fixture['bodies']]
  const geo = ref.geocentric[i]
  const body = bodyAt(key, ms - geo.lightTimeMin * MINUTE)
  const sightline = sceneDirection(geo.eclipticLonDeg, geo.eclipticLatDeg)
  const expected = horizonsSubPoint(ref, geo.subLonDeg, geo.subLatDeg)
  const actual = bodyLatLon(body, sightline.clone().negate())
  const celestialNorth = poleOf(bodyAt('earth', ms))
  return {
    lon: record(key, label, 'sub-Earth longitude', expected.lon, actual.lon, '°'),
    lat: record(key, label, 'sub-Earth latitude', expected.lat, actual.lat, '°'),
    pa: record(
      key, label, 'pole position angle', geo.northPoleAngleDeg,
      positionAngle(poleOf(body), sightline, celestialNorth), '°'
    ),
  }
}

describe('Moon vs Horizons', () => {
  test.each(epochs)('$label', ({ label, i, ms }) => {
    const geo = fixture.bodies.moon.geocentric[i]
    const t = ms - geo.lightTimeMin * MINUTE
    const geocentric = bodyAt('moon', t).position.clone().sub(bodyAt('earth', t).position)
    const { lon, lat } = eclipticOf(geocentric)
    const errors = [
      record('moon', label, 'geocentric λ', geo.eclipticLonDeg, lon, '°'),
      record('moon', label, 'geocentric β', geo.eclipticLatDeg, lat, '°'),
    ]
    const rangeError = record(
      'moon', label, 'distance', geo.rangeAu * KM_PER_AU,
      geocentric.length() / MOON_UNITS_PER_KM, 'km'
    )
    const orientation = geocentricOrientation('moon', label, i, ms)

    for (const e of errors) expect(Math.abs(e)).toBeLessThan(0.01)
    expect(Math.abs(rangeError)).toBeLessThan(80)
    expect(Math.abs(orientation.lon)).toBeLessThan(0.02)
    expect(Math.abs(orientation.lat)).toBeLessThan(0.02)
    expect(Math.abs(orientation.pa)).toBeLessThan(0.02)
  })
})

describe('Sun vs Horizons', () => {
  test.each(epochs)('$label', ({ label, i, ms }) => {
    const orientation = geocentricOrientation('sun', label, i, ms)
    expect(Math.abs(orientation.lon)).toBeLessThan(0.02)
    expect(Math.abs(orientation.lat)).toBeLessThan(0.02)
    expect(Math.abs(orientation.pa)).toBeLessThan(0.002)
  })
})

describe.each(PLANET_KEYS)('%s vs Horizons', (key) => {
  test.each(epochs)('$label', ({ label, i, ms }) => {
    const ref = fixture.bodies[key]
    const geo = ref.geocentric[i]
    // Horizons' heliocentric position is where the planet was when the light
    // seen at the geocentre left it.
    const planet = bodyAt(key, ms - geo.lightTimeMin * MINUTE)
    const { lon, lat } = eclipticOf(planet.position)
    const helio = eclipticOfDate(geo.helioLonJ2000Deg, geo.helioLatJ2000Deg, ms)
    const errors = [
      record(key, label, 'heliocentric λ', helio.lon, lon, '°'),
      record(key, label, 'heliocentric β', helio.lat, lat, '°'),
    ]
    // Scene distances are compressed; this undoes sceneDistance.
    const rError = record(
      key, label, 'heliocentric r', geo.helioRangeAu,
      inverseSceneDistance(planet.position.length()), 'AU'
    )
    // The sub-solar point as seen from the Sun's centre, one light time back.
    const fromSun = ref.fromSun[i]
    const lit = bodyAt(key, ms - fromSun.lightTimeMin * MINUTE)
    const expected = horizonsSubPoint(ref, fromSun.subLonDeg, fromSun.subLatDeg)
    const actual = bodyLatLon(lit, lit.position.clone().negate())
    errors.push(
      record(key, label, 'sub-solar longitude', expected.lon, actual.lon, '°'),
      record(key, label, 'sub-solar latitude', expected.lat, actual.lat, '°')
    )
    const orientation = geocentricOrientation(key, label, i, ms)

    // The geocentric direction as drawn, for the report: compressed
    // distances bend it by design.
    const drawn = bodyAt(key, ms).position.sub(bodyAt('earth', ms).position)
    const drawnDir = eclipticOf(drawn)
    record(key, label, 'geocentric λ as drawn', geo.eclipticLonDeg, drawnDir.lon, '°')

    for (const e of errors) expect(Math.abs(e)).toBeLessThan(0.02)
    expect(Math.abs(rError / geo.helioRangeAu)).toBeLessThan(1e-4)
    // Uranus's IAU rotation is the loosest, 0.03° off by 1900.
    expect(Math.abs(orientation.lon)).toBeLessThan(0.05)
    expect(Math.abs(orientation.lat)).toBeLessThan(0.01)
    expect(Math.abs(orientation.pa)).toBeLessThan(0.002)
  })
})

const REPORT = new URL('../reports/orbit-accuracy.md', import.meta.url)
const START = '<!-- orbit-accuracy:tables:start -->'
const END = '<!-- orbit-accuracy:tables:end -->'

function fmt(value: number, unit: string): string {
  if (unit === 'km') return value.toFixed(1)
  if (unit === 'AU') return value.toFixed(6)
  return value.toFixed(4)
}

function tables(): string {
  const bodies = [...new Set(rows.map((r) => r.body))]
  const out: string[] = []
  out.push('### Worst case per quantity\n')
  out.push('| Body | Quantity | max \\|Δ\\| | RMS Δ | Unit | Worst epoch |')
  out.push('|---|---|---:|---:|---|---|')
  for (const body of bodies) {
    const mine = rows.filter((r) => r.body === body)
    for (const quantity of [...new Set(mine.map((r) => r.quantity))]) {
      const q = mine.filter((r) => r.quantity === quantity)
      const worst = q.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a))
      const rms = Math.sqrt(q.reduce((s, r) => s + r.delta ** 2, 0) / q.length)
      out.push(
        `| ${body} | ${quantity} | ${fmt(Math.abs(worst.delta), worst.unit)} | ` +
          `${fmt(rms, worst.unit)} | ${worst.unit} | ${worst.epoch} |`
      )
    }
  }
  for (const body of bodies) {
    out.push(`\n### ${body[0].toUpperCase()}${body.slice(1)}\n`)
    out.push('<details><summary>Every epoch</summary>\n')
    out.push('| Epoch | Quantity | Expected | Actual | Δ | Unit |')
    out.push('|---|---|---:|---:|---:|---|')
    for (const r of rows.filter((r) => r.body === body)) {
      out.push(
        `| ${r.epoch} | ${r.quantity} | ${fmt(r.expected, r.unit)} | ` +
          `${fmt(r.actual, r.unit)} | ${fmt(r.delta, r.unit)} | ${r.unit} |`
      )
    }
    out.push('\n</details>')
  }
  return out.join('\n')
}

afterAll(() => {
  if (!process.env.ORBIT_REPORT) return
  const report = readFileSync(REPORT, 'utf8')
  const head = report.slice(0, report.indexOf(START) + START.length)
  const tail = report.slice(report.indexOf(END))
  writeFileSync(REPORT, `${head}\n${tables()}\n${tail}`)
})
