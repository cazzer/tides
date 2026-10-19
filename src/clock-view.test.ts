import { describe, expect, it } from 'vitest'
import { OrthographicCamera, Spherical, Vector3 } from 'three'
import {
  CLOCK_FRAMING_EASE,
  CLOCK_VIEW,
  clockViewOffset,
  leaveClock,
  rideWithClock,
  type ClockRide,
} from './clock-view'
import { EARTH_ORBIT_RADIUS, earthAngle } from './ephemeris'

const DEG = Math.PI / 180
const CLOCK_RADIUS = 29
const Y = new Vector3(0, 1, 0)

const radial = (a: number) => new Vector3(Math.cos(a), 0, -Math.sin(a))
const clockAt = (a: number) => radial(a).multiplyScalar(CLOCK_RADIUS)

function viewAt(a: number) {
  const clock = clockAt(a)
  const camera = new OrthographicCamera()
  camera.position.copy(clock).add(clockViewOffset(a))
  camera.lookAt(clock)
  camera.updateMatrixWorld()
  const toView = (v: Vector3) => v.clone().applyMatrix4(camera.matrixWorldInverse)
  const dirToView = (v: Vector3) =>
    v.clone().transformDirection(camera.matrixWorldInverse)
  return { toView, dirToView }
}

function wrapToPi(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI))
}

function freshRide(entryEase = 1): ClockRide {
  return { angle: null, ease: 0, entryEase }
}

function frame(
  position: Vector3,
  target: Vector3,
  clock: Vector3,
  ride: ClockRide
) {
  rideWithClock(position, target.clone(), target, clock, ride, 1)
}

function thetaError(position: Vector3, target: Vector3, a: number) {
  const s = new Spherical().setFromVector3(position.clone().sub(target))
  return wrapToPi(s.theta - (a + CLOCK_VIEW.azimuth))
}

function settle(
  position: Vector3,
  target: Vector3,
  clock: Vector3,
  ride: ClockRide
) {
  for (let i = 0; i < 1000 && ride.ease > 0; i++) {
    frame(position, target, clock, ride)
  }
}

const angles = [
  ...Array.from({ length: 24 }, (_, i) => i * 15 * DEG),
  earthAngle(Date.parse('2026-01-15T12:00Z')),
  earthAngle(Date.parse('2026-07-15T12:00Z')),
]

describe('clockViewOffset', () => {
  it.each(angles)('keeps the clock legible at angle %f', (a) => {
    const { toView, dirToView } = viewAt(a)
    const r = dirToView(radial(a))
    // Text reads along r̂ with glyph-up along t̂ = Ŷ×r̂, given its
    // rotation (−π/2, 0, angle).
    const t = dirToView(new Vector3().crossVectors(Y, radial(a)))
    const { azimuth, elevation } = CLOCK_VIEW

    expect(r.x).toBeGreaterThan(0)
    const slope = Math.atan2(r.y, r.x)
    const expected = -Math.atan(Math.sin(elevation) * Math.tan(azimuth))
    expect(Math.abs(slope - expected)).toBeLessThan(0.5 * DEG)
    expect(slope).toBeGreaterThan(-25 * DEG)
    expect(slope).toBeLessThan(-5 * DEG)
    expect(t.y).toBeGreaterThan(0)
    expect(r.x * t.y - r.y * t.x).toBeGreaterThan(0)

    const sun = toView(new Vector3())
    expect(sun.x).toBeLessThan(0)
    expect(sun.y).toBeGreaterThan(0)
    const earth = toView(radial(a).multiplyScalar(EARTH_ORBIT_RADIUS))
    expect(earth.x).toBeGreaterThan(0)
    expect(earth.y).toBeLessThan(0)

    for (let d = -45; d <= 60; d += 5) {
      expect(dirToView(radial(a + d * DEG)).x).toBeGreaterThan(0)
    }
  })
})

