// Earth carries the ship (tides-zmw.9.18): frame-carry.ts against the real
// Earth and Moon bodies at the flight scale, and against synthetic carriers
// for the sphere-of-influence edges.
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { latLonToLocal } from '../aurora'
import { createShipState, MAX_DT, type ShipState } from './flight'
import { createShipBodies, EARTH_RADIUS, EARTH_UNITS_PER_METRE, updateShipBody, type ShipBody } from './ship-bodies'
import { createShipTelemetry } from './ship-telemetry'
import {
  DRAG_TAU,
  EARTH_SOI,
  MOON_SOI,
  RELEASE_BAND_KM,
  SCALE_HEIGHT_KM,
  SIDEREAL_RATE,
  airDensity,
  carryShip,
  createFrameCarry,
  dragRate,
  earthSpinRate,
  equilibriumKappa,
  fillAir,
  fillAirDensity,
  relaxKappa,
  releaseRate,
  resetFrameCarry,
  type Carrier,
  type FrameCarry,
} from './frame-carry'
import { smoothstep } from './dust'

const T0 = Date.UTC(2026, 9, 22, 12)
const M = EARTH_UNITS_PER_METRE
const DEG = Math.PI / 180
const FRAME = 1 / 60

function carriers(t: number): { earth: ShipBody; moon: ShipBody } {
  const bodies = createShipBodies('high', true)
  const earth = bodies.find((b) => b.key === 'earth')!
  const moon = bodies.find((b) => b.key === 'moon')!
  updateShipBody(earth, t)
  updateShipBody(moon, t)
  return { earth, moon }
}

const toLocal = (earth: ShipBody, world: THREE.Vector3) =>
  world.clone().sub(earth.position).applyQuaternion(earth.spin!.clone().invert())
const toWorld = (earth: ShipBody, local: THREE.Vector3) => local.clone().applyQuaternion(earth.spin!).add(earth.position)

// A ship `metres` over the sea at (lat, lon), nose north and level, at rest.
function shipOver(earth: ShipBody, lat: number, lon: number, metres: number): ShipState {
  const state = createShipState()
  const up = latLonToLocal(lat, lon)
  state.position.copy(toWorld(earth, up.clone().multiplyScalar(EARTH_RADIUS + metres * M)))
  const north = new THREE.Vector3(0, 1, 0).projectOnPlane(up).normalize()
  const look = new THREE.PerspectiveCamera()
  look.position.set(0, 0, 0)
  look.up.copy(up.clone().applyQuaternion(earth.spin!))
  look.lookAt(north.clone().applyQuaternion(earth.spin!))
  state.orientation.copy(look.quaternion)
  return state
}

// Runs `frames` frames of `dt` real seconds at `scale`: the bodies move to
// the sim time, then the carry. Returns the sim time reached.
function fly(
  carry: FrameCarry,
  state: ShipState,
  earth: ShipBody,
  moon: ShipBody | null,
  t: number,
  frames: number,
  dt: number,
  scale: number,
  each?: (t: number) => void
): number {
  for (let k = 0; k < frames; k++) {
    t += dt * 1000 * scale
    updateShipBody(earth, t)
    if (moon) updateShipBody(moon, t)
    carryShip(carry, state, earth, moon, dt, earthSpinRate(scale))
    each?.(t)
  }
  return t
}

