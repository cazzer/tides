// The spheres ship mode flies among, built from the ephemeris rather than the
// scene's mesh refs: those only register in the interactive main view and go
// stale when it unmounts, and ship mode replaces that view. Positions are at
// the flight scale (flight-scale.ts), as ship mode draws them.

import * as THREE from 'three'
import { earthSpin, earthTilt, type Vec3 } from '../ephemeris'
import { qualityTier, type QualityTier } from '../quality'
import { PLANET_KEYS, PLANETS, sceneRadius, type PlanetKey } from '../planets'
import { positionsFor } from '../flight-scale'
import { MOONS, MOON_KEYS, moonPosition, moonRadius } from '../moons/moons'
import { COLLISION_MARGIN, MAX_DT } from './flight'
import { CLOUD_FLAT_ALTITUDE, CLOUD_LAYER_TOP } from '../cloud-layer'
import {
  EARTH_KM_PER_UNIT,
  SURFACE_MAX_METRES,
  TRUE_FLOOR_MAX,
  liveTerrainDisplacement,
  surfaceOpacityUniform,
  terrainScaleUniform,
} from '../terrain-scale'
import { earthLatLon, surfaceGroundSampler } from '../surface-ground'
import { SURFACE_TILES_ON } from '../surface'
import { ATMOSPHERE_OUTER, AURORA_SHELL_OUTER } from '../renderers/earth-shells'
import type { Body as FlightBody, GroundSpeedLaw } from './flight'
import { NEAR_CORNER_REACH, NEAR_MIN, NEAR_SHARE, shipNear } from './ship-session'
import {
  earthLimbTerrain,
  earthTerrain,
  loadEarthTerrain,
  terrainFloorGreyAround,
  terrainFloorRadius,
} from './terrain-floor'
import { limbSphereInUse } from './limb-detail'

// The scene draws Sun, Earth and Moon with sceneRadius(diameter) as the sphere
// radius (solar-system.tsx), so these match what is on screen.
export const SUN_RADIUS = sceneRadius(1392700000)
export const EARTH_RADIUS = sceneRadius(12742000)
export const MOON_RADIUS = sceneRadius(3474800)

/**
 * The shells Earth draws over its ground: the cloud deck (over terrain
 * displaced up to TERRAIN_DISPLACEMENT; the low-quality path's is flat and
 * lower), the atmosphere's glow and the aurora. The ship camera's near plane
 * keeps clear of them (ship-session.ts shellGap).
 */
export const EARTH_SHELL_RADII: readonly number[] = [
  EARTH_RADIUS + CLOUD_LAYER_TOP,
  EARTH_RADIUS + CLOUD_FLAT_ALTITUDE,
  EARTH_RADIUS * ATMOSPHERE_OUTER,
  EARTH_RADIUS * AURORA_SHELL_OUTER,
]

/**
 * The outermost shell Earth draws. All of them are drawn from inside too
 * (the atmosphere and aurora: tides-01v.8.2; the cloud deck: tides-01v.8.4);
 * inside the displaced ground the whole planet vanishes (tides-3bl.7).
 */
export const EARTH_SHELL_RADIUS = Math.max(...EARTH_SHELL_RADII)

/**
 * Where the ship stops above Earth on the low quality tier: a near plane's
 * depth (shipNear's ceiling) beyond the outermost shell. That tier draws a
 * flat cloud sheet with no columns or in-cloud fog, so it stays above the
 * deck (tides-01v.8.14). Earth still fills the view from there.
 */
export const EARTH_COLLISION_RADIUS = EARTH_SHELL_RADIUS + shipNear(Infinity)

/** Scene units per true metre at Earth (~4.63e-7). */
export const EARTH_UNITS_PER_METRE = 1 / (EARTH_KM_PER_UNIT * 1000)

/**
 * How far above the displaced ground (terrain-floor.ts) the ship stops over
 * Earth on the high tier (tides-01v.8.7), on the standard depth buffer:
 * under the cloud base (CLOUD_CLEARANCE), so the ship flies below the deck.
 * At 0.4 of it the near plane stays over shipNear's 0.001 floor, and its
 * corners stay off the ground on steep slopes up to 32:9 screens at SHIP_FOV
 * (ship-bodies.test). ~8.6 km true.
 */
export const EARTH_GROUND_CLEARANCE = 0.004