describe('rideWithClock', () => {
  it('snaps to the clock view on first entry', () => {
    const a = 1.2
    const clock = clockAt(a)
    const target = clock.clone()
    const position = new Vector3(100, 80, 80)
    rideWithClock(position, target.clone(), target, clock, freshRide(), 0.05)

    const offset = position.clone().sub(target)
    const expected = clockViewOffset(a)
    expect(offset.distanceTo(expected)).toBeLessThan(1e-9)
    expect(target.distanceTo(clock)).toBeLessThan(1e-9)
  })

  it('co-rotates rigidly with the clock across ±π', () => {
    const ride = freshRide()
    let a = 150 * DEG
    const target = clockAt(a)
    const position = new Vector3(100, 80, 80)
    frame(position, target, clockAt(a), ride)
    expect(ride.ease).toBe(0)

    for (let step = 0; step < 30; step++) {
      a += (90 * DEG) / 30
      const clock = clockAt(a)
      frame(position, target, clock, ride)
      const offset = position.clone().sub(target)
      expect(offset.distanceTo(clockViewOffset(a))).toBeLessThan(1e-6)
      expect(target.distanceTo(clock)).toBeLessThan(1e-9)
    }
  })

  it('keeps a user drag instead of easing it back', () => {
    const ride = freshRide()
    const a = 0.4
    const target = clockAt(a)
    const position = new Vector3()
    frame(position, target, clockAt(a), ride)
    ride.ease = 0

    const s = new Spherical().setFromVector3(position.clone().sub(target))
    s.theta += 0.3
    position.copy(target).add(new Vector3().setFromSpherical(s))

    const b = a + 1
    frame(position, target, clockAt(b), ride)
    s.setFromVector3(position.clone().sub(target))
    expect(wrapToPi(s.theta - (b + CLOCK_VIEW.azimuth))).toBeCloseTo(0.3, 9)
  })

  it('turns the short way when the angle wraps', () => {
    const ride = freshRide()
    const target = clockAt(179 * DEG)
    const position = new Vector3()
    frame(position, target, clockAt(179 * DEG), ride)
    ride.ease = 0
    const before = position.clone().sub(target)

    frame(position, target, clockAt(-179 * DEG), ride)
    const after = position.clone().sub(target)
    const turn = Math.atan2(
      before.clone().cross(after).y,
      before.x * after.x + before.z * after.z
    )
    expect(turn).toBeCloseTo(2 * DEG, 9)
    expect(ride.angle).toBeCloseTo(-179 * DEG, 12)
  })

  it('eases rather than snaps when re-entering after leaving', () => {
    const ride = freshRide()
    const a = 0.8
    const clock = clockAt(a)
    const target = clock.clone()
    const position = new Vector3(100, 80, 80)
    frame(position, target, clock, ride)
    leaveClock(ride)

    const s = new Spherical().setFromVector3(position.clone().sub(target))
    s.theta += 1
    position.copy(target).add(new Vector3().setFromSpherical(s))

    frame(position, target, clock, ride)
    expect(ride.ease).toBe(CLOCK_FRAMING_EASE)
    expect(thetaError(position, target, a)).toBeCloseTo(
      1 - CLOCK_FRAMING_EASE,
      9
    )

    settle(position, target, clock, ride)
    expect(ride.ease).toBe(0)
    const offset = position.clone().sub(target)
    expect(offset.distanceTo(clockViewOffset(a))).toBeLessThan(0.25)
  })

  it('eases on the first entry when another focus came first', () => {
    const ride = freshRide()
    leaveClock(ride)
    const a = -2
    const clock = clockAt(a)
    const target = clock.clone()
    const position = new Vector3(100, 80, 80)
    const before = position.clone().sub(target)

    frame(position, target, clock, ride)
    expect(ride.ease).toBe(CLOCK_FRAMING_EASE)
    const offset = position.clone().sub(target)
    expect(offset.distanceTo(clockViewOffset(a))).toBeGreaterThan(
      0.5 * before.distanceTo(clockViewOffset(a))
    )

    settle(position, target, clock, ride)
    expect(ride.ease).toBe(0)
    expect(
      position.clone().sub(target).distanceTo(clockViewOffset(a))
    ).toBeLessThan(0.25)
  })

  it('brings a lagging target onto the clock while co-rotating', () => {
    const ride = freshRide()
    let a = 2.5
    const target = new Vector3(0, 0, 0)
    const position = new Vector3(100, 80, 80)

    for (let step = 0; step < 400; step++) {
      a += 0.01
      rideWithClock(position, target.clone(), target, clockAt(a), ride, 0.05)
    }
    expect(target.distanceTo(clockAt(a))).toBeLessThan(1e-6)
    expect(
      position.clone().sub(target).distanceTo(clockViewOffset(a))
    ).toBeLessThan(1e-6)
  })

  it('measures the offset from the controls target', () => {
    const ride = freshRide()
    const a = 0.3
    const target = clockAt(a)
    const position = new Vector3()
    frame(position, target, clockAt(a), ride)

    const orbitTarget = target.clone().add(new Vector3(3, -1, 2))
    const dragged = new Vector3(10, 40, -60)
    position.copy(orbitTarget).add(dragged)

    const b = a + 0.5
    rideWithClock(position, orbitTarget, target, clockAt(b), ride, 1)
    const expected = dragged.clone().applyAxisAngle(Y, 0.5)
    expect(position.clone().sub(target).distanceTo(expected)).toBeLessThan(
      1e-9
    )
  })
})