describe('the air (tides-zmw.9.18)', () => {
  it('thins by e every scale height, drags harder the faster the ship goes, lets go above it', () => {
    expect(airDensity(0)).toBe(1)
    expect(airDensity(SCALE_HEIGHT_KM) * Math.E).toBeCloseTo(1, 12)
    expect(dragRate(20, 0) / dragRate(20 + SCALE_HEIGHT_KM, 0)).toBeCloseTo(Math.E, 10)
    expect(dragRate(0, 0)).toBeCloseTo(1 / DRAG_TAU, 12)
    expect(dragRate(30, 1000)).toBeCloseTo(11 * dragRate(30, 0), 10)
    expect(releaseRate(RELEASE_BAND_KM[0])).toBe(0)
    expect(releaseRate(RELEASE_BAND_KM[1])).toBe(0.5)
    expect(equilibriumKappa(dragRate(50, 0), releaseRate(50))).toBe(1)
    expect(equilibriumKappa(dragRate(200, 0), releaseRate(200))).toBeLessThan(1e-8)
    // Below the sea a little only: never Infinity.
    expect(Number.isFinite(dragRate(-6371, 0))).toBe(true)
  })

  it('relaxes the grip exactly: the closed form, any step, unchanged where nothing acts', () => {
    const drag = 3
    const release = 1
    const eq = drag / (drag + release)
    expect(relaxKappa(0, drag, release, 0.5)).toBeCloseTo(eq * (1 - Math.exp(-2)), 14)
    expect(relaxKappa(0, drag, release, 1e6)).toBeCloseTo(eq, 14)
    expect(relaxKappa(0.3, 0, 0, 1)).toBe(0.3)
    expect(relaxKappa(0.3, drag, release, 0)).toBe(0.3)
    expect(relaxKappa(0.3, drag, release, NaN)).toBe(0.3)
    let split = 0
    for (let i = 0; i < 60; i++) split = relaxKappa(split, drag, release, 1 / 60)
    expect(split).toBeCloseTo(relaxKappa(0, drag, release, 1), 12)
  })

  it('splits a descent-less second the same in 60 frames as in 10 (no spin: constant rates)', () => {
    const { earth } = carriers(T0)
    const run = (frames: number) => {
      const carry = createFrameCarry()
      const state = shipOver(earth, 36, -112, 40000)
      carryShip(carry, state, earth, null, FRAME, 0)
      carry.kappa = 0
      for (let i = 0; i < frames; i++) carryShip(carry, state, earth, null, 1 / frames, 0)
      return carry.kappa
    }
    const a = run(60)
    expect(a).toBeGreaterThan(0.05)
    expect(Math.abs(a - run(10))).toBeLessThan(1e-6)
  })

  it('catches a gripless ship standing in the air 30 km up between the drag rates still and slipping', () => {
    const { earth, moon } = carriers(T0)
    const carry = createFrameCarry()
    const state = shipOver(earth, 36, -112, 30000)
    carryShip(carry, state, earth, moon, FRAME, earthSpinRate(1))
    expect(carry.kappa).toBe(1)
    carry.kappa = 0
    // The air slips past at ω × r · cos 36° ≈ 380 m/s at first, nothing once caught.
    fly(carry, state, earth, moon, T0, 360, FRAME, 1)
    expect(carry.kappa).toBeGreaterThan(1 - Math.exp(-dragRate(30, 0) * 6))
    expect(carry.kappa).toBeLessThan(1 - Math.exp(-dragRate(30, 380) * 6))
  })
})

