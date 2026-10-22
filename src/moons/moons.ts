// The major moons of Mars, Jupiter, Saturn, Uranus and Neptune (tides-2hv.8).
// Earth's Moon is not here: ephemeris.ts places it, at 10 units per 384 400
// km, and that stays as it is. Pluto isn't in the app, so neither is Charon.
//
// Where a moon is:
//   - Io, Europa, Ganymede and Callisto come from astronomy-engine's
//     JupiterMoons (jovicentric EQJ → ecliptic of date → scene, as planets.ts
//     does for the planets), so their phases are true.
//   - The rest ride mean circular orbits in their parent's equatorial plane
//     (the IAU pole, as axisOrientation uses), at their real periods from a
//     nominal J2000 phase. Iapetus is inclined 15.47° to Saturn's equator and
//     Triton orbits retrograde, 23.115° off Neptune's (i = 156.885°).
//   - Uranus' IAU north pole is the one on the ecliptic's north side, so the
//     planet spins backwards about it (RotationAxis' spin falls ~21°/h) and
//     its moons, which orbit the way it spins, go clockwise seen from that
//     pole: POLE_SENSE flips it.
//
// How far out: true scale is hopeless (Phobos would sit 0.06 units from Mars'
// radius-2 sphere at the system view's spacing, and inside it at ship mode's
// 1000 units/AU), so each parent gets a compact log map of its moons' true
// semi-major axes a:
//
//   a_scene = floor + span · ln(a / a_min) / ln(a_max / a_min)
//
// floor clears the planet (Saturn's and Uranus' ring edges) by MOON_ORBIT_GAP
// plus the innermost moon's radius, and span is [TUNE] per parent. The map
// is relative to the parent and the same in both distance scales: only the
// parent's position changes with the scale, so an orbit line built once
// serves both (moonOrbitPath), and at 1000 units/AU true scale would put
// Triton inside Neptune and Oberon inside Uranus' rings anyway.
//
// Every system stays clear of every other planet's orbit band in the system
// view (moons.test.ts, 1900–2100). The one exception: neighbouring systems
// can't be kept apart at their closest approach. Jupiter's and Saturn's
// centres come within ~45 units of each other, and Saturn's and Uranus'
// within ~53, against extents summing to ~51 and ~53, so their outermost
// moons' circles can touch near a great conjunction (2000-04, 2040-07),
// ~2% of the time.

import * as THREE from 'three'
import {
  JupiterMoons,
  KM_PER_AU,
  RotationAxis,
  Rotation_EQJ_ECT,
  type RotationMatrix,
  type StateVector,
} from 'astronomy-engine'
import { PLANETS, sceneRadius, type PlanetKey } from '../planets'
import { positionsFor } from '../flight-scale'
import type { DistanceScale } from '../distance-scale'
import type { Vec3 } from '../ephemeris'
import { MOON_KEYS, type MoonKey } from './moon-keys'

export { MOON_KEYS, isMoonKey, type MoonKey } from './moon-keys'

export type MoonParent = Extract<PlanetKey, 'mars' | 'jupiter' | 'saturn' | 'uranus' | 'neptune'>

/** Outward from the Sun. */
export const MOON_PARENTS: readonly MoonParent[] = ['mars', 'jupiter', 'saturn', 'uranus', 'neptune']

export interface Moon {
  key: MoonKey
  name: string
  parent: MoonParent
  /** Mean semi-major axis, km. */
  aKm: number
  /** Sidereal period, days. */
  periodDays: number
  /** To the parent's equator, degrees (unused for the Galileans). */
  inclinationDeg: number
  /** Ascending node on the parent's equator, degrees from the equator's node on the ecliptic of date. */
  nodeDeg: number
  /** Orbits against the parent's spin (Triton). */
  retrograde: boolean
  /** Mean radius, km. */
  radiusKm: number
  massKg: number
  color: string
  /**
   * J2000 mean longitude, degrees: node + ω + M from the JPL SSD planetary
   * satellite mean elements (https://ssd.jpl.nasa.gov/sats/elem/, epoch
   * 2000-01-01.5 TDB; MAR099, SAT441, Uranus and Neptune tables). Those
   * angles are measured in each moon's Laplace plane from its node on the
   * ICRF equator, not from the node used here, so the phase is nominal: only
   * the Galileans' (JupiterMoons) are true.
   */
  phaseDeg: number
}

