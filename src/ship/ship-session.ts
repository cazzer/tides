// Entering and leaving ship mode, as pure store patches, plus where the ship
// starts and the camera range it flies with.

import * as THREE from 'three'
import type { CameraFocus, Layout, PanelKey } from '../store'
import { createShipState, type Body as FlightBody, type ShipState } from './flight'

/** The view state ship mode overrides or hides, put back on exit. */
export interface ShipSaved {
  layout: Layout
  mainPanel: PanelKey
  cameraFocus: CameraFocus
  timeScale: number
  showPlanets: boolean
}

export interface ShipSessionState extends ShipSaved {
  shipMode: boolean
  /** What ShipSaved held on entry; null outside ship mode. */
  shipSaved: ShipSaved | null
}

function pickSaved(s: ShipSaved): ShipSaved {
  return {
    layout: s.layout,
    mainPanel: s.mainPanel,
    cameraFocus: s.cameraFocus,
    timeScale: s.timeScale,
    showPlanets: s.showPlanets,
  }
}

/**
 * The store patch that enters ship mode: every planet on, real-time 1× (a
 * pending date jump cancelled, so it can't race the forced speed). Null when
 * already in ship mode, so a second entry never saves the forced values over
 * the user's own.
 */
export function enterShipPatch(s: ShipSessionState) {
  if (s.shipMode) return null
  return {
    shipMode: true,
    shipSaved: pickSaved(s),
    showPlanets: true,
    timeScale: 1,
    jumpDate: null,
  }
}

/**
 * The store patch that leaves ship mode, putting back everything saved on
 * entry in one go (setShowPlanets would move a planet focus to the Sun).
 * Null outside ship mode.
 */
export function exitShipPatch(s: ShipSessionState) {
  if (!s.shipMode || !s.shipSaved) return null
  return { shipMode: false, shipSaved: null, ...s.shipSaved }
}

/** The view state the URL records: the saved one while ship mode overrides it. */
export function persistedView(s: ShipSessionState): ShipSaved {
  return s.shipSaved ?? pickSaved(s)
}

/** Ship camera's vertical field of view, degrees. */
export const SHIP_FOV = 60
/**
 * Ship camera's far plane. Neptune orbits ~320 units out, so two bodies are at
 * most ~650 apart; the margin is for the star sphere, which must sit inside.
 */
export const SHIP_FAR = 4000
/** The starfield's radius in ship mode (as the main view with planets on). */
export const SHIP_STAR_RADIUS = 1500

// The near plane follows the nearest surface so depth precision is spent where
// the eye is: at 0.4 of the gap the surface stays well in front of it, and the
// floor bounds the far/near ratio (2e6 at worst). The hard-sphere margin
// (flight.ts COLLISION_MARGIN) keeps the gap ≥ 0.02 even at the Moon.
const NEAR_SHARE = 0.4
const NEAR_MIN = 0.002
const NEAR_MAX = 1

/** The ship camera's near plane `surfaceDistance` from the nearest body. */
export function shipNear(surfaceDistance: number): number {
  return THREE.MathUtils.clamp(NEAR_SHARE * surfaceDistance, NEAR_MIN, NEAR_MAX)
}

// Spawn: on Earth's day side, a little above the ecliptic so the Sun isn't
// directly behind and the orbit line isn't edge-on through the middle.
export const SPAWN_DISTANCE = 15
const SPAWN_LIFT = 2
// Clearance from every body, in its radii; Venus' orbit (~35 from the Sun)
// passes close to the spawn point.
const SPAWN_CLEARANCE = 1.5
const SPAWN_STEP = 1
const SPAWN_MAX_STEPS = 50

const WORLD_UP = new THREE.Vector3(0, 1, 0)
const lookMatrix = new THREE.Matrix4()

function crowding(position: THREE.Vector3, bodies: readonly FlightBody[]): boolean {
  return bodies.some(
    (body) => position.distanceTo(body.position) < SPAWN_CLEARANCE * body.radius
  )
}

/**
 * Where the ship starts: SPAWN_DISTANCE from Earth toward the Sun, lifted off
 * the ecliptic (further while any body crowds it), at rest and facing Earth.
 * `bodies` must include 'sun' and 'earth', positioned for now.
 */
export function spawnPose(bodies: readonly FlightBody[]): ShipState {
  const sun = bodies.find((b) => b.key === 'sun')
  const earth = bodies.find((b) => b.key === 'earth')
  if (!sun || !earth) throw new Error('spawnPose needs the Sun and Earth')

  const state = createShipState()
  const toSun = new THREE.Vector3().subVectors(sun.position, earth.position).normalize()
  state.position
    .copy(earth.position)
    .addScaledVector(toSun, SPAWN_DISTANCE)
    .addScaledVector(WORLD_UP, SPAWN_LIFT)
  for (let i = 0; i < SPAWN_MAX_STEPS && crowding(state.position, bodies); i++) {
    state.position.y += SPAWN_STEP
  }
  // Matrix4.lookAt points +Z from the target to the eye, so −Z (the nose)
  // faces Earth.
  lookMatrix.lookAt(state.position, earth.position, WORLD_UP)
  state.orientation.setFromRotationMatrix(lookMatrix)
  return state
}