describe('Earth carries the ship (tides-zmw.9.18)', () => {
  it.each([1, 3600, 86400])(
    'holds a hover 100 m over the Grand Canyon in Earth\'s frame, position and nose, at %sx, through a 10 s stall',
    (scale) => {
      const { earth, moon } = carriers(T0)
      const carry = createFrameCarry()
      const state = shipOver(earth, 36.06, -112.11, 100)
      carryShip(carry, state, earth, moon, FRAME, earthSpinRate(scale))
      expect(carry.kappa).toBe(1)
      const local0 = toLocal(earth, state.position)
      const nose0 = new THREE.Vector3(0, 0, -1).applyQuaternion(state.orientation).applyQuaternion(earth.spin!.clone().invert())
      let t = fly(carry, state, earth, moon, T0, 600, FRAME, scale)
      // A 10 s frame: the sim runs on 10 s · scale, the grip relaxes MAX_DT.
      t = fly(carry, state, earth, moon, t, 1, 10, scale)
      fly(carry, state, earth, moon, t, 60, FRAME, scale)
      const drift = toLocal(earth, state.position).distanceTo(local0)
      expect(drift).toBeLessThan(1e-9) // ~2 mm
      const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(state.orientation).applyQuaternion(earth.spin!.clone().invert())
      expect(nose.angleTo(nose0)).toBeLessThan(1e-9)
      expect(carry.kappa).toBe(1)
      // Without the carry the same frames leave it far behind.
      expect(carry.carried.length()).toBeGreaterThan(1e3 * M)
    }
  )

  it('keeps a ship flying north on its heading in Earth\'s frame', () => {
    const { earth, moon } = carriers(T0)
    const carry = createFrameCarry()
    const state = shipOver(earth, 10, 20, 500)
    carryShip(carry, state, earth, moon, FRAME, earthSpinRate(1))
    const north = new THREE.Vector3(0, 1, 0).projectOnPlane(latLonToLocal(10, 20)).normalize()
    state.velocity.copy(north.applyQuaternion(earth.spin!)).multiplyScalar(200 * M)
    const heading0 = state.velocity.clone().applyQuaternion(earth.spin!.clone().invert())
    fly(carry, state, earth, moon, T0, 300, FRAME, 1, () => state.position.addScaledVector(state.velocity, FRAME))
    const heading = state.velocity.clone().applyQuaternion(earth.spin!.clone().invert())
    expect(heading.angleTo(heading0)).toBeLessThan(1e-9)
    expect(heading.length()).toBeCloseTo(heading0.length(), 15)
  })

  it('lets go above the air: the grip falls to nothing, the velocity stays, and Earth turns beneath', () => {
    const { earth, moon } = carriers(T0)
    const carry = createFrameCarry()
    const lat = 36
    const state = shipOver(earth, lat, -112, 0.3 / M)
    carryShip(carry, state, earth, moon, FRAME, earthSpinRate(1))
    expect(carry.kappa).toBeLessThan(1e-20)
    carry.kappa = 1
    const t = fly(carry, state, earth, moon, T0, 20 * 60, FRAME, 1)
    expect(carry.kappa).toBeLessThan(1e-4)
    expect(state.velocity.length()).toBe(0)
    // Over the next 10 s the ground slides east under it: the ship drifts west at ω · r · cos(lat).
    const a = toLocal(earth, state.position)
    fly(carry, state, earth, moon, t, 600, FRAME, 1)
    const b = toLocal(earth, state.position)
    const r = EARTH_RADIUS + 0.3
    const expected = SIDEREAL_RATE * r * Math.cos(lat * DEG) * 10
    expect(a.distanceTo(b) / expected).toBeCloseTo(1, 3)
    // West: against Earth's turn about its +Y.
    const east = new THREE.Vector3(0, 1, 0).cross(a).normalize()
    expect(b.clone().sub(a).dot(east)).toBeLessThan(0)
  })

  it('holds a hover over the Moon fixed to the Moon at 3600x', () => {
    const { earth, moon } = carriers(T0)
    const carry = createFrameCarry()
    const state = createShipState()
    const out = new THREE.Vector3(1, 0.2, 0.3).normalize()
    state.position.copy(moon.position).addScaledVector(out, moon.radius + 0.05)
    carryShip(carry, state, earth, moon, FRAME, earthSpinRate(3600))
    const rel0 = state.position.clone().sub(moon.position)
    const toEarth0 = moon.position.distanceTo(earth.position)
    fly(carry, state, earth, moon, T0, 600, FRAME, 3600)
    // The Moon moved ~0.27 u in Earth's frame over those 10 min of sim.
    expect(Math.abs(moon.position.distanceTo(earth.position) - toEarth0) + carry.carried.length()).toBeGreaterThan(0.1)
    expect(state.position.clone().sub(moon.position).distanceTo(rel0)).toBeLessThan(1e-9)
    expect(carry.weightMoon).toBe(1)
  })
})

