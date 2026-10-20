import * as THREE from 'three'
import { scaleLog } from 'd3'
import { Body, Illumination } from 'astronomy-engine'
import { describe, expect, test, afterAll } from 'vitest'
import {
  earthPosition,
  earthSpin,
  earthTilt,
  moonPosition,
} from './ephemeris'
import { applyBodyTransform } from './body-transform'
import { calculateLocationAndRotationForLatLng } from './utils'
import { aimSunlight, createSunlight } from './sunlight'
import usno from './__fixtures__/usno-sun-rise-set.json'

// The terminators here come from the light the scene actually renders with,
// read back the way three.js's WebGLLights does, so a light that only points
// roughly at the Earth (e.g. a point light at the Sun) fails.

const DEG = 180 / Math.PI
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

// USNO's sunrise/sunset: Sun's centre 50′ below the horizon. This checks the
// light's direction; the drawn terminator (0°) passes a few minutes earlier
// at sunset and later at sunrise, as it does in reality.
const USNO_HORIZON = -0.8333

// solar-system.tsx's sphere radius for the Earth.
const EARTH_RADIUS = scaleLog().domain([3474800, 1392700000]).range([1, 10])(
  12742000
)

function sunlightAt(t: number): THREE.DirectionalLight {
  const light = createSunlight()
  aimSunlight(light, t)
  light.updateMatrixWorld()
  light.target.updateMatrixWorld()
  return light
}

// Unit vector from a lit point toward the light, as the shader sees it.
function toLight(light: THREE.Light, point: THREE.Vector3): THREE.Vector3 {
  const from = new THREE.Vector3().setFromMatrixPosition(light.matrixWorld)
  if (light instanceof THREE.DirectionalLight) {
    const to = new THREE.Vector3().setFromMatrixPosition(
      light.target.matrixWorld
    )
    return from.sub(to).normalize()
  }
  if (light instanceof THREE.PointLight) return from.sub(point).normalize()
  throw new Error(`unhandled light ${light.type}`)
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

function sunAltitude(t: number, lat: number, lon: number): number {
  const earth = earthAt(t)
  const { position } = calculateLocationAndRotationForLatLng(lat, lon, 1)
  const up = new THREE.Vector3(position.x, position.y, position.z)
    .normalize()
    .applyQuaternion(earth.quaternion)
  const ground = up.clone().multiplyScalar(EARTH_RADIUS).add(earth.position)
  return Math.asin(up.dot(toLight(sunlightAt(t), ground))) * DEG
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

// Seen from the Earth's centre, where the Moon Phase camera sits.
function moonLitFraction(t: number): number {
  const moon = new THREE.Vector3(...moonPosition(t))
  const toEarth = new THREE.Vector3(...earthPosition(t)).sub(moon).normalize()
  return (1 + toLight(sunlightAt(t), moon).dot(toEarth)) / 2
}

const sunsetReport: Record<string, unknown>[] = []
const moonReport: Record<string, unknown>[] = []
afterAll(() => {
  console.table(sunsetReport)
  console.table(moonReport)
})

describe('sunlight terminator vs USNO sunrise/sunset', () => {
  test.each(usno.events)('$place $phen $t', (event) => {
    const t = Date.parse(event.t)
    const found = crossing(t, event.lat, event.lon, event.phen === 'Rise', USNO_HORIZON)
    expect(found).not.toBeNull()

    const error = (found! - t) / MINUTE
    sunsetReport.push({
      t: event.t,
      place: event.place,
      phen: event.phen,
      'err min': +error.toFixed(2),
    })
    expect(Math.abs(error)).toBeLessThan(2)
  })
})

describe('sunlit fraction of the Moon vs astronomy-engine', () => {
  const start = Date.parse('2026-10-01T00:00:00Z')
  const times = Array.from({ length: 30 }, (_, i) => start + i * DAY + i * 37 * MINUTE)

  test.each(times)('%d', (t) => {
    const expected = Illumination(Body.Moon, new Date(t)).phase_fraction
    const actual = moonLitFraction(t)
    moonReport.push({
      t: new Date(t).toISOString(),
      scene: +actual.toFixed(4),
      'astronomy-engine': +expected.toFixed(4),
      err: +(actual - expected).toFixed(4),
    })
    expect(Math.abs(actual - expected)).toBeLessThan(0.005)
  })
})
