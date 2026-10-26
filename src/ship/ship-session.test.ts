import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { MainCameraPose } from '../main-camera-session'
import type { CameraFocus, Layout, PanelKey } from '../store'
import { COLLISION_MARGIN } from './flight'
import {
  createShipBodies,
  EARTH_COLLISION_RADIUS,
  EARTH_RADIUS,
  EARTH_SHELL_RADII,
  updateShipBodies,
} from './ship-bodies'
import { FOV_KICK } from './dust'
import { Body } from 'astronomy-engine'
import { FLIGHT_UNITS_PER_AU, flightPlanetPosition } from '../flight-scale'
import {
  enterShipPatch,
  exitShipPatch,
  cameraToShipDistance,
  framingDistance,
  narrowHalfFov,
  persistedView,
  SHIP_FAR,
  SHIP_FOV,
  SHIP_STAR_RADIUS,
  SYSTEM_REACH,
  shellGap,
  shipFar,
  shipNear,
  shipNearFloor,
  NEAR_MIN,
  NEAR_MIN_REVERSED,
  SPAWN_EARTH_SHARE,
  SPAWN_MIN_DISTANCE,
  SPAWN_MOON_GAP,
  spawnPose,
  spawnPoseFromCamera,
  type ShipSessionState,
} from './ship-session'
import type { ShipState, Body as FlightBody } from './flight'

// The store also holds a pending date jump, which entry clears.
type View = ShipSessionState & { jumpDate: Date | null }

function view(overrides: Partial<View> = {}): View {
  return {
    jumpDate: null,
    layout: 'triple',
    mainPanel: 'main',
    cameraFocus: 'clock',
    timeScale: 1,
    showPlanets: false,
    shipMode: false,
    shipSaved: null,
    ...overrides,
  }
}

// Applies a patch as zustand's set would: a shallow merge.
function apply<S extends object>(s: S, patch: object | null): S {
  return patch ? { ...s, ...patch } : s
}

const VIEWS: View[] = []
for (const layout of ['single', 'triple'] as Layout[]) {
  for (const mainPanel of ['main', 'top', 'bottom'] as PanelKey[]) {
    VIEWS.push(view({ layout, mainPanel }))
  }
}
VIEWS.push(
  view({ showPlanets: false, cameraFocus: 'sun' }),
  view({ showPlanets: true, cameraFocus: 'saturn' as CameraFocus }),
  view({ timeScale: 0, cameraFocus: 'moon' }),
  view({ timeScale: 86400, layout: 'single', mainPanel: 'bottom' })
)

describe('entering and leaving ship mode', () => {
  it.each(VIEWS)('round-trips %o exactly', (before) => {
    const inShip = apply(before, enterShipPatch(before))
    expect(inShip.shipMode).toBe(true)
    expect(inShip.showPlanets).toBe(true)
    expect(inShip.timeScale).toBe(1)
    const after = apply(inShip, exitShipPatch(inShip))
    expect(after).toEqual(before)
  })

  it('cancels a pending date jump on entry', () => {
    const before = view({ jumpDate: new Date(Date.UTC(2030, 0, 1)) })
    expect(apply(before, enterShipPatch(before)).jumpDate).toBeNull()
  })

  it('ignores a second entry, keeping the first save', () => {
    const before = view({ timeScale: 3600, showPlanets: false })
    const inShip = apply(before, enterShipPatch(before))
    expect(enterShipPatch(inShip)).toBeNull()
    expect(apply(inShip, exitShipPatch(inShip))).toEqual(before)
  })

  it('ignores a stray exit', () => {
    expect(exitShipPatch(view())).toBeNull()
  })
})

describe('persistedView', () => {
  it('is the live view outside ship mode', () => {
    const s = view({ timeScale: 3600, layout: 'single', mainPanel: 'top' })
    expect(persistedView(s)).toEqual({
      layout: 'single',
      mainPanel: 'top',
      cameraFocus: 'clock',
      timeScale: 3600,
      showPlanets: false,
    })
  })

  it('is the saved view, not the forced one, in ship mode', () => {
    const before = view({ timeScale: 86400, showPlanets: false })
    const inShip = apply(before, enterShipPatch(before))
    expect(persistedView(inShip)).toEqual(persistedView(before))
  })
})

