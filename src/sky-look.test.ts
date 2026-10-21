import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { SURFACE_FOV, placeSurfaceCamera, surfaceView } from './sky'
import {
  LOOK_MAX_ALTITUDE,
  LOOK_MIN_ALTITUDE,
  clampLook,
  dragLook,
  easeLook,
  type SkyLook,
} from './sky-look'

const DEG = Math.PI / 180

// The observer's true horizon frame at lat/lon, in the Earth's frame (the
// same convention as placeSurfaceCamera: lon 0 on +X, east toward −Z).
function horizonFrame(lat: number, lon: number) {
  const phi = lat * DEG
  const lambda = -lon * DEG
  const zenith = new THREE.Vector3(
    Math.cos(phi) * Math.cos(lambda),
    Math.sin(phi),
    Math.cos(phi) * Math.sin(lambda)
  )
  const north = new THREE.Vector3(
    -Math.sin(phi) * Math.cos(lambda),
    Math.cos(phi),
    -Math.sin(phi) * Math.sin(lambda)
  )
  const east = new THREE.Vector3().crossVectors(north, zenith)
  return { zenith, north, east }
}

function lookingCamera(lat: number, lon: number, look?: SkyLook, aspect = 1) {
  const earth = new THREE.Object3D()
  const observer = new THREE.Object3D()
  const camera = new THREE.PerspectiveCamera(SURFACE_FOV, aspect, 0.01, 1000)
  earth.add(observer)
  observer.add(camera)
  placeSurfaceCamera(observer, camera, lat, lon, 2.95, look)
  earth.updateMatrixWorld()
  return camera
}

function altAz(direction: THREE.Vector3, lat: number, lon: number) {
  const { zenith, north, east } = horizonFrame(lat, lon)
  return {
    altitude: Math.asin(THREE.MathUtils.clamp(direction.dot(zenith), -1, 1)) / DEG,
    azimuth: THREE.MathUtils.euclideanModulo(
      Math.atan2(direction.dot(east), direction.dot(north)) / DEG,
      360
    ),
  }
}

const angleBetween = (a: number, b: number) =>
  Math.abs(THREE.MathUtils.euclideanModulo(a - b + 180, 360) - 180)

