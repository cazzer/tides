// Entering and leaving ship mode, as pure store patches, plus where the ship
// starts and the camera range it flies with.

import * as THREE from 'three'
import type { CameraFocus, Layout, PanelKey } from '../store'
import type { MainCameraPose } from '../main-camera-session'
import { collisionRadius, createShipState, type Body as FlightBody, type ShipState } from './flight'
import { FLIGHT_UNITS_PER_AU } from '../flight-scale'

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
 * Past every body from the Sun: Neptune's aphelion is 30.33 AU (flight-scale
 * positions, ship-session.test.ts), so 32 AU leaves a margin.
 */
export const SYSTEM_REACH = 32 * FLIGHT_UNITS_PER_AU
/**
 * The starfield's radius in ship mode. The sphere is centred on the camera,
 * so with the ship anywhere within SYSTEM_REACH of the Sun every body is at
 * most 2·SYSTEM_REACH away and the stars stay behind it.
 */
export const SHIP_STAR_RADIUS = 2 * SYSTEM_REACH
/**
 * Ship camera's far plane within the system, with room for the star sphere,
 * which must sit inside it. Depth precision is set by the near plane (error
 * ~z² / (near · 2²⁴)), so a far this deep costs next to nothing.
 */
export const SHIP_FAR = 1.25 * SHIP_STAR_RADIUS

/**
 * The far plane `distanceFromSun` out. Cruise has no range limit, so beyond
 * the system the plane moves out with the ship and every body stays drawn;
 * the system is a few pixels across by then, so the depth precision this
 * spends doesn't show.
 */
export function shipFar(distanceFromSun: number): number {
  return Math.max(SHIP_FAR, distanceFromSun + SYSTEM_REACH)
}

// The near plane follows the nearest surface so depth precision is spent where
// the eye is: at 0.4 of the gap the surface stays well in front of it, even at
// the near rectangle's corners (up to ~2 near from the eye at the speed kick's
// FOV on a 21:9 screen). The ceiling keeps anything a tenth of a unit off
// drawn (Saturn's rings reach 2.27 radii out; 3bl.6's dust passes within a
// unit). far/near reaches 8e7 at the floor, which is fine: depth error is
// ~z² / (near · 2²⁴), set by the near plane, not the far.
//
// The floor sits under 0.4 × Earth's lowest stop, the ground clearance over
// its terrain (~0.003–0.004, tides-01v.8), so the share still holds there.
// Measured from that stop (tides-01v.8.1), 0.001 cuts nothing, so neither
// reversed-Z nor a log depth buffer is needed. The depth steps there (~0.006
// at the Moon, ~60 at the Sun, ~4000 at Saturn) leave the Moon as drawn at
// 0.1; the Sun's corona needs its strict depth test (SunRenderer), and
// Saturn's rings were already unresolved by depth at 0.1 but are a few pixels
// across from Earth. Just below 0.001 (0.000977), float32 clip maths drops the
// star sphere at the far plane.
const NEAR_SHARE = 0.4
const NEAR_MIN = 0.001
const NEAR_MAX = 0.1

/**
 * The ship camera's near plane `groundDistance` above the nearest body's
 * ground and `shellDistance` from the nearest shell it draws (shellGap).
 */
export function shipNear(groundDistance: number, shellDistance = Infinity): number {
  return THREE.MathUtils.clamp(
    NEAR_SHARE * Math.min(groundDistance, shellDistance),
    NEAR_MIN,
    NEAR_MAX
  )
}

/**
 * How far a point `distance` from a body's centre is from the nearest of its
 * shells of `radii`, from inside or out. Below the outermost shell the ship is
 * nearer a shell than the ground can say, and a near plane set from the
 * ground alone cuts a hole in it.
 */
export function shellGap(distance: number, radii: readonly number[]): number {
  let gap = Infinity
  for (const radius of radii) gap = Math.min(gap, Math.abs(distance - radius))
  return gap
}

const DEG = Math.PI / 180