describe('spawnPose', () => {
  // A year in 11-day steps, so the Moon and the inner planets come round,
  // on a laptop and on a 390 × 844 portrait phone.
  const times = Array.from({ length: 34 }, (_, i) => Date.UTC(2026, 0, 1) + i * 11 * 86_400_000)
  const ASPECTS = { laptop: 16 / 9, phone: 390 / 844 }
  const cases = times.flatMap((t) =>
    Object.entries(ASPECTS).map(([screen, aspect]) => ({ t, screen, aspect }))
  )

  function spawnAt(t: number, aspect: number) {
    const bodies = createShipBodies()
    updateShipBodies(bodies, t)
    const byKey = (key: string) => bodies.find((b) => b.key === key)!
    return { bodies, sun: byKey('sun'), earth: byKey('earth'), moon: byKey('moon'), ship: spawnPose(bodies, aspect) }
  }

  const gap = (ship: ShipState, body: FlightBody) =>
    ship.position.distanceTo(body.position) - body.radius
  const nose = (ship: ShipState) => new THREE.Vector3(0, 0, -1).applyQuaternion(ship.orientation)
  // Angle off the view axis of a body's far edge, radians.
  const edgeOffAxis = (ship: ShipState, body: FlightBody) => {
    const to = body.position.clone().sub(ship.position)
    return nose(ship).angleTo(to) + Math.asin(body.radius / to.length())
  }

  it.each(cases)('frames Earth from its day side, nearest bar the Moon ($screen, $t)', ({ t, aspect }) => {
    const { bodies, sun, earth, moon, ship } = spawnAt(t, aspect)

    const fromEarth = ship.position.distanceTo(earth.position)
    expect(fromEarth).toBeGreaterThanOrEqual(SPAWN_MIN_DISTANCE - 1e-9)
    expect(fromEarth).toBeLessThanOrEqual(framingDistance(earth.radius, aspect) + 1e-9)
    // Earth whole in frame and filling about SPAWN_EARTH_SHARE of the short side.
    const half = narrowHalfFov(aspect)
    expect(edgeOffAxis(ship, earth)).toBeLessThan(half)
    const share = earth.radius / (fromEarth * Math.tan(half))
    expect(share).toBeGreaterThanOrEqual(SPAWN_EARTH_SHARE - 1e-9)
    expect(share).toBeLessThan(0.65)

    // Day side, off the Sun line (a terminator shows) and above the ecliptic.
    const toShip = ship.position.clone().sub(earth.position)
    const toSun = sun.position.clone().sub(earth.position)
    expect(toShip.angleTo(toSun)).toBeGreaterThan((25 * Math.PI) / 180)
    expect(toShip.angleTo(toSun)).toBeLessThan((70 * Math.PI) / 180)
    expect(ship.position.y - earth.position.y).toBeGreaterThan(3)

    // Earth sets the cruise cap: only the Moon may be nearer, and not too near.
    for (const body of bodies) {
      if (body === earth) continue
      if (body === moon) expect(gap(ship, moon)).toBeGreaterThanOrEqual(SPAWN_MOON_GAP)
      else expect(gap(ship, body)).toBeGreaterThanOrEqual(gap(ship, earth))
    }

    expect(ship.velocity.length()).toBe(0)
    expect(ship.angularVelocity.length()).toBe(0)
  })

  it('brings the Moon into frame on most days', () => {
    for (const aspect of Object.values(ASPECTS)) {
      const framed = times.filter((t) => {
        const { moon, ship } = spawnAt(t, aspect)
        return edgeOffAxis(ship, moon) < narrowHalfFov(aspect)
      })
      expect(framed.length / times.length).toBeGreaterThan(0.5)
    }
  })

  it('stands further off on a narrow screen', () => {
    const t = Date.UTC(2026, 9, 22)
    const laptop = spawnAt(t, ASPECTS.laptop)
    const phone = spawnAt(t, ASPECTS.phone)
    expect(phone.ship.position.distanceTo(phone.earth.position)).toBeGreaterThan(
      laptop.ship.position.distanceTo(laptop.earth.position) * 1.5
    )
  })

  it('keeps the ship level (up toward ecliptic north)', () => {
    const { ship } = spawnAt(Date.UTC(2026, 9, 22), ASPECTS.laptop)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(ship.orientation)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(ship.orientation)
    expect(right.y).toBeCloseTo(0, 9)
    expect(up.y).toBeGreaterThan(0)
  })

  // Holds by distance at the flight scale (Venus stays ≥ ~260 units off);
  // kept as a guard should the scale shrink. The crowding fallback itself is
  // exercised by the next test.
  it('keeps Venus further than Earth at its October 2026 inferior conjunction', () => {
    for (const aspect of Object.values(ASPECTS)) {
      const { bodies, earth, ship } = spawnAt(Date.UTC(2026, 9, 24), aspect)
      const venus = bodies.find((b) => b.key === 'venus')!
      expect(gap(ship, venus)).toBeGreaterThanOrEqual(gap(ship, earth))
    }
  })

  it('moves off when a body sits on the spawn point', () => {
    const { bodies, earth, ship: free } = spawnAt(Date.UTC(2026, 9, 22), ASPECTS.laptop)
    const venus = bodies.find((b) => b.key === 'venus')!
    venus.position.copy(free.position)
    const moved = spawnPose(bodies, ASPECTS.laptop)
    expect(gap(moved, venus)).toBeGreaterThanOrEqual(gap(moved, earth))
  })
})

