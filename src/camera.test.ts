import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { OrbitControls } from 'three-stdlib'
import { surfaceGrabRotateSpeed } from './camera'
import { EARTH_ORBIT_RADIUS } from './ephemeris'
import {
  MAIN_DISTANCE,
  NEAR_CLEARANCE,
  allowDistance,
  followMotion,
  framingDistance,
  minDistance,
  stepFocusDistance,
  turnTarget,
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

// CameraProvider's frame, cut down to the eye: drei's update, then the
// target turning onto the focus, then useEyeDistance (tides-tvr.5.1 review).
function focusChange(
  eye: Vector3,
  from: Vector3,
  to: Vector3,
  focus: CameraFocus,
  framed: number | null = null,
  fromFocus: CameraFocus = 'earth'
) {
  const camera = new PerspectiveCamera(30, 1.5, 0.1, 4000)
  camera.position.copy(eye)
  const controls = new OrbitControls(camera)
  controls.enableDamping = true
  controls.target.copy(from)
  controls.minDistance = minDistance(fromFocus)
  const carry = new Vector3()
  tiltControls(controls, camera, { tilt: 0, heading: 0, depth: 0 }, () => EARTH, carry)
  controls.update()
  const anchor = { key: fromFocus as unknown, position: from.clone() }
  const target = from.clone()
  const eyes: Vector3[] = []
  const turns: number[] = []
  const toTarget: number[] = []
  const view = camera.getWorldDirection(new Vector3())
  let framing = framed
  let landedAt = -1
  for (let frame = 0; frame < 600; frame++) {
    controls.update()
    followMotion(anchor, focus, to, carry)
    turnTarget(target, camera.position, to, 0.05)
    camera.lookAt(target)
    controls.target.copy(target)
    allowDistance(controls)
    controls.update()
    if (stepFocusDistance(controls, anchor, framing, minDistance(focus), 2048)) {
      framing = null
      landedAt = frame
    }
    const next = camera.getWorldDirection(new Vector3())
    turns.push((next.angleTo(view) * 180) / Math.PI)
    view.copy(next)
    eyes.push(camera.position.clone())
    toTarget.push(camera.position.distanceTo(controls.target))
  }
  return { eyes, turns, toTarget, landedAt, distance: controls.getDistance() }
}

const steps = (eyes: Vector3[]) => eyes.slice(1).map((e, i) => e.distanceTo(eyes[i]))

describe('changing focus', () => {
  const sun = new Vector3()
  const earth = new Vector3(EARTH_ORBIT_RADIUS, 0, 0)
  // Sunward of Earth at the closest distance, `up` off the Earth–Sun line.
  const sunward = (up: number) =>
    new Vector3(-1, Math.tan((up * Math.PI) / 180), 0)
      .setLength(minDistance('earth'))
      .add(earth)

  it.each([10, 35])(
    'turns from an Earth close-up to the Sun behind the eye (%s° off) without whipping or flying through it',
    (up) => {
      const { eyes, turns, toTarget, distance } = focusChange(sunward(up), earth, sun, 'sun')
      for (const eye of eyes) {
        expect(eye.distanceTo(sun)).toBeGreaterThan(SUN_RADIUS * NEAR_CLEARANCE)
        expect(eye.distanceTo(earth)).toBeGreaterThan(EARTH * NEAR_CLEARANCE)
      }
      expect(Math.max(...steps(eyes))).toBeLessThan(1e-6)
      expect(Math.max(...turns)).toBeLessThan(10)
      // The target never passes by the eye, so neither does the near plane.
      expect(Math.min(...toTarget)).toBeGreaterThan(minDistance('earth') * 0.9)
      expect(distance).toBeGreaterThan(minDistance('sun'))
    }
  )

  it('turns from a Jupiter close-up to Earth behind the eye, then frames it', () => {
    const jupiter = new Vector3(-150, 0, 0)
    const eye = new Vector3(1, 0.05, 0).setLength(minDistance('jupiter')).add(jupiter)
    const { eyes, turns, landedAt, distance } = focusChange(
      eye,
      jupiter,
      earth,
      'earth',
      MAIN_DISTANCE,
      'jupiter'
    )
    expect(Math.max(...turns)).toBeLessThan(10)
    for (const e of eyes) {
      expect(e.distanceTo(jupiter)).toBeGreaterThan(bodyRadius('jupiter') * NEAR_CLEARANCE)
      expect(e.distanceTo(sun)).toBeGreaterThan(SUN_RADIUS * NEAR_CLEARANCE)
    }
    expect(landedAt).toBeGreaterThan(0)
    expect(distance / MAIN_DISTANCE).toBeCloseTo(1, 3)
  })

  it('frames Saturn only once the target reaches it, without overshooting', () => {
    const saturn = new Vector3(-240, 0, 30)
    const toSaturn = saturn.clone().sub(earth).normalize()
    const goal = framingDistance(bodyRadius('saturn'), EARTH)
    for (const side of [1, -1]) {
      const eye = toSaturn.clone().multiplyScalar(side * MAIN_DISTANCE).add(earth)
      const { eyes, landedAt, distance } = focusChange(
        eye,
        earth,
        saturn,
        'saturn',
        goal
      )
      // The eye holds still until the target reaches Saturn.
      const arrived = steps(eyes).findIndex((step) => step > 1e-9) + 1
      expect(arrived, `side ${side}`).toBeGreaterThan(30)
      for (const e of eyes) {
        expect(e.distanceTo(sun)).toBeGreaterThan(SUN_RADIUS * NEAR_CLEARANCE)
        expect(e.distanceTo(saturn)).toBeGreaterThan(minDistance('saturn'))
      }
      // Then it heads for the framing and stays on its side of it.
      const moved = eyes.slice(arrived).map((e) => e.distanceTo(saturn))
      const fromSide = Math.sign(moved[0] - goal)
      for (const d of moved) expect(Math.sign(d - goal) * fromSide).toBeGreaterThanOrEqual(-1e-9)
      expect(landedAt).toBeGreaterThan(arrived)
      expect(distance / goal).toBeCloseTo(1, 3)
    }
  })

  it('backs off a location on the surface below it smoothly', () => {
    const start = sunward(10)
    const pin = start.clone().sub(earth).setLength(EARTH).add(earth)
    const { eyes, distance } = focusChange(start, earth, pin, 'location')
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