// Spawn composition: Earth's day side seen from above the ecliptic, so the
// orbit lines open into ellipses, and from off the Sun line, so Earth shows a
// terminator. Earth fills SPAWN_EARTH_SHARE of the screen's short side.
export const SPAWN_EARTH_SHARE = 0.4
export const SPAWN_ELEVATION = 25 * DEG
export const SPAWN_SUN_OFFSET = 30 * DEG
// A crowded spawn climbs by these steps above SPAWN_ELEVATION and is pulled in
// toward Earth no closer than SPAWN_MIN_DISTANCE. Scoring candidates: their
// distance as a share of the framing distance, plus MOON_BONUS for framing
// the Moon, less CLIMB_COST per climb step.
const SPAWN_CLIMB = [0, 10, 20, 30, 40].map((deg) => deg * DEG)
export const SPAWN_MIN_DISTANCE = 8
const SPAWN_DISTANCE_STEP = 0.5
const MOON_BONUS = 0.2
const CLIMB_COST = 0.1
// The Moon may be nearer than Earth, just not on top of the ship.
export const SPAWN_MOON_GAP = 2
// How far off-axis the Moon's centre may sit, as a share of the short side's
// half-angle, and how far the aim may swing off Earth to bring it in (Earth
// stays whole in frame).
const MOON_FRAME = 0.8
const MAX_AIM_SHIFT = 0.4

const WORLD_UP = new THREE.Vector3(0, 1, 0)
const lookMatrix = new THREE.Matrix4()

/** Half-angle, radians, across the short side of a screen of `aspect`. */
export function narrowHalfFov(aspect: number): number {
  return Math.atan(Math.tan((SHIP_FOV / 2) * DEG) * Math.min(1, aspect))
}

/** How far from a body of `radius` it fills SPAWN_EARTH_SHARE of the short side. */
export function framingDistance(radius: number, aspect: number): number {
  return radius / (SPAWN_EARTH_SHARE * Math.tan(narrowHalfFov(aspect)))
}

/** Distance from a flight body that gives it the same screen radius as in the
 * main view. The perspective branch uses the real eye distance; the current
 * orthographic view uses its visible height instead of its arbitrary eye. */
export function cameraToShipDistance(
  pose: MainCameraPose,
  systemRadius: number,
  flightRadius: number
): number | null {
  if (!(systemRadius > 0 && flightRadius > 0 && pose.zoom > 0)) return null
  const shipTan = Math.tan((SHIP_FOV * DEG) / 2)
  const radiusRatio = flightRadius / systemRadius
  let projectedDistance: number
  if (pose.projection === 'orthographic') {
    if (!(pose.visibleHeight > 0)) return null
    projectedDistance = (pose.visibleHeight / pose.zoom) * radiusRatio / (2 * shipTan)
  } else {
    const eyeDistance = new THREE.Vector3(...pose.position).distanceTo(new THREE.Vector3(...pose.target))
    if (!(pose.fov > 0 && pose.fov < 180 && eyeDistance > systemRadius)) return null
    projectedDistance = Math.sqrt(eyeDistance ** 2 - systemRadius ** 2) *
      radiusRatio * Math.tan((pose.fov * DEG) / 2) / (pose.zoom * shipTan)
  }
  const distance = Math.hypot(flightRadius, projectedDistance)
  return Number.isFinite(distance) ? distance : null
}

/** Use the saved main view's eye direction and orientation at the flight
 * scale. Null permits spawnPose for a direct ?ship=1 link with no main view. */
export function spawnPoseFromCamera(
  pose: MainCameraPose | null,
  focus: CameraFocus,
  bodies: readonly FlightBody[]
): ShipState | null {
  if (!pose) return null
  const key = focus === 'clock' || focus === 'location' ? 'earth' : focus
  const body = bodies.find((candidate) => candidate.key === key)
  if (!body) return null
  // The body radii are deliberately identical across system and flight
  // scales (flight-scale.ts); their centres use different spacing.
  const mappedDistance = cameraToShipDistance(pose, body.radius, body.radius)
  if (mappedDistance === null) return null
  const outward = new THREE.Vector3(...pose.position).sub(new THREE.Vector3(...pose.target))
  if (!(outward.lengthSq() > 0) || !Number.isFinite(outward.lengthSq())) return null
  const distance = Math.max(mappedDistance, collisionRadius(body) + 0.01)
  const state = createShipState()
  state.position.copy(body.position).addScaledVector(outward.normalize(), distance)
  state.orientation.fromArray(pose.quaternion).normalize()
  return state
}

function surfaceGap(position: THREE.Vector3, body: FlightBody): number {
  return position.distanceTo(body.position) - body.radius
}

// Earth must be the nearest body bar the Moon, so the cruise cap and the HUD
// start from it.
function spawnClear(
  position: THREE.Vector3,
  bodies: readonly FlightBody[],
  earth: FlightBody
): boolean {
  const earthGap = surfaceGap(position, earth)
  return bodies.every((body) => {
    if (body === earth) return true
    const gap = surfaceGap(position, body)
    return body.key === 'moon' ? gap >= SPAWN_MOON_GAP : gap >= earthGap
  })
}