describe('the spheres of influence (tides-zmw.9.18)', () => {
  // Synthetic carriers moving steadily, the ship flown radially out past each edge.
  const vE = new THREE.Vector3(2e-4, 0, 1e-4)
  const vM = new THREE.Vector3(-3e-5, 0, 2e-5)

  function edgeRun(from: THREE.Vector3, to: THREE.Vector3, frames: number) {
    const earth: Carrier = { position: new THREE.Vector3(1000, 0, 0), radius: EARTH_RADIUS }
    const moon: Carrier = { position: new THREE.Vector3(1000, 0, 10), radius: 0.8 }
    const carry = createFrameCarry()
    const state = createShipState()
    state.position.copy(earth.position).add(from)
    carryShip(carry, state, earth, moon, FRAME, 0)
    const steps: THREE.Vector3[] = []
    const weights: number[] = []
    for (let k = 1; k <= frames; k++) {
      // The ship's own track, off Earth where it was; then the carriers move and carry it.
      state.position.copy(earth.position).add(from.clone().lerp(to, k / frames))
      earth.position.add(vE)
      moon.position.add(vE).add(vM)
      const before = state.position.clone()
      carryShip(carry, state, earth, moon, FRAME, 0)
      steps.push(state.position.clone().sub(before))
      weights.push(carry.weightEarth)
    }
    return { steps, weights }
  }

  it("carries Earth's whole move inside its sphere, none outside, smoothly between, never more than Earth moved", () => {
    const dir = new THREE.Vector3(0, 0, -1)
    const { steps, weights } = edgeRun(dir.clone().multiplyScalar(12), dir.clone().multiplyScalar(25), 1300)
    for (let i = 0; i < steps.length; i++) {
      expect(steps[i].length()).toBeLessThanOrEqual(vE.length() * (1 + 1e-9))
      if (i > 0) {
        expect(Math.abs(steps[i].length() - steps[i - 1].length())).toBeLessThan(0.01 * vE.length())
        expect(Math.abs(weights[i] - weights[i - 1])).toBeLessThan(0.01)
      }
    }
    expect(steps[0].distanceTo(vE)).toBeLessThan(1e-12)
    expect(steps[steps.length - 1].length()).toBe(0)
    // w = 1 − smoothstep, which is C1: the steps follow it.
    const d = 12 + (13 * 650) / 1300
    expect(weights[649]).toBeCloseTo(1 - smoothstep(EARTH_SOI[0], EARTH_SOI[1], d), 1)
  })

  it("hands over from Earth's move to the Moon's across the Moon's band without a jump", () => {
    // From 3 u off the Moon (Earth's side) to 1 u off it.
    const { steps } = edgeRun(new THREE.Vector3(0, 0, 10 - 3), new THREE.Vector3(0, 0, 10 - 1), 1200)
    const vMoon = vE.clone().add(vM)
    expect(steps[0].distanceTo(vE)).toBeLessThan(1e-12)
    expect(steps[steps.length - 1].distanceTo(vMoon)).toBeLessThan(1e-12)
    for (let i = 1; i < steps.length; i++) expect(steps[i].distanceTo(steps[i - 1])).toBeLessThan(0.01 * vM.length())
    expect(MOON_SOI[1]).toBeLessThan(3)
  })
})

