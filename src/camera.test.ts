import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { OrbitControls } from 'three-stdlib'
import { surfaceGrabRotateSpeed } from './camera'
import { EARTH_ORBIT_RADIUS } from './ephemeris'
import {
  NEAR_CLEARANCE,
  allowDistance,
  followMotion,
  minDistance,
  stepEyeDistance,
} from './main-view'
import { tiltControls } from './pivot'
import type { CameraFocus } from './store'
import { bodyRadius } from './system-aids/label-visibility'

const EARTH = bodyRadius('earth')
const SUN_RADIUS = bodyRadius('sun')

describe('surfaceGrabRotateSpeed', () => {
  it('turns the globe by the cursor travel over the radius when close', () => {
    const worldPerPixel = 1 / 100
    const domHeight = 842
    const radius = 2.95
    const speed = surfaceGrabRotateSpeed(worldPerPixel, domHeight, radius)
    const radPerPixel = (2 * Math.PI * speed) / domHeight
    expect(radPerPixel).toBeCloseTo(worldPerPixel / radius, 12)
  })

  it('keeps the default speed when far away', () => {
    expect(surfaceGrabRotateSpeed(1 / 10, 842, 2.95)).toBe(1)
  })
})

// CameraProvider's frame, cut down to the eye: drei's update, then the target
// easing onto the focus, then useEyeDistance (tides-tvr.5.1 review).
function focusChange(eye: Vector3, from: Vector3, to: Vector3, focus: CameraFocus) {
  const camera = new PerspectiveCamera(30, 1.5, 0.1, 4000)
  camera.position.copy(eye)
  const controls = new OrbitControls(camera)
  controls.enableDamping = true
  controls.target.copy(from)
  controls.minDistance = minDistance('earth')
  const carry = new Vector3()
  tiltControls(controls, camera, { tilt: 0, heading: 0, depth: 0 }, () => EARTH, carry)
  const anchor = { key: 'earth' as unknown, position: from.clone() }
  const target = from.clone()
  const eyes: Vector3[] = []
  for (let frame = 0; frame < 400; frame++) {
    controls.update()
    followMotion(anchor, focus, to, carry)
    target.lerp(to, 0.05)
    camera.lookAt(target)
    controls.target.copy(target)
    allowDistance(controls)
    controls.update()
    const closest = minDistance(focus)
    const arriving = controls.target.distanceTo(anchor.position) > closest
    stepEyeDistance(
      controls,
      null,
      arriving ? Math.min(closest, controls.getDistance()) : closest,
      2048
    )
    eyes.push(camera.position.clone())
  }
  return { eyes, distance: controls.getDistance() }
}

describe('changing focus from an Earth close-up', () => {
  const sun = new Vector3()
  const earth = new Vector3(EARTH_ORBIT_RADIUS, 0, 0)
  // Sunward of Earth at the closest distance, a little above the ecliptic.
  const sunward = new Vector3(-1, 0.18, 0).setLength(minDistance('earth')).add(earth)
  const steps = (eyes: Vector3[]) => eyes.slice(1).map((e, i) => e.distanceTo(eyes[i]))

  it('turns to the Sun behind the eye without flying through it', () => {
    const { eyes, distance } = focusChange(sunward, earth, sun, 'sun')
    for (const eye of eyes) {
      expect(eye.distanceTo(sun)).toBeGreaterThan(SUN_RADIUS * NEAR_CLEARANCE)
      expect(eye.distanceTo(earth)).toBeGreaterThan(EARTH * NEAR_CLEARANCE)
    }
    expect(Math.max(...steps(eyes))).toBeLessThan(1e-6)
    expect(distance).toBeGreaterThan(minDistance('sun'))
  })

  it('backs off a location on the surface below it smoothly', () => {
    const pin = sunward.clone().sub(earth).setLength(EARTH).add(earth)
    const { eyes, distance } = focusChange(sunward, earth, pin, 'location')
    for (const eye of eyes) {
      expect(eye.distanceTo(earth)).toBeGreaterThan(EARTH * NEAR_CLEARANCE)
    }
    // From ~7x too close, the ease's ~10% of the distance a frame at most.
    steps(eyes).forEach((step, i) => {
      expect(step, `frame ${i}`).toBeLessThan(0.15 * eyes[i].distanceTo(pin))
    })
    expect(distance).toBeCloseTo(minDistance('location'), 2)
  })
})