function moon(
  key: MoonKey,
  name: string,
  parent: MoonParent,
  aKm: number,
  periodDays: number,
  inclinationDeg: number,
  radiusKm: number,
  massKg: number,
  color: string,
  phaseDeg: number,
  retrograde = false
): Moon {
  return {
    key,
    name,
    parent,
    aKm,
    periodDays,
    inclinationDeg,
    nodeDeg: 0,
    retrograde,
    radiusKm,
    massKg,
    color,
    phaseDeg,
  }
}

// Semi-major axes, periods, radii and masses: NASA/JPL planetary satellite
// physical parameters and mean elements. Phases (last number): node + ω + M
// from the JPL mean elements, mod 360, e.g. Phobos 169.2 + 216.3 + 189.7.
// The Galileans' phases are unused (JupiterMoons places them).
export const MOONS: Readonly<Record<MoonKey, Moon>> = {
  phobos: moon('phobos', 'Phobos', 'mars', 9_376, 0.31891, 1.09, 11.08, 1.066e16, '#6e655c', 215.2),
  deimos: moon('deimos', 'Deimos', 'mars', 23_463, 1.26244, 0.93, 6.2, 1.476e15, '#8a7d6e', 259.3),
  io: moon('io', 'Io', 'jupiter', 421_700, 1.769138, 0, 1821.6, 8.932e22, '#e3cf6b', 20.0),
  europa: moon('europa', 'Europa', 'jupiter', 671_034, 3.551181, 0, 1560.8, 4.8e22, '#cdbfa5', 214.4),
  ganymede: moon('ganymede', 'Ganymede', 'jupiter', 1_070_412, 7.154553, 0, 2634.1, 1.482e23, '#9a8f80', 221.6),
  callisto: moon('callisto', 'Callisto', 'jupiter', 1_882_709, 16.689018, 0, 2410.3, 1.076e23, '#5f5549', 80.3),
  mimas: moon('mimas', 'Mimas', 'saturn', 185_539, 0.942422, 1.574, 198.2, 3.749e19, '#bdb8b0', 141.9),
  enceladus: moon('enceladus', 'Enceladus', 'saturn', 237_948, 1.370218, 0.009, 252.1, 1.08e20, '#f2f4f6', 176.5),
  tethys: moon('tethys', 'Tethys', 'saturn', 294_619, 1.887802, 1.12, 531.1, 6.174e20, '#dedad3', 248.3),
  dione: moon('dione', 'Dione', 'saturn', 377_396, 2.736915, 0.019, 561.4, 1.095e21, '#cfcac2', 328.0),
  rhea: moon('rhea', 'Rhea', 'saturn', 527_108, 4.518212, 0.345, 763.8, 2.307e21, '#c6c0b6', 209.5),
  titan: moon('titan', 'Titan', 'saturn', 1_221_870, 15.945421, 0.349, 2574.7, 1.345e23, '#d8a24a', 168.6),
  iapetus: moon('iapetus', 'Iapetus', 'saturn', 3_560_820, 79.3215, 15.47, 734.5, 1.806e21, '#8c7f6d', 55.8),
  miranda: moon('miranda', 'Miranda', 'uranus', 129_390, 1.413479, 4.232, 235.8, 6.4e19, '#aaa69f', 328.7),
  ariel: moon('ariel', 'Ariel', 'uranus', 190_020, 2.520379, 0.26, 578.9, 1.251e21, '#bbb6ae', 203.1),
  umbriel: moon('umbriel', 'Umbriel', 'uranus', 266_000, 4.144177, 0.128, 584.7, 1.275e21, '#6c6761', 251.2),
  titania: moon('titania', 'Titania', 'uranus', 436_300, 8.705872, 0.34, 788.9, 3.4e21, '#a9a095', 281.6),
  oberon: moon('oberon', 'Oberon', 'uranus', 583_519, 13.463239, 0.058, 761.4, 3.076e21, '#988b80', 352.6),
  triton: moon('triton', 'Triton', 'neptune', 354_759, 5.876854, 23.115, 1353.4, 2.139e22, '#d4c3b8', 241.1, true),
}

