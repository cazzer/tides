import * as THREE from 'three'
import { describe, expect, test, afterAll } from 'vitest'
import {
  EARTH_AXIAL_TILT,
  earthPosition,
  earthSpin,
} from './ephemeris'
import { applyBodyTransform } from './body-transform'
import { calculateLocationAndRotationForLatLng } from './utils'
import horizons from './__fixtures__/horizons-sun.json'
import usno from './__fixtures__/usno-sun-rise-set.json'

// Reference data comes from the committed fixtures (see
// scripts/fetch-ephemeris-fixtures.mjs); everything compared against it is
// read back from the Earth's scene transform, built with OrbitingBody's code.

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
    { axialTilt: EARTH_AXIAL_TILT, spinAt: earthSpin, positionAt: earthPosition },
    t
  )
  earth.updateMatrixWorld()
  return earth
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
const usnoReport: Record<string, unknown>[] = []
afterAll(() => {
  console.table(horizonsReport)
  console.table(usnoReport)
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

    expect(Math.abs(latError)).toBeLessThan(0.1)
    expect(Math.abs(lonError)).toBeLessThan(0.25)
    expect(Math.abs(eclError)).toBeLessThan(0.05)
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
