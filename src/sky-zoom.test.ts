import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { SURFACE_FOV, placeSurfaceCamera } from './sky'
import type { SkyLook } from './sky-look'
import {
  SKY_FOV_MAX,
  SKY_FOV_MIN,
  approachFov,
  clampFov,
  directionAt,
  easeFov,
  lookKeeping,
  pinchFov,
  wheelFov,
} from './sky-zoom'

const DEG = Math.PI / 180
const tanHalf = (fov: number) => Math.tan((fov / 2) * DEG)
const angleBetween = (a: number, b: number) =>
  Math.abs(THREE.MathUtils.euclideanModulo(a - b + 180, 360) - 180)

// The panel camera as OrbitingBody places it, with the given fov.
function lookingCamera(lat: number, look: SkyLook, fov: number, aspect: number) {
  const earth = new THREE.Object3D()
  const observer = new THREE.Object3D()
  const camera = new THREE.PerspectiveCamera(fov, aspect, 0.01, 1000)
  earth.add(observer)
  observer.add(camera)
  placeSurfaceCamera(observer, camera, lat, 0, 2.95, look)
  earth.updateMatrixWorld()
  return camera
}

// Alt/az of a world direction for an observer at lat, lon 0.
function altAz(direction: THREE.Vector3, lat: number) {
  const phi = lat * DEG
  const zenith = new THREE.Vector3(Math.cos(phi), Math.sin(phi), 0)
  const north = new THREE.Vector3(-Math.sin(phi), Math.cos(phi), 0)
  const east = new THREE.Vector3().crossVectors(north, zenith)
  return {
    altitude: Math.asin(THREE.MathUtils.clamp(direction.dot(zenith), -1, 1)) / DEG,
    azimuth: THREE.MathUtils.euclideanModulo(
      Math.atan2(direction.dot(east), direction.dot(north)) / DEG,
      360
    ),
  }
}

// What the camera actually shows at a pixel offset from the panel's centre.
function seenAt(camera: THREE.PerspectiveCamera, dx: number, dy: number, width: number, height: number) {
  const ndc = new THREE.Vector3((2 * dx) / width, (-2 * dy) / height, 0.5)
  const eye = camera.getWorldPosition(new THREE.Vector3())
  return ndc.unproject(camera).sub(eye).normalize()
}