/** Ordered by semi-major axis. */
export function moonsOf(parent: MoonParent): readonly MoonKey[] {
  return MOONS_OF[parent]
}

const MOONS_OF: Readonly<Record<MoonParent, readonly MoonKey[]>> = Object.fromEntries(
  MOON_PARENTS.map((parent) => [
    parent,
    MOON_KEYS.filter((key) => MOONS[key].parent === parent).sort(
      (a, b) => MOONS[a].aKm - MOONS[b].aKm
    ),
  ])
) as Record<MoonParent, MoonKey[]>

// --- Sizes ---------------------------------------------------------------

/**
 * The smallest moon's scene radius, and how fast the radius grows toward the
 * shared log scale below RADIUS_JOIN_KM. [TUNE] sceneRadius (the Sun, Earth
 * and planets' scale) reaches 0 at a diameter of ~1786 km, so below the join
 * a moon is FLOOR + GAIN · √(diameter / RADIUS_JOIN_KM) instead: never under
 * FLOOR and still in size order. A flat floor would draw every mid-size
 * moon alike and crowd Saturn's inner ones.
 */
export const MOON_RADIUS_FLOOR = 0.2
export const MOON_RADIUS_GAIN = 0.4
// sceneRadius(2662 km) = 0.6 = FLOOR + GAIN, so the two meet there.
const RADIUS_JOIN_KM = 2662

/** Scene radius of a moon of `diameterKm`: sceneRadius, floored as above. */
export function clampedSceneRadius(diameterKm: number): number {
  return Math.max(
    sceneRadius(diameterKm * 1000),
    MOON_RADIUS_FLOOR + MOON_RADIUS_GAIN * Math.sqrt(diameterKm / RADIUS_JOIN_KM)
  )
}

const RADIUS: Readonly<Record<MoonKey, number>> = Object.fromEntries(
  MOON_KEYS.map((key) => [key, clampedSceneRadius(2 * MOONS[key].radiusKm)])
) as Record<MoonKey, number>

/** The moon's sphere radius, scene units. */
export function moonRadius(key: MoonKey): number {
  return RADIUS[key]
}

// --- Orbit radii ---------------------------------------------------------

/**
 * Scene units from the parent's centre over which its moons' log-spaced
 * orbits spread, innermost to outermost. [TUNE] Saturn needs ~14+ to keep
 * Enceladus, Tethys and Dione apart (they span 7% of its log range); larger
 * spans crowd the neighbouring planets' bands. Neptune has one moon, so it
 * has no span.
 */
export const MOON_ORBIT_SPAN: Readonly<Record<MoonParent, number>> = {
  mars: 2,
  jupiter: 10,
  saturn: 15,
  uranus: 10,
  neptune: 0,
}

/**
 * Clearance between the planet's surface (or ring edge) and the innermost
 * moon's surface. [TUNE] Mars' is smaller to keep its system clear of the
 * Earth–Moon band.
 */
export const MOON_ORBIT_GAP: Readonly<Record<MoonParent, number>> = {
  mars: 0.6,
  jupiter: 1,
  saturn: 1,
  uranus: 1,
  neptune: 1,
}

function orbitRadii(parent: MoonParent): [MoonKey, number][] {
  const planet = PLANETS[parent]
  const keys = moonsOf(parent)
  const clear = planet.radius * (planet.rings?.outer ?? 1)
  const floor = clear + MOON_ORBIT_GAP[parent] + RADIUS[keys[0]]
  const aMin = MOONS[keys[0]].aKm
  const logRange = Math.log(MOONS[keys[keys.length - 1]].aKm / aMin)
  return keys.map((key) => [
    key,
    // One moon: ln(1) = 0, so it sits at the floor.
    logRange > 0
      ? floor + (MOON_ORBIT_SPAN[parent] * Math.log(MOONS[key].aKm / aMin)) / logRange
      : floor,
  ])
}

const ORBIT_RADIUS: Readonly<Record<MoonKey, number>> = Object.fromEntries(
  MOON_PARENTS.flatMap(orbitRadii)
) as Record<MoonKey, number>

