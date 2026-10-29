import * as THREE from 'three'
import { describe, expect, test } from 'vitest'
import { applyBodyTransform } from '../body-transform'
import {
  createEclipseShading,
  shadingAt,
  surfacePoint,
  updateEclipseShading,
} from '../eclipse'
import { earthSpin, earthTilt } from '../ephemeris'
import {
  DEPARTURE_MS,
  LANDFALL_MS,
  TRAIL_ROWS,
  centrelineSamples,
  latOf,
  lonOf,
  trailTable,
  umbraCentreline,
} from './totality-path'

const DEG = Math.PI / 180
const at = (hhmm: string) => Date.parse(`2024-04-08T${hhmm}Z`)

// The axis's ground point, worked independently: the axis turned into the
// true equator of date, met with the WGS84 ellipsoid there and read with
// astronomy-engine's VectorObserver (geodetic). The app's own ΔT and frames put
// it ~0.06° west mid-path, more where the axis grazes the limb near the ends.
const CENTRELINE: [string, number, number][] = [
  ['16:41', -6.52, -151.04],
  ['16:45', -4.24, -142.71],
  ['17:00', 1.71, -129.7],
  ['17:30', 11.44, -117.22],
  ['18:00', 20.32, -108.77],
  ['18:20', 26.06, -103.4],
  ['18:40', 31.72, -97.38],
  ['19:00', 37.33, -89.79],
  ['19:20', 42.8, -79.0],
  ['19:40', 47.67, -60.76],
  ['19:46', 48.73, -51.73],
  ['19:50', 49.11, -43.24],
  ['19:52', 49.07, -37.29],
]

// The table's latitude at a longitude, as the shader reads it.
function tableAt(lonRad: number): { lat: number; seconds: number } {
  const { rows, lon0, dLon } = trailTable()
  const f = (lonRad - lon0) / dLon
  const i = Math.min(Math.floor(f), TRAIL_ROWS - 2)
  const k = f - i
  return {
    lat: rows[i * 4] + k * (rows[i * 4 + 4] - rows[i * 4]),
    seconds: rows[i * 4 + 1] + k * (rows[i * 4 + 5] - rows[i * 4 + 1]),
  }
}

describe('the umbra’s centreline', () => {
  test.each(CENTRELINE)('at %s it is over %f, %f', (hhmm, lat, lon) => {
    const p = umbraCentreline(at(hhmm))!
    const end = hhmm < '17:00' || hhmm >= '19:40'
    const tol = end ? 0.5 : 0.15
    expect(Math.abs(latOf(p) / DEG - lat)).toBeLessThan(tol)
    expect(Math.abs(lonOf(p) / DEG - lon)).toBeLessThan(tol)
    // And the table puts the trail there.
    const row = tableAt(lonOf(p))
    expect(Math.abs(row.lat / DEG - lat)).toBeLessThan(tol)
    expect(Math.abs(LANDFALL_MS + row.seconds * 1000 - at(hhmm))).toBeLessThan(end ? 10_000 : 5_000)
  })

  test('is off Earth before landfall and after the umbra leaves', () => {
    expect(umbraCentreline(LANDFALL_MS - 1000)).toBeNull()
    // The axis lands a little after the umbra's edge.
    expect(umbraCentreline(LANDFALL_MS + 60_000)).toBeNull()
    expect(umbraCentreline(LANDFALL_MS + 80_000)).not.toBeNull()
    expect(umbraCentreline(DEPARTURE_MS + 1000)).toBeNull()
    expect(umbraCentreline(at('12:00'))).toBeNull()
  })

  test('lies in the app’s own total eclipse, under the shadow dot', () => {
    const earth = createEclipseShading('earth')
    const body = new THREE.Object3D()
    for (const hhmm of ['16:45', '17:30', '18:17', '19:00', '19:40', '19:50']) {
      const t = at(hhmm)
      applyBodyTransform(body, { tiltAt: earthTilt, spinAt: earthSpin }, t)
      updateEclipseShading(earth, 'earth', t)
      const local = umbraCentreline(t)!
      expect(shadingAt(earth, surfacePoint(earth, local, body.quaternion))).toBe(0)
    }
  })
})

describe('the trail table', () => {
  const samples = centrelineSamples()

  test('runs steadily east', () => {
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].lon).toBeGreaterThan(samples[i - 1].lon)
      expect(samples[i].t).toBeGreaterThan(samples[i - 1].t)
    }
    const { rows, lon0, dLon } = trailTable()
    expect(lon0 / DEG).toBeGreaterThan(-165)
    expect(lon0 / DEG).toBeLessThan(-155)
    // Out over the Atlantic, the axis grazing the limb as it leaves.
    expect((lon0 + (TRAIL_ROWS - 1) * dLon) / DEG).toBeGreaterThan(-25)
    expect((lon0 + (TRAIL_ROWS - 1) * dLon) / DEG).toBeLessThan(-15)
    for (let i = 1; i < TRAIL_ROWS; i++) expect(rows[i * 4 + 1]).toBeGreaterThan(rows[i * 4 - 3])
    expect(rows[1]).toBeGreaterThanOrEqual(0)
    expect(rows[(TRAIL_ROWS - 1) * 4 + 1]).toBeLessThanOrEqual((DEPARTURE_MS - LANDFALL_MS) / 1000)
    for (let i = 0; i < TRAIL_ROWS; i++) {
      expect(rows[i * 4 + 2]).toBeGreaterThan(0)
      expect(rows[i * 4 + 2]).toBeLessThanOrEqual(1)
    }
  })

  test('keeps to the dense centreline between its rows', () => {
    let worst = 0
    for (const s of samples) worst = Math.max(worst, Math.abs(tableAt(s.lon).lat - s.lat))
    expect(worst / DEG).toBeLessThan(0.05)
  })
})