/**
 * The least the ship ever stands over Earth's ground on the standard depth
 * buffer, however the floor settles (earthStop): where the near plane, at
 * NEAR_SHARE of it, is NEAR_MIN, the standard buffer's floor.
 */
export const EARTH_HARD_CLEARANCE = NEAR_MIN / NEAR_SHARE

/**
 * The stop over Earth's ground with reversed-Z on a float depth buffer
 * (tides-zmw.9.8; renderers/depth-precision.ts), where the near plane may
 * fall to NEAR_MIN_REVERSED: true to scale, 30 m. [TUNE]
 */
export const FINE_GROUND_CLEARANCE = 30 * EARTH_UNITS_PER_METRE

/**
 * The least the ship stands over the ground on a float depth buffer: 10 m,
 * whose near plane (NEAR_SHARE of it, 4 m) is over NEAR_MIN_REVERSED. The
 * hard sphere is the sea plus this, so below-sea ground (the Dead Sea) is
 * flown at sea level.
 */
export const FINE_HARD_CLEARANCE = 10 * EARTH_UNITS_PER_METRE

/**
 * How far around the eye the floor holds the ship clear of the ground for
 * a stop `clearance` up: as far as the near rectangle's corners reach with
 * the near plane at NEAR_SHARE of it (NEAR_CORNER_REACH), not only
 * straight down (terrainFloorGreyAround, tides-42p).
 */
export function floorReach(clearance: number): number {
  return NEAR_CORNER_REACH * NEAR_SHARE * clearance
}

/** floorReach at the standard depth buffer's stop. */
export const EARTH_FLOOR_REACH = floorReach(EARTH_GROUND_CLEARANCE)

/** Earth's stop on a depth buffer: `soft` the clearance it settles to, `hard` the least, `reach` its window. */
export interface EarthClearance {
  soft: number
  hard: number
  reach: number
}

/** The stop for a depth buffer that is (`fine`) reversed-Z float or not. */
export function earthClearance(fine: boolean, out: EarthClearance = { soft: 0, hard: 0, reach: 0 }): EarthClearance {
  out.soft = fine ? FINE_GROUND_CLEARANCE : EARTH_GROUND_CLEARANCE
  out.hard = fine ? FINE_HARD_CLEARANCE : EARTH_HARD_CLEARANCE
  out.reach = floorReach(out.soft)
  return out
}

/** Metres the floor stands over the highest tile vertex in its window. */
export const SURFACE_GROUND_MARGIN_METRES = 1

/**
 * Seconds per e-fold in which the floor catches up with ground that rose
 * (within the clearance's give) or fell under a still ship as tiles loaded,
 * changed level or went (earthStop's settling). [TUNE]
 */
export const GROUND_RISE_TAU = 0.3
export const GROUND_DROP_TAU = 1

/**
 * The widest window the near plane's ground is sampled over, scene units
 * (20 km true): from further up it takes the highest any ground stands.
 */
export const NEAR_SAMPLE_MAX = 20 / EARTH_KM_PER_UNIT

/**
 * The slowest the speed cap falls to near Earth's ground on the high tier
 * (flight.ts speedFloor), units/s: the cloud deck's few hundredths of a unit
 * take a second or two to cross, where V_NORMAL went through a column a
 * frame. [TUNE]
 */
export const EARTH_GROUND_SPEED = 0.02

/**
 * Over the streamed tiles (tides-zmw.9.18), the floor follows the gap to
 * the ground: EARTH_GAP_RATE · gap, never under EARTH_SLOWEST nor over
 * EARTH_GROUND_SPEED, today's plateau (flight.ts speedFloorAt). Flying at
 * a share of it the gap e-folds every 1 / (rate · share) s: 720 km/h at
 * full throttle 100 m up, 216 at the 30 m stop. [TUNE]
 */
export const EARTH_GAP_RATE = 2
/** 50 m/s: the least Earth's floor falls to over the tiles. [TUNE] */
export const EARTH_SLOWEST = 50 * EARTH_UNITS_PER_METRE
export const EARTH_GROUND_SPEED_LAW: Readonly<GroundSpeedLaw> = {
  rate: EARTH_GAP_RATE,
  min: EARTH_SLOWEST,
  max: EARTH_GROUND_SPEED,
}

