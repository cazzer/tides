import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { CameraFocus, Layout, PanelKey } from '../store'
import { COLLISION_MARGIN } from './flight'
import { createShipBodies, updateShipBodies } from './ship-bodies'
import {
  enterShipPatch,
  exitShipPatch,
  persistedView,
  SHIP_FAR,
  SHIP_STAR_RADIUS,
  shipNear,
  spawnPose,
  type ShipSessionState,
} from './ship-session'

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
  // A year in 11-day steps, so the Moon and the inner planets come round.
  const times = Array.from({ length: 34 }, (_, i) => Date.UTC(2026, 0, 1) + i * 11 * 86_400_000)

  it.each(times)('starts by Earth on the Sun side, facing Earth, clear of everything (%i)', (t) => {
    const bodies = createShipBodies()
    updateShipBodies(bodies, t)
    const [sun, earth] = bodies
    const ship = spawnPose(bodies)

    const fromEarth = ship.position.distanceTo(earth.position)
    expect(fromEarth).toBeGreaterThan(14)
    expect(fromEarth).toBeLessThan(25)
    expect(ship.position.distanceTo(sun.position)).toBeLessThan(
      earth.position.distanceTo(sun.position)
    )

    const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.orientation)
    const toEarth = earth.position.clone().sub(ship.position).normalize()
    expect(nose.dot(toEarth)).toBeGreaterThan(0.99)

    for (const body of bodies) {
      expect(ship.position.distanceTo(body.position)).toBeGreaterThan(
        body.radius * COLLISION_MARGIN
      )
    }
    expect(ship.velocity.length()).toBe(0)
    expect(ship.angularVelocity.length()).toBe(0)
  })

  it('keeps the ship level (up toward ecliptic north)', () => {
    const bodies = createShipBodies()
    updateShipBodies(bodies, Date.UTC(2026, 9, 22))
    const ship = spawnPose(bodies)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(ship.orientation)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(ship.orientation)
    expect(right.y).toBeCloseTo(0, 9)
    expect(up.y).toBeGreaterThan(0.9)
  })

  it('climbs off the ecliptic when a body crowds the spawn point', () => {
    const bodies = createShipBodies()
    updateShipBodies(bodies, Date.UTC(2026, 9, 22))
    const [sun, earth] = bodies
    const venus = bodies.find((b) => b.key === 'venus')!
    const toSun = sun.position.clone().sub(earth.position).normalize()
    venus.position.copy(earth.position).addScaledVector(toSun, 15)
    const ship = spawnPose(bodies)
    expect(ship.position.distanceTo(venus.position)).toBeGreaterThanOrEqual(
      1.5 * venus.radius
    )
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

  it('bounds the near plane', () => {
    expect(shipNear(Infinity)).toBe(1)
    expect(shipNear(-1)).toBe(0.002)
  })

  it('draws the star sphere inside the far plane', () => {
    expect(SHIP_STAR_RADIUS).toBeLessThan(SHIP_FAR)
  })
})