describe('the carry, degenerate (tides-zmw.9.18)', () => {
  it('moves nothing on its first frame, and stays finite for odd steps, time running back and a ship at the centre', () => {
    const { earth, moon } = carriers(T0)
    const carry = createFrameCarry()
    const state = shipOver(earth, 0, 0, 30)
    const start = state.position.clone()
    updateShipBody(earth, T0 + 1000)
    carryShip(carry, state, earth, moon, FRAME, earthSpinRate(1))
    expect(state.position.equals(start)).toBe(true)
    const local0 = toLocal(earth, state.position)
    let t = T0 + 1000
    for (const dt of [0, NaN, -1, Infinity]) carryShip(carry, state, earth, moon, dt, earthSpinRate(1))
    t = fly(carry, state, earth, moon, t, 30, -FRAME, 3600)
    for (const v of [state.position, state.velocity]) expect(Number.isFinite(v.x + v.y + v.z)).toBe(true)
    expect(Number.isFinite(carry.kappa)).toBe(true)
    // Hover still held in Earth's frame after time ran backwards.
    expect(toLocal(earth, state.position).distanceTo(local0)).toBeLessThan(1e-9)
    state.position.copy(earth.position)
    fly(carry, state, earth, moon, t, 3, FRAME, 1)
    expect(Number.isFinite(state.position.x + state.position.y + state.position.z)).toBe(true)
    resetFrameCarry(carry)
    expect(carry.carried.length()).toBe(0)
    expect(carry.primed).toBe(false)
  })

  it('reads no air speed for a gripless ship moving with the air (velocity = ω × r), twice it against', () => {
    const { earth, moon } = carriers(T0)
    const carry = createFrameCarry()
    const state = shipOver(earth, 36, -112, 5000)
    carryShip(carry, state, earth, moon, FRAME, earthSpinRate(1))
    carry.kappa = 0
    const omega = new THREE.Vector3(0, 1, 0).applyQuaternion(earth.spin!).multiplyScalar(earthSpinRate(1))
    const withAir = omega.clone().cross(state.position.clone().sub(earth.position))
    const telemetry = createShipTelemetry()
    state.velocity.copy(withAir)
    fillAir(carry, telemetry, state, earth, earthSpinRate(1))
    expect(telemetry.air.speed / withAir.length()).toBeLessThan(1e-12)
    state.velocity.copy(withAir).negate()
    fillAir(carry, telemetry, state, earth, earthSpinRate(1))
    expect(telemetry.air.speed / withAir.length()).toBeCloseTo(2, 12)
  })

  it('turns a part grip the right way past π a frame (1 month/s)', () => {
    const { earth, moon } = carriers(T0)
    const carry = createFrameCarry()
    const scale = 2_592_000
    const state = shipOver(earth, 0, 0, 0.3 / M)
    carryShip(carry, state, earth, moon, FRAME, earthSpinRate(scale))
    carry.kappa = 0.5
    const before = toLocal(earth, state.position)
    // One frame: the spin turns ~3.1 rad; half of it carried, the ship falls behind the ground by the other half.
    updateShipBody(earth, T0 + FRAME * 1000 * scale)
    updateShipBody(moon, T0 + FRAME * 1000 * scale)
    carryShip(carry, state, earth, moon, FRAME, earthSpinRate(scale))
    const after = toLocal(earth, state.position)
    const lag = Math.atan2(after.clone().cross(before).y, after.dot(before) - after.y * before.y)
    const turned = earthSpinRate(scale) * FRAME
    expect(turned).toBeGreaterThan(Math.PI * 0.95)
    expect(lag).toBeCloseTo((1 - carry.kappa) * turned, 2)
  })

  it('turns a part grip by the share of the turn Earth made, not of the turn dt says (a frame whose clock and dt disagree)', () => {
    const { earth, moon } = carriers(T0)
    const carry = createFrameCarry()
    const state = shipOver(earth, 0, 0, 0.3 / M)
    carryShip(carry, state, earth, moon, FRAME, earthSpinRate(3600))
    carry.kappa = 0.999
    const before = toLocal(earth, state.position)
    // The sim moved a frame at 3600x; dt reads 30% long.
    updateShipBody(earth, T0 + FRAME * 1000 * 3600)
    updateShipBody(moon, T0 + FRAME * 1000 * 3600)
    carryShip(carry, state, earth, moon, 1.3 * FRAME, earthSpinRate(3600))
    const after = toLocal(earth, state.position)
    const lag = Math.atan2(after.clone().cross(before).y, after.dot(before) - after.y * before.y)
    expect(lag / ((1 - carry.kappa) * earthSpinRate(3600) * FRAME)).toBeCloseTo(1, 2)
  })

    it('fills the air: the slip, the grip, the density and the dynamic pressure', () => {
    const { earth, moon } = carriers(T0)
    const carry = createFrameCarry()
    const state = shipOver(earth, 0, 0, 10000)
    carryShip(carry, state, earth, moon, FRAME, earthSpinRate(1))
    const telemetry = createShipTelemetry()
    state.velocity.set(0, 0, 0)
    fillAir(carry, telemetry, state, earth, earthSpinRate(1))
    expect(telemetry.air.coupling).toBe(1)
    expect(telemetry.air.speed).toBe(0)
    expect(telemetry.air.density).toBeCloseTo(Math.exp(-10 / SCALE_HEIGHT_KM), 6)
    expect(telemetry.air.dynamicPressure).toBe(0)
    // Gripless, the air slips past at ω × r: 465 m/s at the equator.
    carry.kappa = 0
    fillAir(carry, telemetry, state, earth, earthSpinRate(1))
    const ms = telemetry.air.speed / M
    expect(ms).toBeCloseTo(SIDEREAL_RATE * (6371000 + 10000), -1)
    expect(telemetry.air.dynamicPressure).toBeCloseTo(0.5 * 1.225 * telemetry.air.density * ms * ms, 3)
    expect(MAX_DT).toBe(0.1)
  })

  it('fills the density and dynamic pressure without the carry, as fillAir does', () => {
    const { earth, moon } = carriers(T0)
    const state = shipOver(earth, 0, 0, 10000)
    const telemetry = createShipTelemetry()
    telemetry.air.speed = 0
    fillAirDensity(telemetry, state.position, earth)
    expect(telemetry.air.density).toBeCloseTo(Math.exp(-10 / SCALE_HEIGHT_KM), 6)
    expect(telemetry.air.dynamicPressure).toBe(0)
    telemetry.air.speed = 300 * M
    fillAirDensity(telemetry, state.position, earth)
    expect(telemetry.air.dynamicPressure).toBeCloseTo(0.5 * 1.225 * telemetry.air.density * 300 * 300, 3)
    const carried = createShipTelemetry()
    const carry = createFrameCarry()
    carryShip(carry, state, earth, moon, FRAME, earthSpinRate(1))
    fillAir(carry, carried, state, earth, earthSpinRate(1))
    expect(carried.air.density).toBeCloseTo(Math.exp(-10 / SCALE_HEIGHT_KM), 6)
  })
})
