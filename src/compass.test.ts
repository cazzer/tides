import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  SMOOTHING_MS,
  deviceQuaternion,
  lookFromQuaternion,
  readingAngles,
  smoothOrientation,
  type DeviceAngles,
} from './compass'
import type { SkyLook } from './sky-look'

const DEG = Math.PI / 180

// Horizon frame: X east, Y the zenith, −Z north.
function direction(azimuth: number, altitude: number) {
  const a = azimuth * DEG
  const h = altitude * DEG
  return new THREE.Vector3(Math.sin(a) * Math.cos(h), Math.sin(h), -Math.cos(a) * Math.cos(h))
}

// The view's line of sight and screen-up, built back the way
// placeSurfaceCamera turns the camera.
function view(look: SkyLook) {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(look.altitude * DEG, -look.azimuth * DEG, (look.roll ?? 0) * DEG, 'YXZ')
  )
  return {
    forward: new THREE.Vector3(0, 0, -1).applyQuaternion(q),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
  }
}

const lookFor = (angles: DeviceAngles, screenAngle = 0) =>
  lookFromQuaternion(deviceQuaternion(angles, screenAngle))

// W3C angles for a pose given as turns in the earth frame (Z up, Y north):
// R = Rz(alpha) Rx(beta) Ry(gamma), then `spin` about the screen's normal.
function anglesFor(alpha: number, beta: number, gamma: number, spin = 0): DeviceAngles {
  const q = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(beta * DEG, gamma * DEG, alpha * DEG, 'ZXY'))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), spin * DEG))
  const e = new THREE.Euler().setFromQuaternion(q, 'ZXY')
  return { alpha: e.z / DEG, beta: e.x / DEG, gamma: e.y / DEG }
}

const expectClose = (a: THREE.Vector3, b: THREE.Vector3, digits = 6) => {
  expect(a.x).toBeCloseTo(b.x, digits)
  expect(a.y).toBeCloseTo(b.y, digits)
  expect(a.z).toBeCloseTo(b.z, digits)
}