/** The moon's orbit radius around its parent, scene units (both scales). */
export function moonOrbitRadius(key: MoonKey): number {
  return ORBIT_RADIUS[key]
}

const EXTENT: Readonly<Record<MoonParent, number>> = Object.fromEntries(
  MOON_PARENTS.map((parent) => [
    parent,
    Math.max(...moonsOf(parent).map((key) => ORBIT_RADIUS[key] + RADIUS[key])),
  ])
) as Record<MoonParent, number>

/** How far the parent's outermost moon reaches from its centre, scene units. */
export function moonSystemExtent(parent: MoonParent): number {
  return EXTENT[parent]
}

// --- Positions -----------------------------------------------------------

const DEG = Math.PI / 180
const MS_PER_DAY = 86_400_000
const J2000_MS = Date.UTC(2000, 0, 1, 12)

/** +1 where the IAU pole is the one the planet spins (and its moons orbit) about. */
const POLE_SENSE: Readonly<Record<MoonParent, 1 | -1>> = {
  mars: 1,
  jupiter: 1,
  saturn: 1,
  uranus: -1,
  neptune: 1,
}

const GALILEANS = ['io', 'europa', 'ganymede', 'callisto'] as const
type Galilean = (typeof GALILEANS)[number]
function isGalilean(key: MoonKey): key is Galilean {
  return (GALILEANS as readonly string[]).includes(key)
}

const INDEX: Readonly<Record<MoonKey, number>> = Object.fromEntries(
  MOON_KEYS.map((key, i) => [key, i])
) as Record<MoonKey, number>

// Per moon at lastT, scene axes: the unit direction from the parent (p), the
// unit direction of motion in the orbit plane (q), and the true offset, km.
// The moon is at radius · p; its orbit is radius · (cos s · p + sin s · q).
const n = MOON_KEYS.length
const unitP = new Float64Array(n * 3)
const unitQ = new Float64Array(n * 3)
const trueKm = new Float64Array(n * 3)
let lastT = NaN

const north = new THREE.Vector3(0, 1, 0)
const e1 = new THREE.Vector3()
const e2 = new THREE.Vector3()
const e3 = new THREE.Vector3()
const node = new THREE.Vector3()
const along = new THREE.Vector3()
const p = new THREE.Vector3()
const q = new THREE.Vector3()
const r = new THREE.Vector3()
const v = new THREE.Vector3()

// EQJ (x, y, z) → ecliptic of date → scene axes (eclipticToScene).
function toScene(rot: RotationMatrix, x: number, y: number, z: number, out: THREE.Vector3) {
  const m = rot.rot
  const ex = m[0][0] * x + m[1][0] * y + m[2][0] * z
  const ey = m[0][1] * x + m[1][1] * y + m[2][1] * z
  const ez = m[0][2] * x + m[1][2] * y + m[2][2] * z
  return out.set(-ex, ez, ey)
}

function store(i: number, km: number) {
  p.toArray(unitP, i * 3)
  q.toArray(unitQ, i * 3)
  trueKm[i * 3] = p.x * km
  trueKm[i * 3 + 1] = p.y * km
  trueKm[i * 3 + 2] = p.z * km
}

function placeGalilean(i: number, state: StateVector, rot: RotationMatrix) {
  toScene(rot, state.x, state.y, state.z, r)
  toScene(rot, state.vx, state.vy, state.vz, v)
  const km = r.length() * KM_PER_AU
  p.copy(r).normalize()
  // The osculating plane, so the drawn circle passes through the moon.
  q.crossVectors(r, v).cross(r).normalize()
  store(i, km)
}

// The pole the parent's moons orbit prograde about, scene axes.
function orbitPole(parent: MoonParent, date: Date, rot: RotationMatrix, out: THREE.Vector3) {
  const pole = RotationAxis(PLANETS[parent].body, date).north
  return toScene(rot, pole.x, pole.y, pole.z, out).multiplyScalar(POLE_SENSE[parent])
}

// The parent's equator: e3 its orbitPole, e1 the equator's ascending node on
// the ecliptic of date, e2 = e3 × e1.
function equatorBasis(parent: MoonParent, date: Date, rot: RotationMatrix) {
  orbitPole(parent, date, rot, e3)
  e1.crossVectors(north, e3).normalize()
  e2.crossVectors(e3, e1)
}