/**
 * Masses, kg, for the flight model's gravity wells (flight.ts wellFactor).
 * The other planets' moons (tides-2hv.8) take theirs from moons.ts' MOONS.
 */
export const BODY_MASS_KG: Readonly<Record<'sun' | 'earth' | 'moon' | PlanetKey, number>> = {
  sun: 1.989e30,
  earth: 5.972e24,
  moon: 7.342e22,
  mercury: 3.301e23,
  venus: 4.867e24,
  mars: 6.417e23,
  jupiter: 1.898e27,
  saturn: 5.683e26,
  uranus: 8.681e25,
  neptune: 1.024e26,
}

/**
 * The frame-by-frame side of Earth's floor (earthStop), which ShipController
 * drives: the depth buffer's stop, the settling as tiles change under the
 * ship, and the near plane's gap.
 */
export interface GroundFloor {
  /** Before the step: takes in what changed since the last mark, and the stop for this frame's depth buffer (earthClearance). */
  beginFrame(fineDepth: boolean): void
  /**
   * After the step (the ground under the ship before the tiles update) and
   * again after settleShip (the ground the next frame starts from).
   */
  mark(position: THREE.Vector3): void
  /** After the tiles' update, before settleShip: takes in what changed under the ship, `dt` s on. */
  settle(dt: number): void
  /**
   * The gap the near plane takes NEAR_SHARE of at `position`: none of the
   * near rectangle can reach the ground (ship-session.test).
   */
  nearGap(position: THREE.Vector3): number
  /** The floor's offset from its settled height (raised: +, lowered into the clearance: -). */
  readonly lift: number
  readonly clearance: Readonly<EarthClearance>
}

export interface ShipBody extends FlightBody {
  /** Null for the Sun, which stays at the origin. */
  positionAt: ((t: number) => Vec3) | null
  /** Turns a body whose ground is sampled in its own frame (Earth) to `t`. */
  turnTo?: (t: number) => void
  /** Its local → world rotation at the last turnTo (Earth's; frame-carry.ts). */
  spin?: THREE.Quaternion
  /** Earth's. */
  floor?: GroundFloor
}

const DEG = Math.PI / 180

