import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { CameraFocus, Layout, PanelKey } from '../store'
import { COLLISION_MARGIN } from './flight'
import { createShipBodies, updateShipBodies } from './ship-bodies'
import { Body } from 'astronomy-engine'
import { FLIGHT_UNITS_PER_AU, flightPlanetPosition } from '../flight-scale'
import {
  enterShipPatch,
  exitShipPatch,
  framingDistance,
  narrowHalfFov,
  persistedView,
  SHIP_FAR,
  SHIP_STAR_RADIUS,
  SYSTEM_REACH,
  shipFar,
  shipNear,
  SPAWN_EARTH_SHARE,
  SPAWN_MIN_DISTANCE,
  SPAWN_MOON_GAP,
  spawnPose,
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
    expect(shipNear(-1)).toBe(0.002)
    expect(SHIP_FAR / shipNear(Infinity)).toBeLessThanOrEqual(1e6)
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