interface Aim {
  direction: THREE.Vector3
  moonInFrame: boolean
}

// Look at Earth, swung toward the Moon when that brings it into frame.
function aimFrom(
  position: THREE.Vector3,
  earth: FlightBody,
  moon: FlightBody | undefined,
  halfFov: number
): Aim {
  const toEarth = new THREE.Vector3().subVectors(earth.position, position).normalize()
  if (!moon) return { direction: toEarth, moonInFrame: false }
  const toMoon = new THREE.Vector3().subVectors(moon.position, position).normalize()
  const shift = toEarth.angleTo(toMoon) - MOON_FRAME * halfFov
  if (shift <= 0) return { direction: toEarth, moonInFrame: true }
  if (shift > MAX_AIM_SHIFT * halfFov) return { direction: toEarth, moonInFrame: false }
  const axis = new THREE.Vector3().crossVectors(toEarth, toMoon).normalize()
  return { direction: toEarth.applyAxisAngle(axis, shift), moonInFrame: true }
}

interface Spawn {
  position: THREE.Vector3
  aim: Aim
  score: number
}

/**
 * Where the ship starts, at rest: on Earth's day side, SPAWN_SUN_OFFSET off
 * the Sun line and SPAWN_ELEVATION above the ecliptic, far enough for Earth
 * to fill SPAWN_EARTH_SHARE of the short side of a screen of `aspect`. No
 * other body (bar the Moon) may be nearer than Earth, so when one crowds
 * that point it tries the other side of the
 * Sun line, climbing higher and pulling in toward Earth, and takes the
 * candidate that stays furthest out, frames the Moon and climbs least. Faces
 * Earth, swung toward the Moon when that brings it into frame, and level.
 * (At the flight scale no planet comes within ~260 units of Earth, so with
 * the real ephemeris the first candidate is always clear; the fallback is
 * for a body placed closer.) `bodies` must include 'sun' and 'earth',
 * positioned for now.
 */
export function spawnPose(bodies: readonly FlightBody[], aspect = 16 / 9): ShipState {
  const sun = bodies.find((b) => b.key === 'sun')
  const earth = bodies.find((b) => b.key === 'earth')
  if (!sun || !earth) throw new Error('spawnPose needs the Sun and Earth')
  const moon = bodies.find((b) => b.key === 'moon')
  const halfFov = narrowHalfFov(aspect)

  const toSun = new THREE.Vector3().subVectors(sun.position, earth.position)
  toSun.y = 0
  toSun.normalize()
  const framing = Math.max(SPAWN_MIN_DISTANCE, framingDistance(earth.radius, aspect))

  let best: Spawn | null = null
  for (const [step, climb] of SPAWN_CLIMB.entries()) {
    for (const side of [1, -1]) {
      const elevation = SPAWN_ELEVATION + climb
      const outward = toSun
        .clone()
        .applyAxisAngle(WORLD_UP, side * SPAWN_SUN_OFFSET)
        .multiplyScalar(Math.cos(elevation))
        .addScaledVector(WORLD_UP, Math.sin(elevation))
      for (let d = framing; d >= SPAWN_MIN_DISTANCE; d -= SPAWN_DISTANCE_STEP) {
        const position = earth.position.clone().addScaledVector(outward, d)
        if (!spawnClear(position, bodies, earth)) continue
        const aim = aimFrom(position, earth, moon, halfFov)
        const score =
          d / framing + (aim.moonInFrame ? MOON_BONUS : 0) - step * CLIMB_COST
        if (!best || score > best.score) best = { position, aim, score }
        break
      }
    }
  }
  // Nothing clear (never seen with the real ephemeris): the first choice.
  if (!best) {
    const position = earth.position
      .clone()
      .addScaledVector(toSun.applyAxisAngle(WORLD_UP, SPAWN_SUN_OFFSET), framing)
    best = { position, aim: aimFrom(position, earth, moon, halfFov), score: 0 }
  }

  const state = createShipState()
  state.position.copy(best.position)
  // Matrix4.lookAt points +Z from the target to the eye, so −Z (the nose)
  // faces along the aim.
  lookMatrix.lookAt(state.position, state.position.clone().add(best.aim.direction), WORLD_UP)
  state.orientation.setFromRotationMatrix(lookMatrix)
  return state
}
