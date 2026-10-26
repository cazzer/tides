// Earth's floor over the streamed tiles (tides-zmw.9.8): ship-bodies.ts'
// earthStop against a fake surface-ground sampler, its settling as tiles
// change under the ship, the near plane's gap, and flights over fake
// Everest and Grand Canyon tile ground.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { applyBodyTransform } from '../body-transform'
import { earthSpin, earthTilt } from '../ephemeris'
import { latLonToLocal } from '../aurora'
import { earthLatLon, setSurfaceGroundSampler, type SurfaceGroundSampler } from '../surface-ground'
import { setTerrainEye, surfaceOpacityUniform, terrainScaleUniform } from '../terrain-scale'
import { collisionRadius, createShipState, floorRadius, settleShip, stepShip, type ShipState } from './flight'
import type { ShipInput } from './ship-input'
import {
  EARTH_FLOOR_REACH,
  EARTH_GROUND_CLEARANCE,
  EARTH_HARD_CLEARANCE,
  EARTH_RADIUS,
  EARTH_UNITS_PER_METRE,
  FINE_GROUND_CLEARANCE,
  FINE_HARD_CLEARANCE,
  GROUND_DROP_TAU,
  GROUND_RISE_TAU,
  SURFACE_GROUND_MARGIN_METRES,
  createShipBodies,
  earthClearance,
  floorReach,
  updateShipBodies,
  updateShipBody,
  type ShipBody,
} from './ship-bodies'
import { NEAR_CORNER_REACH, NEAR_MIN, NEAR_MIN_REVERSED, NEAR_SHARE, SHIP_FOV, shipNear } from './ship-session'
import { EARTH_BASE_SEGMENTS, TERRAIN_MAP_SIZE, buildTerrainFloor, setEarthTerrain } from './terrain-floor'

const T = Date.UTC(2026, 9, 22, 12)
const M = EARTH_UNITS_PER_METRE
const SEA_R = 6371000
const DEG = Math.PI / 180

// A cone field, metres: the highest of a base and cones falling `slope`
// metres per metre from their apexes, whose highest over a disc is exact.
interface Cone {
  lat: number
  lon: number
  height: number
  slope: number
}

function arc(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const s = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2
  return 2 * SEA_R * Math.asin(Math.min(1, Math.sqrt(s)))
}

class ConeField implements SurfaceGroundSampler {
  covered = true
  radii: number[] = []
  constructor(
    public base: number,
    public cones: Cone[] = []
  ) {}
  /** Metres at (lat, lon) radians. */
  at(lat: number, lon: number, radius = 0): number {
    let top = this.base
    for (const c of this.cones) top = Math.max(top, c.height - c.slope * Math.max(0, arc(lat, lon, c.lat, c.lon) - radius))
    return top
  }
  maxElevation(lat: number, lon: number, radiusM: number) {
    this.radii.push(radiusM)
    return { metres: this.at(lat, lon, radiusM), covered: this.covered }
  }
}

// Earth's frame at T, both ways.
const frame = new THREE.Object3D()
applyBodyTransform(frame, { tiltAt: earthTilt, spinAt: earthSpin }, T)
const toWorld = (local: THREE.Vector3) => local.clone().applyQuaternion(frame.quaternion)
const toLocal = (world: THREE.Vector3) => world.clone().applyQuaternion(frame.quaternion.clone().invert())

function earthBody(): ShipBody {
  const bodies = createShipBodies('high')
  updateShipBodies(bodies, T)
  return bodies.find((b) => b.key === 'earth')!
}

// The ground drawn under a world point: the tile field at its lat/lon on the live scale.
function drawnRadius(earth: ShipBody, field: ConeField, point: THREE.Vector3): number {
  const [lat, lon] = earthLatLon(toLocal(point.clone().sub(earth.position)).normalize())
  return EARTH_RADIUS + field.at(lat, lon) * terrainScaleUniform.value * M
}

const still: ShipInput = { throttle: 0, strafeX: 0, strafeY: 0, pitch: 0, yaw: 0, roll: 0, level: false, flightAssist: true }