// Earth's ground, read in its own spinning frame. The mesh tilts about X,
// then spins about the tilted Y (body-transform.ts), so world → local undoes
// the spin after the tilt. On the low tier the shells' stop stays.
//
// The ground is the highest drawn within a window around the ship (`reach`,
// the near plane's corners at the stop): over the globe its terrain floor
// (terrain-floor.ts), the sphere EarthRenderer's ground holds (the limb
// sphere's while it does, tides-42p, else the 128 × 128 one's); over the
// streamed tiles their mesh (renderers/surface/surface-ground.ts, through
// ../surface-ground.ts, tides-zmw.9.8). The tiles draw nothing above the
// blend's top, the globe fills their screen-door through the dissolve, and
// it shows wherever no tile has loaded, so the floor takes the higher of
// the two there and the tiles' alone where they cover the window at full
// opacity. Missing tiles (no sampler, 503s) leave today's floor.
//
// The stop is a clearance over that ground set by the depth buffer
// (earthClearance): 0.004 on the standard one, 30 m true on reversed-Z
// float, never under the hard clearance (0.0025 / 10 m). The ground also
// changes under a still ship as tiles load, change level, fade or go:
// rather than pop the ship, the floor settles. The change measured under
// the ship across the tiles' update (mark, settle) and between frames
// (mark, beginFrame: the dissolve's end, the globe's sphere swapping), at
// one point in Earth's frame and in true height, so the ship's own motion,
// the spin and the scale its altitude sets don't count, goes into `lift`, which the stop adds and then lets decay: ground that fell holds
// the floor up and lowers it over GROUND_DROP_TAU; ground that rose eats
// into the clearance down to the hard one (snapping beyond it) and lifts
// the ship over GROUND_RISE_TAU. Ground the ship flies onto (a cliff ahead)
// clamps at once, as before.
function attachEarthStop(body: ShipBody, tier: QualityTier, surfaceTiles: boolean): void {
  const spin = new THREE.Quaternion()
  const toLocal = new THREE.Quaternion()
  const euler = new THREE.Euler()
  const local = new THREE.Vector3()
  const marked = new THREE.Vector3()
  const latLon: [number, number] = [0, 0]
  const low = tier === 'low'
  // Without the tiles (production until tides-zmw.9.10) the stop is the
  // globe's as it was: the standard clearance and window, no settling.
  const fixed = low || !surfaceTiles
  const clearance: EarthClearance = earthClearance(false)
  let lift = 0
  // The ground at `marked` as true height (over the sea, / the live scale),
  // so a change of scale (the ship's own altitude, spatial) never counts;
  // NaN when unmarked, or marked over the globe's fallback (not on the scale).
  let markedHeight = NaN

  const toEarth = (direction: THREE.Vector3) => local.copy(direction).applyQuaternion(toLocal)

  // The globe's floor around `at` (unit, Earth's frame).
  const globe = (at: THREE.Vector3, reach: number) => {
    const floor = (limbSphereInUse(EARTH_RADIUS) ? earthLimbTerrain() : null) ?? earthTerrain()
    if (!floor) return terrainFloorRadius(null, EARTH_RADIUS, at)
    const grey = terrainFloorGreyAround(floor, at, reach / EARTH_RADIUS)
    return EARTH_RADIUS + (liveTerrainDisplacement() * grey) / 255
  }

  // The highest ground drawn within `reach` of `at` (see the header).
  const drawn = (at: THREE.Vector3, reach: number) => {
    const sampler = surfaceGroundSampler()
    const opacity = surfaceOpacityUniform.value
    if (!sampler || !(opacity > 0)) return globe(at, reach)
    const [lat, lon] = earthLatLon(at, latLon)
    const tiles = sampler.maxElevation(lat, lon, reach / EARTH_UNITS_PER_METRE)
    if (!tiles) return globe(at, reach)
    const ground =
      EARTH_RADIUS + (tiles.metres + SURFACE_GROUND_MARGIN_METRES) * terrainScaleUniform.value * EARTH_UNITS_PER_METRE
    return opacity < 1 || !tiles.covered ? Math.max(ground, globe(at, reach)) : ground
  }

  const height = (at: THREE.Vector3) => (drawn(at, clearance.reach) - EARTH_RADIUS) / terrainScaleUniform.value

  // Takes the change in the ground at the marked point since the mark into the lift.
  const absorb = () => {
    if (Number.isFinite(markedHeight)) {
      const change = (height(marked) - markedHeight) * terrainScaleUniform.value
      if (Number.isFinite(change)) lift -= change
    }
    markedHeight = NaN
  }

  const apply = () => {
    if (fixed) return
    lift = Math.max(lift, clearance.hard - clearance.soft)
    body.collisionRadius = EARTH_RADIUS + clearance.hard
    body.groundClearance = clearance.soft + Math.min(lift, 0)
  }

  body.collisionRadius = low
    ? EARTH_COLLISION_RADIUS
    : EARTH_RADIUS + (surfaceTiles ? clearance.hard : EARTH_GROUND_CLEARANCE)
  body.groundClearance = EARTH_GROUND_CLEARANCE
  body.minSpeed = low ? undefined : fixed ? EARTH_GROUND_SPEED : EARTH_SLOWEST
  if (!fixed) body.groundSpeed = EARTH_GROUND_SPEED_LAW
  body.spin = spin
  body.ground = (direction, reach = clearance.reach) => drawn(toEarth(direction), reach) + Math.max(lift, 0)
  body.turnTo = (t) => {
    spin.setFromEuler(euler.set(earthTilt(t) * DEG, earthSpin(t), 0, 'XYZ'))
    toLocal.copy(spin).invert()
  }
  // Unit, Earth's frame, from the centre to `position`; null at the centre.
  const up = (position: THREE.Vector3) => {
    const d = local.subVectors(position, body.position).length()
    return d > 0 ? local.divideScalar(d).applyQuaternion(toLocal) : null
  }
  body.floor = {
    get lift() {
      return lift
    },
    clearance,
    beginFrame(fineDepth) {
      if (fixed) return
      // What changed since the last frame's settle (its closing mark): the
      // dissolve's end, the globe's sphere swapping.
      absorb()
      earthClearance(fineDepth, clearance)
      apply()
    },
    mark(position) {
      const at = fixed ? null : up(position)
      markedHeight = NaN
      if (!at || !(earthTerrain() || earthLimbTerrain())) return
      marked.copy(at)
      markedHeight = height(marked)
    },
    settle(dt) {
      if (fixed) return
      const h = Number.isFinite(dt) ? THREE.MathUtils.clamp(dt, 0, MAX_DT) : 0
      if (h > 0) lift *= Math.exp(-h / (lift > 0 ? GROUND_DROP_TAU : GROUND_RISE_TAU))
      absorb()
      apply()
    },
    nearGap(position) {
      const d = position.distanceTo(body.position)
      const at = up(position)
      if (!at) return 0
      const field = drawn(at, clearance.reach)
      if (fixed) return d - field
      // The near rectangle at NEAR_SHARE of a gap g reaches NEAR_CORNER_REACH
      // · NEAR_SHARE · g from the eye: take the gap over the ground that far
      // round, but never under the clearance, which the floor already keeps
      // across `reach` (ship-session.test).
      const window = floorReach(Math.max(d - field, clearance.soft))
      let top = field
      if (window > NEAR_SAMPLE_MAX) {
        const peak = Math.max(TRUE_FLOOR_MAX, (SURFACE_MAX_METRES + SURFACE_GROUND_MARGIN_METRES) * EARTH_UNITS_PER_METRE)
        top = Math.max(field, EARTH_RADIUS + peak * terrainScaleUniform.value)
      } else if (window > clearance.reach) {
        top = drawn(at, window)
      }
      return Math.max(d - top, body.groundClearance ?? 0)
    },
  }
}