describe('compass mode orientation (tides-d5j)', () => {
  it('looks at the ground with the screen-top north when the phone lies face up', () => {
    const { forward, up } = view(lookFor({ alpha: 0, beta: 0, gamma: 0 }))
    expectClose(forward, new THREE.Vector3(0, -1, 0))
    expectClose(up, direction(0, 0))
  })

  it('looks north along the horizon with the phone held upright facing north', () => {
    const look = lookFor({ alpha: 0, beta: 90, gamma: 0 })
    expect(look.azimuth).toBeCloseTo(0, 6)
    expect(look.altitude).toBeCloseTo(0, 6)
    expect(look.roll).toBeCloseTo(0, 6)
  })

  it('looks east when the upright phone turns to face east', () => {
    // alpha turns anticlockwise from north, so east is 270.
    const look = lookFor({ alpha: 270, beta: 90, gamma: 0 })
    expect(look.azimuth).toBeCloseTo(90, 6)
    expect(look.altitude).toBeCloseTo(0, 6)
    expect(look.roll).toBeCloseTo(0, 6)
  })

  it('looks 45° up when the upright phone tilts back by 45°', () => {
    const look = lookFor({ alpha: 0, beta: 135, gamma: 0 })
    expect(look.azimuth).toBeCloseTo(0, 6)
    expect(look.altitude).toBeCloseTo(45, 6)
    expect(look.roll).toBeCloseTo(0, 6)
  })

  it('keeps the horizon level on a landscape screen', () => {
    // Facing north, turned a quarter anticlockwise onto its side.
    const sideways = anglesFor(0, 90, 0, 90)
    const look = lookFor(sideways, 90)
    expect(look.azimuth).toBeCloseTo(0, 6)
    expect(look.altitude).toBeCloseTo(0, 6)
    expect(look.roll).toBeCloseTo(0, 6)
    // Unrotated content would show the horizon on end.
    expect(Math.abs(lookFor(sideways, 0).roll!)).toBeCloseTo(90, 6)
    // ...and the other way round.
    expect(lookFor(anglesFor(0, 90, 0, -90), 270).roll).toBeCloseTo(0, 6)
  })

  it('follows a tilted phone with the matching roll', () => {
    // Upright facing east, tilted 45° up, then leant 20° clockwise.
    const look = lookFor(anglesFor(270, 135, 0, -20))
    expect(look.azimuth).toBeCloseTo(90, 6)
    expect(look.altitude).toBeCloseTo(45, 6)
    expect(look.roll).toBeCloseTo(-20, 6)
  })

  it('turns smoothly through the zenith instead of flipping', () => {
    // Tilting back past vertical, facing north: beta runs 179.5 → −179.5.
    const before = view(lookFor({ alpha: 0, beta: 179.5, gamma: 0 }))
    const after = view(lookFor({ alpha: 0, beta: -179.5, gamma: 0 }))
    expect(before.forward.angleTo(after.forward) / DEG).toBeCloseTo(1, 4)
    expect(before.up.angleTo(after.up) / DEG).toBeCloseTo(1, 4)
    // A shaky hand near the zenith moves the view only as much as the phone.
    const shaken = view(lookFor({ alpha: 0, beta: 179.8, gamma: 0.3 }))
    expect(before.up.angleTo(shaken.up) / DEG).toBeLessThan(1)
    expect(before.forward.angleTo(shaken.forward) / DEG).toBeLessThan(1)
    expect(before.forward.angleTo(direction(0, 89.5)) / DEG).toBeCloseTo(0, 4)
  })

  it('points the line of sight out of the back for any pose', () => {
    for (const [alpha, beta, gamma] of [
      [30, 60, -20],
      [200, 110, 45],
      [310, -30, 80],
    ]) {
      const R = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(beta * DEG, gamma * DEG, alpha * DEG, 'ZXY')
      )
      // The back, in the earth frame, then into the horizon frame.
      const back = new THREE.Vector3(0, 0, -1).applyQuaternion(R)
      const expected = new THREE.Vector3(back.x, back.z, -back.y)
      for (const screenAngle of [0, 90, 180, 270]) {
        expectClose(view(lookFor({ alpha, beta, gamma }, screenAngle)).forward, expected)
      }
    }
  })
})

describe('reading a north from orientation events', () => {
  it('turns the iOS compass heading into an anticlockwise alpha', () => {
    expect(
      readingAngles({ alpha: 12, beta: 90, gamma: 0, absolute: false, webkitCompassHeading: 90 })
    ).toEqual({ alpha: 270, beta: 90, gamma: 0 })
  })

  it('takes alpha from an absolute reading', () => {
    expect(readingAngles({ alpha: 40, beta: 10, gamma: 5, absolute: true })).toEqual({
      alpha: 40,
      beta: 10,
      gamma: 5,
    })
  })

  it('has no north from a relative alpha, an uncalibrated compass or no sensor', () => {
    expect(readingAngles({ alpha: 40, beta: 10, gamma: 5, absolute: false })).toBeNull()
    expect(
      readingAngles({ alpha: 40, beta: 10, gamma: 5, absolute: false, webkitCompassHeading: -1 })
    ).toBeNull()
    expect(readingAngles({ alpha: null, beta: null, gamma: null, absolute: true })).toBeNull()
  })
})

describe('smoothing the orientation', () => {
  const facing = (azimuth: number) => deviceQuaternion({ alpha: -azimuth, beta: 90, gamma: 0 }, 0)

  it('wraps the heading through north', () => {
    const q = facing(350)
    smoothOrientation(q, facing(10), SMOOTHING_MS * Math.log(2))
    const azimuth = lookFromQuaternion(q).azimuth
    expect(Math.min(azimuth, 360 - azimuth)).toBeLessThan(0.5)
  })

  it('holds still for no time and settles given time', () => {
    const q = facing(0)
    smoothOrientation(q, facing(90), 0)
    expect(lookFromQuaternion(q).azimuth).toBeCloseTo(0, 6)
    smoothOrientation(q, facing(90), SMOOTHING_MS * 20)
    expect(lookFromQuaternion(q).azimuth).toBeCloseTo(90, 4)
  })
})