// One frame as ShipController runs it, `change` standing in for the tiles' update.
function frameOf(state: ShipState, earth: ShipBody, dt: number, input: ShipInput = still, change?: () => void, fine = true) {
  const env = { bodies: [earth], targetKey: null }
  earth.floor!.beginFrame(fine)
  stepShip(state, input, dt, env)
  earth.floor!.mark(state.position)
  change?.()
  earth.floor!.settle(dt)
  settleShip(state, env)
  earth.floor!.mark(state.position)
}

// The ship at rest on the floor over (lat, lon) degrees.
function shipAt(earth: ShipBody, lat: number, lon: number, extra = 0): ShipState {
  const dir = toWorld(latLonToLocal(lat, lon))
  const state = createShipState()
  state.position.copy(earth.position).addScaledVector(dir, floorRadius(earth, dir) + extra)
  return state
}

const last = (a: number[]) => a[a.length - 1]

const radius = (earth: ShipBody, state: ShipState) => state.position.distanceTo(earth.position)

describe("Earth's floor over the surface tiles (tides-zmw.9.8)", () => {
  beforeEach(() => {
    // A sea-level globe, so the tiles stand above it unless a test says otherwise.
    const [width, height] = TERRAIN_MAP_SIZE
    setEarthTerrain(buildTerrainFloor({ width, height, data: new Float32Array(width * height) }, EARTH_BASE_SEGMENTS))
    terrainScaleUniform.value = 1
    surfaceOpacityUniform.value = 1
  })
  afterEach(() => {
    setSurfaceGroundSampler(null)
    setEarthTerrain(null)
    setTerrainEye(Infinity)
  })

  it('sets the clearances by the depth buffer: true scale on reversed-Z float, today’s on the standard one', () => {
    expect(FINE_GROUND_CLEARANCE / M).toBeCloseTo(30, 9)
    expect(FINE_HARD_CLEARANCE / M).toBeCloseTo(10, 9)
    expect(NEAR_SHARE * FINE_HARD_CLEARANCE).toBeGreaterThanOrEqual(NEAR_MIN_REVERSED)
    expect(NEAR_SHARE * EARTH_HARD_CLEARANCE).toBeCloseTo(NEAR_MIN, 15)
    expect(earthClearance(false)).toEqual({ soft: EARTH_GROUND_CLEARANCE, hard: EARTH_HARD_CLEARANCE, reach: EARTH_FLOOR_REACH })
    expect(earthClearance(true).reach).toBeCloseTo(NEAR_CORNER_REACH * NEAR_SHARE * FINE_GROUND_CLEARANCE, 15)
    // The window reaches the near rectangle's corners at a 32:9 screen.
    const half = Math.tan((SHIP_FOV / 2) * DEG)
    expect(NEAR_CORNER_REACH).toBeCloseTo(Math.hypot(1, half, half * (32 / 9)), 12)
    expect(EARTH_FLOOR_REACH).toBe(floorReach(EARTH_GROUND_CLEARANCE))
    expect(EARTH_FLOOR_REACH).toBeCloseTo(shipNear(EARTH_GROUND_CLEARANCE) * NEAR_CORNER_REACH, 15)
  })

  it('reads the globe alone where the tiles draw nothing, and the tiles where they cover the window', () => {
    const earth = earthBody()
    const dir = toWorld(latLonToLocal(36.1, -112.1))
    const globe = earth.ground!(dir)
    const field = new ConeField(2100)
    setSurfaceGroundSampler(field)
    // Above the blend's top: no tiles drawn.
    surfaceOpacityUniform.value = 0
    expect(earth.ground!(dir)).toBeCloseTo(globe, 12)
    surfaceOpacityUniform.value = 1
    terrainScaleUniform.value = 2.5
    const tile = EARTH_RADIUS + (2100 + SURFACE_GROUND_MARGIN_METRES) * 2.5 * M
    expect(earth.ground!(dir)).toBeCloseTo(tile, 12)
    // Under the globe there (sea level): the tiles win the max too.
    surfaceOpacityUniform.value = 0.5
    expect(earth.ground!(dir)).toBeCloseTo(tile, 12)
    // A globe over the tiles: in the dissolve or off the tiles' cover it shows, so the max.
    setEarthTerrain(null) // the 9 km fallback, at the full relief
    const fallback = earth.ground!(dir)
    setSurfaceGroundSampler(null)
    expect(earth.ground!(dir)).toBe(fallback)
    setSurfaceGroundSampler(field)
    expect(earth.ground!(dir)).toBe(fallback)
    surfaceOpacityUniform.value = 1
    field.covered = false
    expect(earth.ground!(dir)).toBe(fallback)
    field.covered = true
    expect(earth.ground!(dir)).toBeCloseTo(tile, 12)
  })

  it("takes the window from the depth buffer's clearance", () => {
    const earth = earthBody()
    const field = new ConeField(100)
    setSurfaceGroundSampler(field)
    const dir = toWorld(latLonToLocal(10, 10))
    earth.floor!.beginFrame(false)
    earth.ground!(dir)
    expect(last(field.radii) * M).toBeCloseTo(EARTH_FLOOR_REACH, 12)
    expect(collisionRadius(earth)).toBeCloseTo(EARTH_RADIUS + EARTH_HARD_CLEARANCE, 15)
    expect(floorRadius(earth, dir)).toBeCloseTo(earth.ground!(dir) + EARTH_GROUND_CLEARANCE, 15)
    earth.floor!.beginFrame(true)
    earth.ground!(dir)
    expect(last(field.radii)).toBeCloseTo(earthClearance(true).reach / M, 6)
    expect(last(field.radii)).toBeLessThan(30)
    expect(collisionRadius(earth)).toBeCloseTo(EARTH_RADIUS + FINE_HARD_CLEARANCE, 15)
    expect(floorRadius(earth, dir)).toBeCloseTo(earth.ground!(dir) + FINE_GROUND_CLEARANCE, 15)
    // An explicit reach (the near plane's wider window).
    earth.ground!(dir, 0.001)
    expect(last(field.radii) * M).toBeCloseTo(0.001, 12)
  })

  describe('settling as tiles change under a still ship', () => {
    const dt = 1 / 60
    function setup(base = 500) {
      const earth = earthBody()
      const field = new ConeField(base)
      setSurfaceGroundSampler(field)
      earth.floor!.beginFrame(true)
      const state = shipAt(earth, 36.1, -112.1)
      return { earth, field, state }
    }
    const raw = (metres: number) => EARTH_RADIUS + (metres + SURFACE_GROUND_MARGIN_METRES) * M

    it('holds the floor where ground fell, then lowers it no faster than its e-fold', () => {
      const { earth, field, state } = setup()
      const dir = state.position.clone().sub(earth.position).normalize()
      const before = radius(earth, state)
      frameOf(state, earth, dt, still, () => (field.base = 200))
      expect(radius(earth, state)).toBeCloseTo(before, 12)
      expect(floorRadius(earth, dir)).toBeCloseTo(before, 12)
      expect(earth.floor!.lift / M).toBeCloseTo(300, 6)
      let floor = floorRadius(earth, dir)
      for (let k = 0; k < 300; k++) {
        const lift = earth.floor!.lift
        frameOf(state, earth, dt)
        const next = floorRadius(earth, dir)
        expect(floor - next).toBeLessThanOrEqual(lift * (1 - Math.exp(-dt / GROUND_DROP_TAU)) + 1e-12)
        expect(next).toBeLessThanOrEqual(floor)
        floor = next
      }
      // Five seconds on: within a few metres of the settled stop.
      expect((floor - raw(200) - FINE_GROUND_CLEARANCE) / M).toBeLessThan(300 * Math.exp(-4.9) + 1e-6)
    })

    it('leaves the ship where it is for a rise within the clearance, then lifts it gently', () => {
      const { earth, field, state } = setup()
      const before = radius(earth, state)
      frameOf(state, earth, dt, still, () => (field.base = 510))
      expect(radius(earth, state)).toBeCloseTo(before, 12)
      expect(earth.groundClearance! / M).toBeCloseTo(20, 6)
      expect(radius(earth, state) - raw(510)).toBeGreaterThanOrEqual(FINE_HARD_CLEARANCE)
      let last = radius(earth, state)
      for (let k = 0; k < 120; k++) {
        frameOf(state, earth, dt)
        const r = radius(earth, state)
        // Up, and never by more than the e-fold allows.
        expect(r).toBeGreaterThanOrEqual(last - 1e-12)
        expect(r - last).toBeLessThanOrEqual(10 * M * (1 - Math.exp(-dt / GROUND_RISE_TAU)) + 1e-12)
        last = r
      }
      expect((last - raw(510) - FINE_GROUND_CLEARANCE) / M).toBeGreaterThan(-0.05)
    })

    it('snaps to exactly the hard clearance for a rise beyond it', () => {
      const { earth, field, state } = setup()
      frameOf(state, earth, dt, still, () => (field.base = 600))
      expect(radius(earth, state)).toBeCloseTo(raw(600) + FINE_HARD_CLEARANCE, 12)
      expect(earth.floor!.lift).toBeCloseTo(FINE_HARD_CLEARANCE - FINE_GROUND_CLEARANCE, 15)
    })

    it('takes in what changes between frames too (the dissolve ending), but not the scale the altitude sets', () => {
      const { earth, state } = setup()
      // A globe standing over the tiles there, which the floor takes in the dissolve.
      const [width, height] = TERRAIN_MAP_SIZE
      setEarthTerrain(buildTerrainFloor({ width, height, data: new Float32Array(width * height).fill(40) }, EARTH_BASE_SEGMENTS))
      surfaceOpacityUniform.value = 0.9
      const dir = state.position.clone().sub(earth.position).normalize()
      frameOf(state, earth, dt)
      frameOf(state, earth, dt)
      const before = floorRadius(earth, dir)
      expect(earth.ground!(dir)).toBeGreaterThan(raw(500))
      // The dissolve ends between frames: the globe drops out of the floor, which holds.
      surfaceOpacityUniform.value = 1
      earth.floor!.beginFrame(true)
      expect(floorRadius(earth, dir)).toBeCloseTo(before, 12)
      expect(earth.floor!.lift).toBeGreaterThan(0)
      // A new scale between frames moves the floor at once, as the ship's altitude does.
      const lift = earth.floor!.lift
      earth.floor!.mark(state.position)
      terrainScaleUniform.value = 1.5
      earth.floor!.beginFrame(true)
      expect(earth.floor!.lift).toBeCloseTo(lift, 15)
    })

    it('holds still on a zero or NaN step, and counts neither the spin nor the ship’s motion as a change', () => {
      const { earth, field, state } = setup()
      frameOf(state, earth, dt, still, () => (field.base = 200))
      const lift = earth.floor!.lift
      frameOf(state, earth, 0)
      frameOf(state, earth, NaN)
      expect(earth.floor!.lift).toBe(lift)
      // Mountains everywhere but under the marked point: a quarter turn of
      // Earth between mark and settle puts other ground under the ship's
      // world position, which must not count.
      const { earth: e2, field: f2, state: s2 } = setup(100)
      f2.cones.push({ lat: 36.1 * DEG, lon: -20 * DEG, height: 5000, slope: 0 })
      e2.floor!.beginFrame(true)
      stepShip(s2, still, dt, { bodies: [e2], targetKey: null })
      e2.floor!.mark(s2.position)
      updateShipBody(e2, T + 6 * 3_600_000)
      e2.floor!.settle(dt)
      expect(e2.floor!.lift).toBe(0)
    })
  })

  it('keeps every point of the near rectangle off the ground, over random cliffs and views up to 32:9', () => {
    const rand = (() => {
      let s = 12345
      return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
    })()
    const [lat0, lon0] = [36.1 * DEG, -112.1 * DEG]
    for (let trial = 0; trial < 60; trial++) {
      // Walls and spires within a few hundred metres, as steep as 5:1.
      const cones: Cone[] = []
      for (let k = 0; k < 6; k++) {
        cones.push({
          lat: lat0 + ((rand() - 0.5) * 600) / SEA_R,
          lon: lon0 + ((rand() - 0.5) * 600) / (SEA_R * Math.cos(lat0)),
          height: 1500 + 1200 * rand(),
          slope: 0.2 + 5 * rand(),
        })
      }
      const field = new ConeField(1200 + 200 * rand(), cones)
      const earth = earthBody()
      setSurfaceGroundSampler(field)
      terrainScaleUniform.value = 1 + 0.2 * rand()
      earth.floor!.beginFrame(true)
      const lat = lat0 / DEG + ((rand() - 0.5) * 400) / 111000
      const lon = lon0 / DEG + ((rand() - 0.5) * 400) / 90000
      // At the stop, at the hard stop, or a little above.
      const state = shipAt(earth, lat, lon, trial % 3 === 2 ? 200 * M * rand() : 0)
      if (trial % 3 === 1) {
        // At the hard stop, where tiles rising past the give leave the ship.
        earth.floor!.mark(state.position)
        const top = field.at(lat * DEG, lon * DEG, earthClearance(true).reach / M)
        field.cones.push({ lat: lat * DEG, lon: lon * DEG, height: top + 25, slope: 0 })
        earth.floor!.settle(0)
        settleShip(state, { bodies: [earth] })
        expect(earth.groundClearance).toBeCloseTo(FINE_HARD_CLEARANCE, 15)
      }
      const near = shipNear(earth.floor!.nearGap(state.position), Infinity, NEAR_MIN_REVERSED)
      expect(near).toBeGreaterThanOrEqual(NEAR_SHARE * FINE_HARD_CLEARANCE - 1e-15)
      for (let view = 0; view < 20; view++) {
        const aspect = [390 / 844, 16 / 9, 21 / 9, 32 / 9][view % 4]
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(2 * Math.PI * rand(), 2 * Math.PI * rand(), 2 * Math.PI * rand()))
        const halfH = near * Math.tan((SHIP_FOV / 2) * DEG)
        const halfW = halfH * aspect
        for (let i = 0; i <= 8; i++) {
          for (let j = 0; j <= 8; j++) {
            const p = new THREE.Vector3(halfW * (i / 4 - 1), halfH * (j / 4 - 1), -near).applyQuaternion(q).add(state.position)
            expect(p.distanceTo(earth.position)).toBeGreaterThan(drawnRadius(earth, field, p))
          }
        }
      }
    }
  })

  it.each([
    // A gorge 1500 m under rims at 2100 m, 1.6 km apart; a 8849 m spire with a cliff past it.
    ['the Grand Canyon', 36.1, -112.1, 600, [[800, 2100, 3], [-800, 2100, 3]]],
    ['Everest', 27.99, 86.93, 5000, [[0, 8849, 1.2], [2000, 5300, 4]]],
  ] as [string, number, number, number, [number, number, number][]][])(
    'flies down to the true-scale stop over %s and across it, always the hard clearance over the ground drawn, tiles changing mid-frame',
    (_name, lat, lon, base, peaks) => {
      const earth = earthBody()
      const cones = peaks.map(([north, height, slope]) => ({ lat: lat * DEG + north / SEA_R, lon: lon * DEG, height, slope }))
      const field = new ConeField(base, cones)
      setSurfaceGroundSampler(field)
      const top = Math.max(base, ...peaks.map((p) => p[1]))
      // 1.5 km south and 2 km over the highest ground, nose north and 45° down.
      const dir = toWorld(latLonToLocal(lat - 1500 / 111000, lon))
      const state = createShipState()
      state.position.copy(earth.position).addScaledVector(dir, EARTH_RADIUS + (top + 2000) * M)
      const north = toWorld(new THREE.Vector3(0, 1, 0)).projectOnPlane(dir).normalize()
      const fwd = north.clone().multiplyScalar(Math.SQRT1_2).addScaledVector(dir, -Math.SQRT1_2)
      // A camera looks down its -Z, the ship's nose.
      const look = new THREE.PerspectiveCamera()
      look.position.copy(state.position)
      look.up.copy(dir)
      look.lookAt(state.position.clone().add(fwd))
      state.orientation.copy(look.quaternion)
      const input: ShipInput = { ...still, throttle: 0.02 }
      let lowest = Infinity
      for (let k = 0; k < 2400; k++) {
        setTerrainEye(radius(earth, state) - EARTH_RADIUS, true)
        // Every 37th frame the tiles change under the ship as it settles.
        const change = k % 37 === 0 ? () => (field.base += k % 74 === 0 ? 15 : -20) : undefined
        frameOf(state, earth, 1 / 60, input, change)
        const gap = radius(earth, state) - drawnRadius(earth, field, state.position)
        lowest = Math.min(lowest, gap)
        expect(gap).toBeGreaterThanOrEqual(FINE_HARD_CLEARANCE - 1e-12)
      }
      // It got down there: under 100 m true over the ground drawn, nearly at true scale.
      expect(lowest / M).toBeLessThan(100)
      expect(terrainScaleUniform.value).toBeLessThan(1.1)
    }
  )
})