/**
 * The ship's stop above a major moon (tides-2hv.8). COLLISION_MARGIN's 2%
 * of Deimos' 0.23 is ~0.005 units, the near plane's own floor, so a moon's
 * shell stands at least MOON_COLLISION_CLEARANCE off its sphere. [TUNE]
 */
export const MOON_COLLISION_CLEARANCE = 0.02

/**
 * Sun, Earth, Moon, the seven planets and their major moons, positions unset
 * until updated. `tier` sets Earth's stop (attachEarthStop), and
 * `surfaceTiles` whether it follows the streamed tiles (tides-zmw.9.8).
 */
export function createShipBodies(tier: QualityTier = qualityTier(), surfaceTiles: boolean = SURFACE_TILES_ON): ShipBody[] {
  const { positionAt } = positionsFor('flight')
  loadEarthTerrain()
  const earth: ShipBody = {
    key: 'earth',
    position: new THREE.Vector3(),
    radius: EARTH_RADIUS,
    mass: BODY_MASS_KG.earth,
    positionAt: positionAt.earth,
  }
  attachEarthStop(earth, tier, surfaceTiles)
  return [
    {
      key: 'sun',
      position: new THREE.Vector3(),
      radius: SUN_RADIUS,
      mass: BODY_MASS_KG.sun,
      positionAt: null,
    },
    earth,
    {
      key: 'moon',
      position: new THREE.Vector3(),
      radius: MOON_RADIUS,
      mass: BODY_MASS_KG.moon,
      positionAt: positionAt.moon,
    },
    ...PLANET_KEYS.map((key) => ({
      key,
      position: new THREE.Vector3(),
      radius: PLANETS[key].radius,
      mass: BODY_MASS_KG[key],
      positionAt: positionAt[key],
    })),
    ...MOON_KEYS.map((key) => {
      const radius = moonRadius(key)
      return {
        key,
        position: new THREE.Vector3(),
        radius,
        collisionRadius: Math.max(radius * COLLISION_MARGIN, radius + MOON_COLLISION_CLEARANCE),
        mass: MOONS[key].massKg,
        positionAt: (t: number) => moonPosition(key, t, 'flight'),
      }
    }),
  ]
}

/**
 * Move and turn `bodies` (from createShipBodies) to where they are at `t`,
 * epoch ms.
 */
export function updateShipBodies(bodies: readonly ShipBody[], t: number): void {
  for (const body of bodies) updateShipBody(body, t)
}

/**
 * Move and turn one body to where it is at `t`: ShipController does Earth's
 * every frame (tides-zmw.9.8), where its orbit and spin carry the ground
 * ~0.2 m a frame, which a 30 m stop can't leave a quarter second stale.
 */
export function updateShipBody(body: ShipBody, t: number): void {
  if (body.positionAt) body.position.fromArray(body.positionAt(t))
  body.turnTo?.(t)
}