describe('spawning from the main camera', () => {
  const target: [number, number, number] = [10, -4, 7]
  const eye: [number, number, number] = [34, 8, 39]
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(new THREE.Vector3(...eye), new THREE.Vector3(...target), new THREE.Vector3(0, 1, 0))
  ).toArray() as [number, number, number, number]
  const shared = { position: eye, target, quaternion, up: [0, 1, 0] as [number, number, number] }
  const perspective: MainCameraPose = { ...shared, projection: 'perspective', fov: 30, zoom: 1 }
  const orthographic: MainCameraPose = { ...shared, projection: 'orthographic', visibleHeight: 20, zoom: 2 }
  const tanHalf = (fov: number) => Math.tan((fov * Math.PI) / 360)
  const screenRadius = (radius: number, distance: number, fov: number) =>
    radius / (Math.sqrt(distance ** 2 - radius ** 2) * tanHalf(fov))

  it('matches a perspective dolly with a different source FOV and body radius', () => {
    const sourceDistance = new THREE.Vector3(...eye).distanceTo(new THREE.Vector3(...target))
    const shipDistance = cameraToShipDistance(perspective, 2, 4)!
    expect(screenRadius(4, shipDistance, SHIP_FOV)).toBeCloseTo(
      screenRadius(2, sourceDistance, perspective.fov), 12
    )
  })

  it('maps orthographic zoom by visible height rather than eye distance', () => {
    const shipDistance = cameraToShipDistance(orthographic, 2, 3)!
    expect(screenRadius(3, shipDistance, SHIP_FOV)).toBeCloseTo(
      2 * 2 / (orthographic.visibleHeight / orthographic.zoom), 12
    )
    expect(cameraToShipDistance({ ...orthographic, position: [340, 80, 390] }, 2, 3)).toBe(shipDistance)
  })

  it('starts every focused body from the same direction and apparent size', () => {
    const bodies = createShipBodies()
    updateShipBodies(bodies, Date.UTC(2026, 9, 25))
    const direction = new THREE.Vector3(...eye).sub(new THREE.Vector3(...target)).normalize()
    const sourceDistance = new THREE.Vector3(...eye).distanceTo(new THREE.Vector3(...target))
    for (const body of bodies) {
      const ship = spawnPoseFromCamera(perspective, body.key as CameraFocus, bodies)!
      const offset = ship.position.clone().sub(body.position)
      expect(offset.clone().normalize().distanceTo(direction)).toBeLessThan(1e-12)
      expect(screenRadius(body.radius, offset.length(), SHIP_FOV)).toBeCloseTo(
        screenRadius(body.radius, sourceDistance, perspective.fov), 10
      )
      expect(ship.orientation.toArray()).toEqual(quaternion)
      expect(ship.velocity.length()).toBe(0)
    }
  })

  it('keeps a zoomed-out start finite and falls back without a saved camera', () => {
    const bodies = createShipBodies()
    updateShipBodies(bodies, Date.UTC(2026, 9, 25))
    const far: MainCameraPose = { ...perspective, position: [2400, 1200, 3200] }
    const ship = spawnPoseFromCamera(far, 'earth', bodies)!
    const earth = bodies.find((body) => body.key === 'earth')!
    expect(ship.position.distanceTo(earth.position)).toBeGreaterThan(100)
    expect(ship.position.length()).toBeLessThan(SHIP_FAR)
    expect(spawnPoseFromCamera(null, 'earth', bodies)).toBeNull()
  })
})