describe('looking around View from Earth (tides-2dp)', () => {
  const sites = [
    { lat: -30, lon: 0 },
    { lat: 51.5, lon: -0.1 },
    { lat: 0, lon: 120 },
    { lat: -89.9, lon: 45 },
  ]
  const looks: SkyLook[] = [
    { azimuth: 0, altitude: 0 },
    { azimuth: 90, altitude: 20 },
    { azimuth: 200, altitude: 60 },
    { azimuth: 315, altitude: LOOK_MIN_ALTITUDE },
    { azimuth: 135, altitude: 89 },
  ]

  it('points the camera at the look’s true azimuth and altitude, horizon level', () => {
    for (const { lat, lon } of sites) {
      const { zenith } = horizonFrame(lat, lon)
      for (const look of looks) {
        const camera = lookingCamera(lat, lon, look)
        const forward = camera.getWorldDirection(new THREE.Vector3())
        const seen = altAz(forward, lat, lon)
        expect(seen.altitude).toBeCloseTo(look.altitude, 6)
        expect(angleBetween(seen.azimuth, look.azimuth)).toBeLessThan(1e-6)

        // No roll: the camera's right axis stays horizontal, and up leans to the zenith.
        const right = new THREE.Vector3(1, 0, 0).transformDirection(camera.matrixWorld)
        const up = new THREE.Vector3(0, 1, 0).transformDirection(camera.matrixWorld)
        expect(Math.abs(right.dot(zenith))).toBeLessThan(1e-9)
        expect(up.dot(zenith)).toBeGreaterThan(0)
      }
    }
  })

  it('looks straight up at the zenith, tipped back past the heading', () => {
    for (const { lat, lon } of sites) {
      const { zenith, north, east } = horizonFrame(lat, lon)
      const camera = lookingCamera(lat, lon, { azimuth: 90, altitude: LOOK_MAX_ALTITUDE })
      const forward = camera.getWorldDirection(new THREE.Vector3())
      expect(forward.dot(zenith)).toBeCloseTo(1, 9)
      // Facing east and tipping back, the top of the view points west.
      const up = new THREE.Vector3(0, 1, 0).transformDirection(camera.matrixWorld)
      expect(up.dot(east)).toBeCloseTo(-1, 9)
      expect(Math.abs(up.dot(north))).toBeLessThan(1e-9)
    }
  })

  it('defaults to today’s view, facing the equator', () => {
    for (const { lat, lon } of sites) {
      const byDefault = lookingCamera(lat, lon)
      const explicit = lookingCamera(lat, lon, surfaceView(lat))
      expect(byDefault.matrixWorld.equals(explicit.matrixWorld)).toBe(true)
      const seen = altAz(byDefault.getWorldDirection(new THREE.Vector3()), lat, lon)
      expect(seen.altitude).toBeCloseTo(surfaceView(lat).altitude, 6)
      expect(angleBetween(seen.azimuth, surfaceView(lat).azimuth)).toBeLessThan(1e-6)
    }
  })

  it('wraps the heading and clamps the pitch', () => {
    expect(clampLook({ azimuth: 370, altitude: 10 })).toEqual({ azimuth: 10, altitude: 10 })
    expect(clampLook({ azimuth: -90, altitude: 10 }).azimuth).toBeCloseTo(270, 9)
    expect(clampLook({ azimuth: 0, altitude: 120 }).altitude).toBe(LOOK_MAX_ALTITUDE)
    expect(clampLook({ azimuth: 0, altitude: -40 }).altitude).toBe(LOOK_MIN_ALTITUDE)
    expect(LOOK_MIN_ALTITUDE).toBeLessThan(0)
    expect(LOOK_MIN_ALTITUDE).toBeGreaterThanOrEqual(-10)

    const start = { azimuth: 180, altitude: 30 }
    expect(dragLook(start, 0, 100000, 800).altitude).toBe(LOOK_MAX_ALTITUDE)
    expect(dragLook(start, 0, -100000, 800).altitude).toBe(LOOK_MIN_ALTITUDE)
    // A full turn and a bit comes back round.
    const turned = dragLook({ azimuth: 10, altitude: 0 }, 1000, 0, 800)
    expect(turned.azimuth).toBeGreaterThanOrEqual(0)
    expect(turned.azimuth).toBeLessThan(360)
  })

  it('grabs the sky: the star under the pointer follows it', () => {
    const lat = 40
    const lon = 10
    const panels = [[1280, 800], [390, 844], [195, 200]]
    for (const [[width, height], altitude] of panels.flatMap((p) =>
      [0, surfaceView(lat).altitude, 60].map((a) => [p, a] as const)
    )) {
      const look = { azimuth: 160, altitude }
      const before = lookingCamera(lat, lon, look, width / height)
      // The sky direction at the centre of the panel.
      const star = before.getWorldDirection(new THREE.Vector3()).multiplyScalar(100)
        .add(before.getWorldPosition(new THREE.Vector3()))

      for (const [dx, dy] of [[4, 0], [0, 4], [-3, -3]]) {
        const after = lookingCamera(lat, lon, dragLook(look, dx, dy, height), width / height)
        const p = star.clone().project(after)
        const pixel = { x: (p.x * width) / 2, y: (-p.y * height) / 2 }
        // Within 5% of the step: turning the heading curves a little.
        const slip = Math.hypot(pixel.x - dx, pixel.y - dy) / Math.hypot(dx, dy)
        expect(slip).toBeLessThan(0.05)
      }
    }

    // Near the zenith the sky turns at most as fast as at GRAB_TURN_LIMIT.
    const up = { azimuth: 160, altitude: LOOK_MAX_ALTITUDE }
    expect(angleBetween(dragLook(up, 10, 0, 800).azimuth, 160)).toBeCloseTo(
      angleBetween(dragLook({ azimuth: 160, altitude: 60 }, 10, 0, 800).azimuth, 160),
      9
    )
  })

  it('eases the short way round, from the look to the default', () => {
    const from = { azimuth: 350, altitude: 80 }
    const to = { azimuth: 10, altitude: 38 }
    expect(easeLook(from, to, 0)).toEqual(from)
    const end = easeLook(from, to, 1)
    expect(end.azimuth).toBeCloseTo(10, 9)
    expect(end.altitude).toBeCloseTo(38, 9)
    const middle = easeLook(from, to, 0.5)
    expect(angleBetween(middle.azimuth, 0)).toBeLessThan(1e-9)
    expect(middle.altitude).toBeCloseTo(59, 9)
  })
})