function placeMean(i: number, key: MoonKey, t: number) {
  const { nodeDeg, inclinationDeg, phaseDeg, periodDays, retrograde, aKm } = MOONS[key]
  const sense = retrograde ? -1 : 1
  const omega = nodeDeg * DEG
  const inc = inclinationDeg * DEG
  node.copy(e1).multiplyScalar(Math.cos(omega)).addScaledVector(e2, Math.sin(omega))
  // In the orbit plane, 90° on from the node: the equator's direction there
  // tilted up by the inclination.
  along.crossVectors(e3, node).multiplyScalar(Math.cos(inc)).addScaledVector(e3, Math.sin(inc))
  const revolutions = (t - J2000_MS) / (periodDays * MS_PER_DAY)
  const u = (phaseDeg - nodeDeg) * DEG + sense * 2 * Math.PI * (revolutions - Math.floor(revolutions))
  const cu = Math.cos(u)
  const su = Math.sin(u)
  p.copy(node).multiplyScalar(cu).addScaledVector(along, su)
  q.copy(node).multiplyScalar(-su * sense).addScaledVector(along, cu * sense)
  store(i, aKm)
}

// Every moon at t in one pass: one JupiterMoons, one RotationAxis per parent
// and one precession-nutation matrix. The views ask once per frame per moon.
function computeAll(t: number) {
  if (t === lastT) return
  const date = new Date(t)
  const rot = Rotation_EQJ_ECT(date)
  const jupiter = JupiterMoons(date)
  for (const parent of MOON_PARENTS) {
    if (parent !== 'jupiter') equatorBasis(parent, date, rot)
    for (const key of MOONS_OF[parent]) {
      if (isGalilean(key)) placeGalilean(INDEX[key], jupiter[key], rot)
      else placeMean(INDEX[key], key, t)
    }
  }
  lastT = t
}

/** The moon's offset from its parent's centre at t (epoch ms), scene units, into `out`. */
export function moonOffsetInto(key: MoonKey, t: number, out: THREE.Vector3): THREE.Vector3 {
  computeAll(t)
  return out.fromArray(unitP, INDEX[key] * 3).multiplyScalar(ORBIT_RADIUS[key])
}

/** The moon's true offset from its parent's centre at t, km along the scene's axes. */
export function moonTrueOffsetKm(key: MoonKey, t: number, out: THREE.Vector3): THREE.Vector3 {
  computeAll(t)
  return out.fromArray(trueKm, INDEX[key] * 3)
}

/** The moon's scene position at t: its parent's at `scale` plus the offset. */
export function moonPosition(key: MoonKey, t: number, scale: DistanceScale): Vec3 {
  const [x, y, z] = positionsFor(scale).positionAt[MOONS[key].parent](t)
  computeAll(t)
  const i = INDEX[key] * 3
  const a = ORBIT_RADIUS[key]
  return [x + a * unitP[i], y + a * unitP[i + 1], z + a * unitP[i + 2]]
}

/**
 * The moon's orbit at t as `segments` xyz triples for a closed
 * THREE.LineLoop, relative to the parent's centre and the same at every
 * distance scale (add the parent's position, or draw it in a group there).
 * The loop starts at the moon and runs the way it orbits, so the moon is
 * always on it. The Galileans' loops are their osculating circles, within
 * ~0.5° of Jupiter's equator.
 */
export function moonOrbitPath(
  key: MoonKey,
  t: number,
  segments: number,
  out?: Float32Array
): Float32Array {
  computeAll(t)
  const points = out ?? new Float32Array(segments * 3)
  const i = INDEX[key] * 3
  const a = ORBIT_RADIUS[key]
  for (let k = 0; k < segments; k++) {
    const s = (2 * Math.PI * k) / segments
    const c = a * Math.cos(s)
    const d = a * Math.sin(s)
    points[k * 3] = c * unitP[i] + d * unitQ[i]
    points[k * 3 + 1] = c * unitP[i + 1] + d * unitQ[i + 1]
    points[k * 3 + 2] = c * unitP[i + 2] + d * unitQ[i + 2]
  }
  return points
}