describe('zooming View from Earth (tides-2j7)', () => {
  it('zooms between the default 90° and SKY_FOV_MIN', () => {
    expect(SKY_FOV_MAX).toBe(SURFACE_FOV)
    expect(SKY_FOV_MIN).toBeGreaterThanOrEqual(20)
    expect(SKY_FOV_MIN).toBeLessThanOrEqual(25)
    expect(clampFov(5)).toBe(SKY_FOV_MIN)
    expect(clampFov(120)).toBe(SKY_FOV_MAX)
    expect(clampFov(45)).toBe(45)
  })

  it('scales the sky with the fingers’ spread', () => {
    // Twice the spread, twice the image scale.
    expect(tanHalf(pinchFov(90, 100, 200))).toBeCloseTo(tanHalf(90) / 2, 9)
    expect(tanHalf(pinchFov(40, 300, 200))).toBeCloseTo(tanHalf(40) * 1.5, 9)
    expect(pinchFov(60, 100, 100)).toBeCloseTo(60, 9)
    expect(pinchFov(90, 100, 10000)).toBe(SKY_FOV_MIN)
    expect(pinchFov(30, 100, 1)).toBe(SKY_FOV_MAX)
    expect(pinchFov(60, 100, 0)).toBe(60)
  })

  it('steps gently on the wheel, faster on a trackpad pinch', () => {
    // A mouse notch zooms in about 15%; scrolling back undoes it.
    const notch = wheelFov(90, -100, 0, false)
    expect(tanHalf(90) / tanHalf(notch)).toBeCloseTo(2 ** 0.2, 9)
    expect(wheelFov(notch, 100, 0, false)).toBeCloseTo(90, 9)
    expect(tanHalf(90) / tanHalf(wheelFov(90, -10, 0, true))).toBeCloseTo(2 ** 0.2, 9)
    // Firefox reports lines.
    expect(wheelFov(90, -4, 1, false)).toBeCloseTo(notch, 9)
    expect(wheelFov(SKY_FOV_MIN, -500, 0, false)).toBe(SKY_FOV_MIN)
    expect(wheelFov(SKY_FOV_MAX, 500, 0, false)).toBe(SKY_FOV_MAX)
  })

  it('eases evenly in scale, and glides toward the wheel’s target', () => {
    expect(easeFov(30, 90, 0)).toBeCloseTo(30, 9)
    expect(easeFov(30, 90, 1)).toBeCloseTo(90, 9)
    expect(tanHalf(easeFov(30, 90, 0.5)) ** 2).toBeCloseTo(tanHalf(30) * tanHalf(90), 9)

    let fov = 90
    const steps: number[] = []
    for (let frame = 0; frame < 30; frame++) {
      fov = approachFov(fov, 30, 1 / 60)
      steps.push(fov)
    }
    // Monotonic, no overshoot, nearly there in half a second.
    expect(steps.every((f, i) => f > 30 && (i === 0 || f < steps[i - 1]))).toBe(true)
    expect(steps[steps.length - 1] - 30).toBeLessThan(0.1)
    // No single frame covers more than a quarter of the way, in scale.
    const scale = (f: number) => Math.log(tanHalf(f))
    expect((scale(90) - scale(steps[0])) / (scale(90) - scale(30))).toBeLessThan(0.25)
  })

  const panels = [[1280, 800], [390, 844], [390, 200]]
  const looks: SkyLook[] = [
    { azimuth: 180, altitude: 38.7 },
    { azimuth: 20, altitude: -5 },
    { azimuth: 300, altitude: 75 },
    { azimuth: 90, altitude: 90 },
  ]

  it('finds the sky direction under any point, as the camera draws it', () => {
    for (const [width, height] of panels) {
      for (const look of looks) {
        for (const fov of [90, 45, SKY_FOV_MIN]) {
          const camera = lookingCamera(40, look, fov, width / height)
          for (const [dx, dy] of [[0, 0], [width / 3, -height / 4], [-width / 2, height / 2]]) {
            const seen = altAz(seenAt(camera, dx, dy, width, height), 40)
            const found = directionAt(look, fov, { dx, dy }, height)
            expect(found.altitude).toBeCloseTo(seen.altitude, 6)
            if (Math.abs(seen.altitude) < 89.9) {
              expect(angleBetween(found.azimuth, seen.azimuth)).toBeLessThan(1e-6)
            }
          }
        }
      }
    }
  })

  it('keeps the sky under the fingers as it zooms', () => {
    for (const [width, height] of panels) {
      for (const look of looks.slice(0, 3)) {
        for (const [dx, dy] of [[0, 0], [width / 4, height / 5], [-width / 3, -height / 6]]) {
          const point = { dx, dy }
          const star = directionAt(look, 90, point, height)
          for (const fov of [60, 30, SKY_FOV_MIN]) {
            const kept = lookKeeping(star, point, fov, height, look)
            // Unless the look hits its clamp, the star stays put.
            if (kept.altitude <= -5 || kept.altitude >= 90) continue
            const camera = lookingCamera(40, kept, fov, width / height)
            const seen = altAz(seenAt(camera, dx, dy, width, height), 40)
            expect(seen.altitude).toBeCloseTo(star.altitude, 6)
            expect(angleBetween(seen.azimuth, star.azimuth)).toBeLessThan(1e-6)
          }
        }
      }
    }
    // Zooming about the centre only narrows the view.
    const look = { azimuth: 200, altitude: 30 }
    const centre = lookKeeping(directionAt(look, 90, { dx: 0, dy: 0 }, 800), { dx: 0, dy: 0 }, 25, 800, look)
    expect(centre.altitude).toBeCloseTo(30, 9)
    expect(angleBetween(centre.azimuth, 200)).toBeLessThan(1e-9)
  })

  it('never flips the view looking up, even zooming on the top edge', () => {
    // Over the zenith the other solution faces the opposite way.
    for (const [altitude, dy] of [[50, -400], [75, -133], [85, -300], [90, -100], [60, -200]]) {
      let look: SkyLook = { azimuth: 180, altitude }
      const point = { dx: 60, dy }
      const star = directionAt(look, 90, point, 800)
      for (let fov = 88; fov >= SKY_FOV_MIN; fov -= 2) {
        const next = lookKeeping(star, point, fov, 800, look)
        // A 2° zoom step turns the view a few degrees at most.
        expect(Math.abs(next.altitude - look.altitude)).toBeLessThan(5)
        if (next.altitude < 89) expect(angleBetween(next.azimuth, look.azimuth)).toBeLessThan(10)
        look = next
      }
    }
  })
})