describe('ship camera range', () => {
  it('keeps the near plane in front of any surface the ship can reach', () => {
    // The closest the ship gets is the collision shell of the smallest body.
    const smallest = Math.min(...createShipBodies().map((b) => b.radius))
    const closest = smallest * (COLLISION_MARGIN - 1)
    for (const gap of [closest, 0.05, 0.5, 1, 10, 100, 1000]) {
      expect(shipNear(gap)).toBeLessThan(gap)
      expect(shipNear(gap)).toBeGreaterThan(0)
    }
  })

  // Depth error is ~z² / (near · 2²⁴): the near plane sets precision and the
  // far plane barely matters, so far/near only needs a loose bound.
  it('bounds the near plane, keeping far/near within 1e6 in the system', () => {
    expect(shipNear(Infinity)).toBe(0.1)
    expect(shipNear(-1)).toBe(0.001)
    expect(SHIP_FAR / shipNear(Infinity)).toBeLessThanOrEqual(1e6)
  })

  // How far the near rectangle's corner is from the eye, per unit of near,
  // at the widest the view gets: the speed kick's FOV on a 21:9 screen.
  const tanHalf = Math.tan(((SHIP_FOV + FOV_KICK) / 2) * (Math.PI / 180))
  const CORNER = Math.hypot(1, tanHalf, tanHalf * (21 / 9))

  it("keeps the near rectangle above the ground at Earth's lowest stop", () => {
    // tides-01v.8 stops the ship this far over the ground drawn under it.
    for (const clearance of [0.003, 0.004]) {
      expect(shipNear(clearance)).toBeCloseTo(0.4 * clearance, 12)
      expect(shipNear(clearance) * CORNER).toBeLessThan(clearance)
    }
  })

  it("keeps the near rectangle off Earth's shells on the way down through them", () => {
    let cut = 0
    for (let d = EARTH_RADIUS + 0.003; d <= EARTH_COLLISION_RADIUS; d += 1e-4) {
      // The ground can be anywhere below: sea level is the furthest.
      const shells = shellGap(d, EARTH_SHELL_RADII)
      // At a shell the floor wins: a hole a near's width across, crossing it.
      if (shells < shipNear(-1) * CORNER) continue
      if (shipNear(d - EARTH_RADIUS, shells) * CORNER >= shells) cut++
    }
    expect(cut).toBe(0)
  })

  it("would cut Earth's atmosphere glow from between its shells going by the ground alone", () => {
    // Between the atmosphere (1.06 R) and the aurora (1.07 R).
    const d = EARTH_RADIUS * 1.065
    const shells = shellGap(d, EARTH_SHELL_RADII)
    expect(shipNear(d - EARTH_RADIUS)).toBeGreaterThan(shells)
    expect(shipNear(d - EARTH_RADIUS, shells) * CORNER).toBeLessThan(shells)
  })

  it('measures the gap to the nearest shell from inside or out', () => {
    expect(shellGap(1, [2, 4])).toBe(1)
    expect(shellGap(3.5, [2, 4])).toBe(0.5)
    expect(shellGap(5, [2, 4])).toBe(1)
    expect(shellGap(5, [])).toBe(Infinity)
  })

  // The GPU clips in float32: z_clip = P[10]·z + P[14] against w = −z. Too
  // small a near rounds the star sphere's z_clip past w and drops it.
  it('keeps the star sphere inside the far plane in float32 at the lowest near', () => {
    const camera = new THREE.PerspectiveCamera(SHIP_FOV, 16 / 10, shipNear(-1), SHIP_FAR)
    const m = new Float32Array(camera.projectionMatrix.elements)
    const z = Math.fround(-SHIP_STAR_RADIUS)
    const clipZ = Math.fround(Math.fround(m[10] * z) + m[14])
    expect(clipZ).toBeLessThan(-z)
  })

  // Under reversed-Z (tides-zmw.9.3) clip z runs w at the near plane to 0 at
  // the far one, and the star sphere's lands ~0.2 · near above 0 rather than
  // rounding into w, so it survives a canyon-scale near; on the standard
  // buffer the same near drops it.
  const starClip = (near: number, reversed: boolean) => {
    const camera = new THREE.PerspectiveCamera(SHIP_FOV, 16 / 10, near, SHIP_FAR)
    // As WebGLRenderer does on a reversed-depth context's first draw.
    Object.assign(camera, { _reversedDepth: reversed })
    camera.updateProjectionMatrix()
    const m = new Float32Array(camera.projectionMatrix.elements)
    const z = Math.fround(-SHIP_STAR_RADIUS)
    return { clipZ: Math.fround(Math.fround(m[10] * z) + m[14]), w: -z }
  }

  it('keeps the star sphere inside the far plane in float32 under reversed-Z at its floor', () => {
    const { clipZ, w } = starClip(shipNearFloor(true), true)
    expect(clipZ).toBeGreaterThan(0)
    expect(clipZ).toBeLessThan(w)
    expect(clipZ).toBeCloseTo((0.2 * NEAR_MIN_REVERSED * SHIP_FAR) / (SHIP_FAR - NEAR_MIN_REVERSED), 12)
    // The negative control: the standard buffer at that near drops it.
    const standard = starClip(NEAR_MIN_REVERSED, false)
    expect(standard.clipZ).toBeGreaterThanOrEqual(standard.w)
  })

  it('floors the near plane at NEAR_MIN unless told the depth is reversed and float', () => {
    expect(shipNearFloor(false)).toBe(NEAR_MIN)
    expect(NEAR_MIN).toBe(0.001)
    expect(shipNearFloor(true)).toBe(NEAR_MIN_REVERSED)
    expect(NEAR_MIN_REVERSED).toBe(1e-6)
    expect(shipNear(-1, Infinity, shipNearFloor(true))).toBe(NEAR_MIN_REVERSED)
    expect(shipNear(1e-4, Infinity, shipNearFloor(true))).toBeCloseTo(4e-5, 15)
    // Above the floor the two agree.
    expect(shipNear(0.004, Infinity, shipNearFloor(true))).toBe(shipNear(0.004))
  })

  // Neptune's furthest from the Sun at the flight scale, 1900–2100.
  const neptuneMax = (() => {
    const at = flightPlanetPosition(Body.Neptune)
    let max = 0
    for (let t = Date.UTC(1900, 0, 1); t < Date.UTC(2100, 0, 1); t += 30 * 86_400_000) {
      max = Math.max(max, Math.hypot(...at(t)))
    }
    return max
  })()

  it('reaches past every body from the Sun', () => {
    expect(neptuneMax / FLIGHT_UNITS_PER_AU).toBeGreaterThan(30.2)
    expect(SYSTEM_REACH).toBeGreaterThan(neptuneMax)
  })

  it('draws the star sphere behind Neptune from anywhere in the system, inside the far plane', () => {
    // A ship SYSTEM_REACH from the Sun on the far side from Neptune.
    expect(SHIP_STAR_RADIUS).toBeGreaterThan(SYSTEM_REACH + neptuneMax)
    expect(SHIP_STAR_RADIUS).toBeLessThan(SHIP_FAR)
  })

  it('moves the far plane out with the ship past the system', () => {
    expect(shipFar(0)).toBe(SHIP_FAR)
    expect(shipFar(SYSTEM_REACH)).toBe(SHIP_FAR)
    // Neptune stays inside from anywhere.
    for (const d of [SHIP_FAR, 1e6, 1e8]) expect(shipFar(d)).toBeGreaterThan(d + neptuneMax)
  })
})
