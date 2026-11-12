// True distances for the ship HUD (tides-3bl.5).
//
// The scene is not to scale, and not by one factor: the Sun, Earth and
// planets sit at their true positions × FLIGHT_UNITS_PER_AU (flight-scale.ts,
// ~150 000 km a unit), but the Moon orbits at 10 units per 384 400 km (38 440
// km a unit) and every radius is on a log scale. So the ship has no
// exact true position. The HUD builds one, and reads every range off it, so
// the ranges never contradict each other (no "1 AU from Earth and 1 km from
// the Moon"):
//
//   1. Each body R anchors a guess: R's true position (astronomy-engine,
//      heliocentric, km) plus the ship's scene direction from R, at R's true
//      radius plus the ship's gap to R's shell × kmPerUnit(R).
//   2. kmPerUnit(R) is the true surface gap over the scene shell gap between R
//      and its neighbours, weighted to the nearest (1 / gap⁴, log space): the
//      km a scene unit stands for around R, ~150 000 between planets. Moon
//      systems have their own scales (tides-2hv.8):
//        - A planet's (Mars, Jupiter, Saturn, Uranus, Neptune, and their
//          major moons): the moons sit at true spacing in planet radii in
//          flight (moons.ts, tides-ufyr.6.2), so the whole system is one
//          uniform scale, the parent's true radius over its drawn one (~10 700
//          km a unit at Jupiter at ?truescale=0, ~3 500 at the default 0.7:
//          14–43× finer than the planets'). Inside its edge
//          (moonSystemEdge: MOON_SYSTEM_EDGE_FACTOR × its extent) every member
//          anchors on that scale, from its drawn offset from the parent on it
//          (the drawn orbits are circles, the true ones ~1% off them), and
//          takes its shell's excess over its true radius back near it
//          (SHELL_EXCESS_FADE), so the members' anchors agree: a moon's range
//          is to its true surface on the system's scale, and blending from
//          one member's anchor to the next runs the ranges at the speed read
//          (within ~0.3% from Io in to Jupiter; passing close by another
//          moon, its own make-up shows). Outside, the parent alone anchors,
//          on its scale against the other planets, and the moons take their
//          ranges from the blended position, at their true offsets from it. So the ranges to everything outside the
//          system step once at the edge (tides-ufyr.6.2.1, the user's call):
//          leaving Jupiter's at 0.7, by ~0.8 AU, the km its ~810 units stand
//          for on the one scale and not the other. No band could pay that
//          back: Saturn's ~1.6 AU would need more room than there is to
//          Jupiter's system at their closest. The step has a hysteresis band
//          (MOON_SYSTEM_EDGE_HYSTERESIS) so hovering at the edge can't flicker
//          it, and each crossing is counted (ShipRanges.edgeCrossing) for the
//          HUD's cue (hud-format.ts stepSystemCue).
//        - Earth's (Earth and the Moon, whose 10-unit orbit is no uniform
//          scale): its members count only each other as neighbours
//          (~38 000–62 000 km a unit), and leaving they hand over to Earth's
//          planetary neighbours' scale, or Earth's range would under-read by
//          the ratio of the two (~2.5×) all the way out. The hand-over is
//          linear in km per unit, k(d), with d the ship's distance from
//          Earth's centre, and a member's gap is measured along it: a·gap +
//          ∫(k − a) dd, so the range grows at k × the radial speed, the rate
//          the HUD's speed reads (a·gap alone, scaled up as the ship leaves,
//          would run ~2.5× faster than the speed through the band).
//   3. The guesses blend with weights 1 / (ship's gap to R)⁴, so the anchor is
//      whichever body the ship is near, handing over smoothly in between.
//      Inside a system its members outweigh a body outside it that happens
//      to be as near in the scene. (Venus can't be, near Earth at the flight
//      scale: it never comes within ~260 units. The boost dates from the
//      compressed scale, where it passed ~14 units from Earth.)
//   4. range(B) = |true B − true ship| − B's true radius. Earth is the
//      exception: near it, its range is its own anchor's gap (a·gap plus the
//      hand-over term), handing over to the formula above only far out
//      (RANGE_HAND_OVER), so it only shrinks as the ship closes. A planet's
//      moon system needs no such exception: inside, its members' anchors
//      agree (and their ranges are from their drawn places on the system's
//      scale, not their ephemeris ones); outside, only the parent anchors.
//
// Gaps are to the collision shell, the closest the ship can get (over Earth,
// its terrain floor under the ship: flight.ts floorRadius), and the anchor
// then puts the ship on R's true surface: a range reads 0 on arrival,
// and at Earth facing the Moon it is the true surface-to-surface distance
// (the astronomy-engine centre distance less both radii).
//
// The catch: radii are drawn far larger than true and the Moon's offset is
// not to scale, so near them the position is the scene's geometry at the
// local true scale. In deep space the pair scales all converge on
// KM_PER_AU / FLIGHT_UNITS_PER_AU, so the position is true there. (They are
// left to converge, not pinned to it: moon systems need their own local
// scales.) Speed uses the same blended scale (km per scene unit where the
// ship is), so it is the rate the ranges change at, but for the one step at
// a planet system's edge.
//
// Near a body the ship flies down to its ground (Earth's, where its speed
// floor is under V_NORMAL: flight.ts speedFloor), its
// own anchor reads on the drawn ground's scale instead (tides-01v.8.18): the body's
// true radius over its scene radius, ~2 160 km a unit for Earth, against
// the Earth–Moon pair's ~38 000–62 000. Skimming the floor at Earth's 0.02
// units/s ground speed then reads ~43 km/s, where the pair scale read
// 550–1 300 km/s across ground the ship crosses in seconds. The anchor's km
// per unit hands over from the ground's to its usual scale between the
// cloud tops and twice their height (GROUND_BAND), and its gap is the
// integral of that, as for the moon systems, so the range still grows at
// the speed's rate and reads 0 on the floor. That leaves the anchor's gap
// short of the usual scale's by the band's depth at the difference (~12 000
// km at Earth), which it pays back over GROUND_PAYBACK, the speed reading up
// to ~6–8% over the pair scale through it, so from there out (the Moon
// included) every range and speed is as it was. The low tier's floor is its
// stop over the cloud sheet (tides-ufyr.2), read the same way.
//
// Under ?truescale=<a> (../truescale.ts, tides-o39) the drawn radii grow
// toward true while the distances stay. For every body but the Sun nothing
// here changes: the pair scales are true gaps over the drawn shell gaps, so
// they follow the radii, a planet system's scale is its parent's true radius
// over its grown one, and its edge grows with its flight extent
// (moonSystemExtent(parent, 'flight'): Saturn's ~1600 units out at 0.7).
//
// The Sun grows most: ~114 units in radius at the default, a = 0.7
// (DEFAULT_TRUESCALE), ~228 at 0.9. Taken to its grown shell, its gap with
// Mercury shrank to a sliver (~4× the flight scale at 0.9), and that scale
// rode out on every anchor near either: the Sun's own however far out the
// ship was, Mercury's and Venus's too, so a run in to Venus or Mars passing
// a few hundred units from the Sun read its range backwards by up to ~3–5
// million km, which capped a at 0.7 (tides-3ln). So pair gaps take the Sun
// at its scene size (pairShell()), and its pair scales are the planets' at
// any a; its anchor makes up the growth itself (tides-ofv): its gap takes
// the extra shell at the flight scale through a band from its shell out to
// SUN_BAND_GROWTHS × the growth, so it reads 0 on arrival and true beyond
// the band, and the speed reads up to 1.5× the flight scale through it,
// which the user accepted of the old near-Sun scale. At a = 0 the share is 1
// and there is no growth: nothing changes.

import {
  Body,
  HelioVector,
  KM_PER_AU,
  RotateVector,
  Rotation_EQJ_ECT,
} from 'astronomy-engine'
import * as THREE from 'three'
import { eclipticToScene } from '../ephemeris'
import { PLANETS } from '../planets'
import {
  MOONS,
  MOON_KEYS,
  MOON_PARENTS,
  isMoonKey,
  type MoonParent,
  moonSystemExtent,
  moonTrueOffsetKm,
  moonsOf,
} from '../moons/moons'
import { CLOUD_LAYER_TOP } from '../cloud-layer'
import { FLIGHT_UNITS_PER_AU, flightRadii } from '../flight-scale'
import {
  V_NORMAL,
  collisionRadius,
  floorRadius,
  speedFloor,
  type Body as FlightBody,
} from './flight'

/** Speed of light, km/s. */
export const C_KM_PER_S = 299_792.458

// Weighting falls off fast enough that a body twice as far counts 1/16 as
// much: the anchor is the nearest body unless two are about as near.
const WEIGHT_POWER = 4
// Gaps are floored here so a ship resting on a shell (gap 0) weights finitely.
const MIN_GAP = 1e-3

// Earth's system: within `inner` of Earth's centre, Earth and the Moon weigh
// MOON_SYSTEM_BOOST times as much as anchors and read on their pair's scale;
// past `outer` (2 × inner), the same as any body, on the planets' scale;
// between, a smooth blend. The Moon orbits ~10 units out; the spawn is ~12
// out on a wide screen and ~28 on a portrait phone (Earth framed across the
// short side), hence 30 to 60. The boost has to be large because another
// body's guess is tens of millions of km off (its scale is the planets'): 1e4
// is a gap 10× smaller, so with a planet as near as Earth the position moves
// ~2% instead of ~50% (a boost of 100).
const MOON_SYSTEM_INNER = 30
const MOON_SYSTEM_BOOST = 1e4

// Out to `outer` Earth's range is its own anchor's gap; from there to
// RANGE_HAND_OVER × outer it hands over to the blended position's. [TUNE]
const RANGE_HAND_OVER = 10

/**
 * A planet's moon system ends MOON_SYSTEM_EDGE_FACTOR × its flight extent
 * (moonSystemExtent: its outermost moon's reach) from the planet's centre,
 * and never closer than MOON_SYSTEM_INNER (Mars' is ~12–14 units). [TUNE]
 * Half again the extent keeps the ship on the system's scale all round its
 * outermost moon (Iapetus: 1065 units out at the default truescale, the edge
 * at ~1600), and short of every neighbour: the closest two edges come to
 * each other is Jupiter's (~810) and Saturn's (~1600) at Jupiter–Saturn's
 * closest, 4034 units, at 0.7, leaving ~1600 between them; at 0.9
 * (~1120 and ~2140) ~780.
 */
export const MOON_SYSTEM_EDGE_FACTOR = 1.5

/**
 * The ship enters a planet's moon system at (1 − this) × its edge and leaves
 * it at (1 + this) ×, so hovering on the edge doesn't flip the ranges
 * between scales every frame. [TUNE]
 */
export const MOON_SYSTEM_EDGE_HYSTERESIS = 0.05

/**
 * Inside a planet system's edge a member's anchor takes its shell's excess
 * over its true radius (a few hundred to a few thousand km) back over a gap
 * this many times that excess, so the members' anchors agree past it and
 * the blend between them doesn't run the ranges off the speed. The speed
 * reads up to 1.5 / this over the system's scale through it. [TUNE]
 */
export const SHELL_EXCESS_FADE = 30

interface Band {
  inner: number
  outer: number
}

interface MoonSystem extends Band {
  parent: string
  /**
   * Planet systems only (tides-ufyr.6.2.1): where the ship steps between the
   * system's scale and the planets'. Earth's (null) blends through inner to
   * outer instead.
   */
  edge: number | null
}

// A body with ground reads on its drawn ground's scale up to `inner` above
// its floor, its usual one from `outer`, smoothly between. [TUNE]
const GROUND_BAND: Band = { inner: CLOUD_LAYER_TOP, outer: 2 * CLOUD_LAYER_TOP }
// ∫ (1 − smoothstep) over GROUND_BAND from the floor up: the scene units
// whose km the ground scale leaves out of the gap.
const GROUND_BAND_DEPTH = (GROUND_BAND.inner + GROUND_BAND.outer) / 2
// Where the gap makes those km back: from the band's top out to a gap of 4,
// short of the Moon (Earth's gap from its shell is 5.3–6 units), so Earth's
// range read there is as before. Wide, so the speed reads little over the
// usual scale while it does. [TUNE]
const GROUND_PAYBACK: Band = { inner: GROUND_BAND.outer, outer: 4 }

// The Sun's radius at the scene size, a = 0: its pair gaps' (pairShell()).
const SUN_SCENE_RADIUS = flightRadii(0).sun
// km per scene unit at the flight scale, where the pair scales converge.
const FLIGHT_KM_PER_UNIT = KM_PER_AU / FLIGHT_UNITS_PER_AU
// The Sun's anchor takes its shell's growth over the scene size at the
// flight scale from its shell out to SUN_BAND_GROWTHS × the growth, so the
// speed reads at most 1.5 / SUN_BAND_GROWTHS of the flight scale over the
// planets' through it; at 0.9 the band (~670 units) ends short of Earth.
// [TUNE]
const SUN_BAND_GROWTHS = 3

const MOON_SYSTEMS: readonly MoonSystem[] = [
  { parent: 'earth', inner: MOON_SYSTEM_INNER, outer: 2 * MOON_SYSTEM_INNER, edge: null },
  ...MOON_PARENTS.map((parent) => {
    const edge = Math.max(MOON_SYSTEM_INNER, MOON_SYSTEM_EDGE_FACTOR * moonSystemExtent(parent, 'flight'))
    return { parent, inner: edge, outer: edge, edge }
  }),
]

/** Where `parent`'s moon system ends, scene units from its centre (MOON_SYSTEM_EDGE_FACTOR). */
export function moonSystemEdge(parent: MoonParent): number {
  return MOON_SYSTEMS[MOON_PARENTS.indexOf(parent) + 1].edge!
}

// Ship body key → its index in MOON_SYSTEMS, for every parent and moon.
const SYSTEM_OF_KEY = new Map<string, number>([
  ['earth', 0],
  ['moon', 0],
  ...MOON_PARENTS.flatMap((parent, i) =>
    [parent, ...moonsOf(parent)].map((key): [string, number] => [key, i + 1])
  ),
])

// ∫ smoothstep(x, inner, outer) dx from inner to d (0 inside inner): with
// u = (x − inner) / band, ∫ (3u² − 2u³) band du = band (u³ − u⁴/2).
function bandIntegral(d: number, { inner, outer }: Band): number {
  const band = outer - inner
  const u = THREE.MathUtils.clamp((d - inner) / band, 0, 1)
  return band * (u ** 3 - u ** 4 / 2) + Math.max(0, d - outer)
}

// d/dx smoothstep(x, inner, outer) at d: 6u(1 − u) / band.
function bandSlope(d: number, { inner, outer }: Band): number {
  const band = outer - inner
  const u = THREE.MathUtils.clamp((d - inner) / band, 0, 1)
  return (6 * u * (1 - u)) / band
}

// The planets and Earth's Moon; a major moon is its parent plus
// moonTrueOffsetKm.
const ASTRO_BODIES: Record<string, Body> = {
  sun: Body.Sun,
  earth: Body.Earth,
  moon: Body.Moon,
  ...Object.fromEntries(Object.values(PLANETS).map((planet) => [planet.key, planet.body])),
}

// Mean radii, km: half the diameters the scene's spheres are sized from
// (flight-scale.ts SUN_DIAMETER and MOON_DIAMETER, planets.ts).
const RADIUS_KM: Record<string, number> = {
  sun: 1_392_700 / 2,
  earth: 12_742 / 2,
  moon: 3_474.8 / 2,
  ...Object.fromEntries(
    Object.values(PLANETS).map((planet) => [planet.key, planet.diameter / 2000])
  ),
  ...Object.fromEntries(MOON_KEYS.map((key) => [key, MOONS[key].radiusKm])),
}

/** Where the bodies truly are: km from the Sun along the scene's axes. */
export interface TrueBodies {
  positions: THREE.Vector3[]
  /** Mean radius, km. */
  radii: number[]
}

/**
 * True heliocentric positions (km, scene axes: ecliptic of date, +Y north)
 * and radii of the bodies `keys` at `t`, epoch ms. Keys are ship body keys
 * ('sun', 'earth', 'moon', a planet or a major moon).
 */
export function trueBodies(keys: readonly string[], t: number): TrueBodies {
  const date = new Date(t)
  const toEcliptic = Rotation_EQJ_ECT(date)
  const offset = new THREE.Vector3()
  return {
    positions: keys.map((key) => {
      const moon = isMoonKey(key) ? MOONS[key] : undefined
      const body = ASTRO_BODIES[moon?.parent ?? key]
      if (body === undefined) throw new Error(`No ephemeris for ${key}`)
      const position = eclipticToScene(
        RotateVector(toEcliptic, HelioVector(body, date)),
        new THREE.Vector3()
      ).multiplyScalar(KM_PER_AU)
      return moon ? position.add(moonTrueOffsetKm(moon.key, t, offset)) : position
    }),
    radii: keys.map((key) => RADIUS_KM[key]),
  }
}

// A body's shell as its pair gaps see it: the Sun's at its scene size
// (exactly its own at a = 0, where its radius is the scene's).
function pairShell(body: FlightBody): number {
  return body.key === 'sun' ? collisionRadius(body) * (SUN_SCENE_RADIUS / body.radius) : collisionRadius(body)
}

function pairGap(a: FlightBody, b: FlightBody): number {
  return Math.max(MIN_GAP, a.position.distanceTo(b.position) - pairShell(a) - pairShell(b))
}

function weight(gap: number): number {
  return Math.max(MIN_GAP, gap) ** -WEIGHT_POWER
}

export interface ShipRanges {
  /** True range to each body's surface (in `bodies` order), km. */
  km: Float64Array
  /** Index of the body with the smallest range; -1 with no bodies. */
  nearest: number
  /** km per scene unit where the ship is; scene speed × this = km/s. */
  kmPerUnit: number
  /** The ship's true position, km from the Sun along the scene's axes. */
  position: THREE.Vector3
  /**
   * Per planet moon system, in MOON_PARENTS order: whether the ship is
   * inside its edge (moonSystemEdge, with MOON_SYSTEM_EDGE_HYSTERESIS), or
   * null before the first measure.
   */
  insideSystem: (boolean | null)[]
  /**
   * The last time the ship crossed a planet moon system's edge: whose, which
   * way, and how many crossings so far (0: none yet; a change in `count` is
   * a new crossing, for the HUD's cue). The first measure places the ship
   * without counting one.
   */
  edgeCrossing: SystemEdgeCrossing
}

export interface SystemEdgeCrossing {
  parent: MoonParent | null
  entering: boolean
  count: number
}

export function createShipRanges(count: number): ShipRanges {
  return {
    km: new Float64Array(count),
    nearest: -1,
    kmPerUnit: NaN,
    position: new THREE.Vector3(),
    insideSystem: MOON_PARENTS.map(() => null),
    edgeCrossing: { parent: null, entering: false, count: 0 },
  }
}

const gaps: number[] = []
const logScales: number[] = []
// Per body: its index in MOON_SYSTEMS, or -1 outside every system.
const systemOf: number[] = []
// Per system: the parent's body index (-1 when it or all its moons are
// missing from the bodies), the ship's departure (0 inside, 1 clear; a step
// at a planet system's edge), its members' weight boost, the parent's km per
// unit against the planets, and ∫departure (bandIntegral; Earth's only).
const systemParent: number[] = []
const systemDeparture: number[] = []
const systemBoost: number[] = []
const systemKm: number[] = []
const systemIntegral: number[] = []
// Per system: how far the parent's range has handed over from its own
// anchor's gap to the blended position's (0 to 1, from outer to
// RANGE_HAND_OVER × outer).
const systemHandOver: number[] = []
// Per body: the surface gap its own anchor puts the ship at, km.
const anchorGapKm: number[] = []
const anchor = new THREE.Vector3()
// Per body: where its anchor starts, km: its true position, or inside a
// planet system's edge its scene offset from the parent on the system's
// scale, so the members' anchors agree with each other (the drawn orbits are
// circles; the true ones are ~1% off them).
const based: THREE.Vector3[] = []
const systemBase: THREE.Vector3[] = []
// The band a member's shell excess, or the Sun's growth, is made up over
// (from the shell out); reused each body.
const fadeBand: Band = { inner: 0, outer: 0 }
const direction = new THREE.Vector3()

// From `position` to `body`'s collision shell, at least 0. Only a body with
// ground needs the direction (its floor under the ship).
function shellGap(position: THREE.Vector3, body: FlightBody): number {
  const d = direction.subVectors(position, body.position).length()
  if (!body.ground) return Math.max(0, d - collisionRadius(body))
  if (d > 0) direction.divideScalar(d)
  else direction.set(0, 1, 0)
  return Math.max(0, d - floorRadius(body, direction))
}

// ln(km per scene unit) between a and b: true surface gap over scene shell gap.
function pairLogScale(
  a: number,
  b: number,
  bodies: readonly FlightBody[],
  truth: TrueBodies
): number {
  const surfaceKm =
    truth.positions[a].distanceTo(truth.positions[b]) - truth.radii[a] - truth.radii[b]
  return Math.log(Math.max(1, surfaceKm) / pairGap(bodies[a], bodies[b]))
}

// ln(km per scene unit) around r: its pair scales with the other bodies,
// weighted to the nearest. With `within` ≥ 0 only that moon system's members
// count; with `skip` ≥ 0 that system's members don't.
function neighbourLogScale(
  r: number,
  bodies: readonly FlightBody[],
  truth: TrueBodies,
  within = -1,
  skip = -1
): number {
  let weightSum = 0
  let logSum = 0
  for (let b = 0; b < bodies.length; b++) {
    if (b === r) continue
    if (within >= 0 && systemOf[b] !== within) continue
    if (skip >= 0 && systemOf[b] === skip) continue
    const w = weight(pairGap(bodies[r], bodies[b]))
    weightSum += w
    logSum += w * pairLogScale(r, b, bodies, truth)
  }
  return weightSum > 0 ? logSum / weightSum : 0
}

// Whether the ship, `fromParent` from planet system `i`'s parent (MOON_PARENTS
// order), is inside its `edge`, with hysteresis on the state `out` carries;
// a change counts a crossing.
function crossEdge(out: ShipRanges, i: number, fromParent: number, edge: number): boolean {
  const was = out.insideSystem[i]
  const inside =
    was === null
      ? fromParent < edge
      : was
        ? fromParent <= edge * (1 + MOON_SYSTEM_EDGE_HYSTERESIS)
        : fromParent < edge * (1 - MOON_SYSTEM_EDGE_HYSTERESIS)
  if (was !== null && inside !== was) {
    const crossing = out.edgeCrossing
    crossing.parent = MOON_PARENTS[i]
    crossing.entering = inside
    crossing.count++
  }
  out.insideSystem[i] = inside
  return inside
}

/**
 * Fill `out` with the ship's true position, its range to every body, the
 * nearest by range and the local km per scene unit (see the header), for a
 * ship at scene `position` among `bodies`. `truth` is trueBodies for the same
 * bodies in the same order. `out` also carries which planet moon systems the
 * ship is inside from one call to the next (their edges' hysteresis), so pass
 * the same one along a flight.
 */
export function measureRanges(
  position: THREE.Vector3,
  bodies: readonly FlightBody[],
  truth: TrueBodies,
  out: ShipRanges
): ShipRanges {
  const n = bodies.length
  gaps.length = n
  logScales.length = n
  anchorGapKm.length = n
  for (let i = 0; i < n; i++) {
    gaps[i] = shellGap(position, bodies[i])
    based[i] = truth.positions[i]
  }

  // Which bodies form which moon system, and where the ship is in each.
  for (let i = 0; i < n; i++) systemOf[i] = SYSTEM_OF_KEY.get(bodies[i].key) ?? -1
  for (let s = 0; s < MOON_SYSTEMS.length; s++) {
    const system = MOON_SYSTEMS[s]
    let parent = -1
    let size = 0
    for (let i = 0; i < n; i++) {
      if (systemOf[i] !== s) continue
      size++
      if (bodies[i].key === system.parent) parent = i
    }
    // A system needs its parent and a moon among the bodies to have a scale.
    systemParent[s] = size >= 2 ? parent : -1
    if (systemParent[s] < 0) continue
    const fromParent = position.distanceTo(bodies[parent].position)
    const departure =
      system.edge === null
        ? THREE.MathUtils.smoothstep(fromParent, system.inner, system.outer)
        : crossEdge(out, s - 1, fromParent, system.edge)
        ? 0
        : 1
    systemDeparture[s] = departure
    systemBoost[s] = MOON_SYSTEM_BOOST ** (1 - departure)
    // The parent against the planets (its moons not counted): what its
    // members' km per unit hands over to on the way out.
    systemKm[s] = departure > 0 ? Math.exp(neighbourLogScale(parent, bodies, truth, -1, s)) : 0
    if (system.edge === null) {
      systemIntegral[s] = bandIntegral(fromParent, system)
      systemHandOver[s] = THREE.MathUtils.smoothstep(fromParent, system.outer, RANGE_HAND_OVER * system.outer)
    }
  }
  for (let i = 0; i < n; i++) {
    if (systemOf[i] >= 0 && systemParent[systemOf[i]] < 0) systemOf[i] = -1
  }

  // A planet system's members inside its edge read on its one scale, the
  // parent's true radius over its drawn one: exact for every orbit, true
  // spacing in planet radii being a uniform scale. Outside, the parent alone
  // anchors, on its scale against the planets, and its moons only take
  // their ranges from the blended position (see the header).

  // A member's km per unit is a, its scale among its own system, near the
  // parent; a + (b − a) · departure leaving, b being systemKm. Its gap takes
  // the extra (b − a) · ∫departure on top of a · gap (see the header). All of
  // a system's members use the parent's b and d, so Earth and the Moon (one
  // pair, one a) stay a·(scene separation) apart, the Earth–Moon scale,
  // however far out the ship is. Over a body with ground the scale near it
  // is the ground's, g, handing over to a through GROUND_BAND the same way:
  // (g − a) · (1 − smoothstep) on the scale, its integral on the gap; then
  // the gap pays back (a − g) · GROUND_BAND_DEPTH through GROUND_PAYBACK,
  // and the scale takes its slope.
  out.position.set(0, 0, 0)
  let weightSum = 0
  let logSum = 0
  for (let r = 0; r < n; r++) {
    const s = systemOf[r]
    let w = weight(gaps[r])
    let a: number
    let leavingKm = 0
    let leavingGapKm = 0
    if (s > 0) {
      const parent = systemParent[s]
      if (systemDeparture[s] === 0) {
        a = truth.radii[parent] / bodies[parent].radius
        w *= MOON_SYSTEM_BOOST
        if (r !== parent) {
          const at = (systemBase[r] ??= new THREE.Vector3())
          based[r] = at.subVectors(bodies[r].position, bodies[parent].position).multiplyScalar(a).add(truth.positions[parent])
        }
        // Its shell's km over its true radius, made up near it the way the
        // Sun's growth is: the anchor reads 0 on the shell, and from
        // SHELL_EXCESS_FADE × the excess out it agrees with every other
        // member's.
        const excess = Math.max(0, collisionRadius(bodies[r]) * a - truth.radii[r])
        if (excess > 0) {
          fadeBand.outer = (SHELL_EXCESS_FADE * excess) / a
          leavingKm = excess * bandSlope(gaps[r], fadeBand)
          leavingGapKm = excess * THREE.MathUtils.smoothstep(gaps[r], fadeBand.inner, fadeBand.outer)
        }
      } else if (r === parent) {
        a = systemKm[s]
      } else {
        anchorGapKm[r] = NaN
        continue
      }
    } else if (s === 0) {
      a = Math.exp(neighbourLogScale(r, bodies, truth, s))
      const departureKm = systemDeparture[s] > 0 ? systemKm[s] - a : 0
      leavingKm = departureKm * systemDeparture[s]
      leavingGapKm = departureKm * systemIntegral[s]
      w *= systemBoost[s]
    } else {
      a = Math.exp(neighbourLogScale(r, bodies, truth))
      // The Sun's growth over its scene size, made up through its band as a
      // moon system's departure is (the same two terms).
      const growth = collisionRadius(bodies[r]) - pairShell(bodies[r])
      if (growth > 0) {
        fadeBand.outer = SUN_BAND_GROWTHS * growth
        leavingKm = growth * FLIGHT_KM_PER_UNIT * bandSlope(gaps[r], fadeBand)
        leavingGapKm = growth * FLIGHT_KM_PER_UNIT * THREE.MathUtils.smoothstep(gaps[r], fadeBand.inner, fadeBand.outer)
      }
    }
    const grounded = bodies[r].ground && speedFloor(bodies[r]) < V_NORMAL
    const groundKm = grounded ? truth.radii[r] / bodies[r].radius - a : 0
    const grounding = 1 - THREE.MathUtils.smoothstep(gaps[r], GROUND_BAND.inner, GROUND_BAND.outer)
    const paybackKm = -groundKm * GROUND_BAND_DEPTH
    logScales[r] = Math.log(
      a + groundKm * grounding + paybackKm * bandSlope(gaps[r], GROUND_PAYBACK) + leavingKm
    )
    const gapKm =
      gaps[r] * a +
      groundKm * (gaps[r] - bandIntegral(gaps[r], GROUND_BAND)) +
      paybackKm *
        THREE.MathUtils.smoothstep(gaps[r], GROUND_PAYBACK.inner, GROUND_PAYBACK.outer) +
      leavingGapKm
    direction.subVectors(position, bodies[r].position)
    if (direction.lengthSq() > 0) direction.normalize()
    anchorGapKm[r] = gapKm
    anchor.copy(based[r]).addScaledVector(direction, truth.radii[r] + gapKm)
    out.position.addScaledVector(anchor, w)
    weightSum += w
    logSum += w * logScales[r]
  }
  if (weightSum > 0) out.position.divideScalar(weightSum)
  out.kmPerUnit = weightSum > 0 ? Math.exp(logSum / weightSum) : NaN

  // Earth reads its own anchor's gap near it, handing over to the blended
  // position's far out (see the header).
  out.nearest = -1
  for (let b = 0; b < n; b++) {
    const km = Math.max(0, based[b].distanceTo(out.position) - truth.radii[b])
    out.km[b] =
      systemOf[b] === 0 && systemParent[0] === b
        ? THREE.MathUtils.lerp(anchorGapKm[b], km, systemHandOver[0])
        : km
    if (out.nearest < 0 || out.km[b] < out.km[out.nearest]) out.nearest = b
  }
  return out
}

const MILLION = 1e6
// Short of a tenth of an AU, AU would need too many zeros to read.
const AU_FROM = 0.1 * KM_PER_AU
const threeFigures = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 })
const twoFigures = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 2 })

/**
 * "766,000 km", "2.03 million km" from a million km, "1.52 AU" from 0.1 AU;
 * with `fine`, "30 m" under 1 km.
 */
export function formatDistance(km: number, fine = false): string {
  if (!Number.isFinite(km)) return '—'
  // Over the streamed tiles the ship flies 30 m up (tides-zmw.9.18).
  if (fine && km < 1) return `${threeFigures.format(Math.round(Math.max(0, km) * 1000))} m`
  // Whole km below 1000, so a ship at rest on a surface reads "0 km".
  if (km < 1000) return `${threeFigures.format(Math.round(km))} km`
  if (km < MILLION) return `${threeFigures.format(km)} km`
  if (km < AU_FROM) return `${threeFigures.format(km / MILLION)} million km`
  return `${threeFigures.format(km / KM_PER_AU)} AU`
}

// Below a tenth of light speed km/s reads better; above it, Elite's c.
const C_FROM = 0.1 * C_KM_PER_S

/**
 * "15,500 km/s" under 0.1 c, else "1.3c"; with `fine` (true to scale near
 * the ground, tides-zmw.9.18), "540 km/h" under 1 km/s.
 */
export function formatSpeed(kmPerSecond: number, fine = false): string {
  if (!Number.isFinite(kmPerSecond)) return '—'
  if (fine && kmPerSecond < 1) return `${threeFigures.format(Math.round(kmPerSecond * 3600))} km/h`
  if (kmPerSecond < C_FROM) return `${threeFigures.format(kmPerSecond)} km/s`
  return `${twoFigures.format(kmPerSecond / C_KM_PER_S)}c`
}

/** "7 s", "3 min", "2 h"; a dash when not closing. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 100) return `${Math.round(seconds)} s`
  if (seconds < 100 * 60) return `${Math.round(seconds / 60)} min`
  return `${Math.round(seconds / 3600)} h`
}

const NAMES: Record<string, string> = {
  sun: 'Sun',
  earth: 'Earth',
  moon: 'Moon',
  ...Object.fromEntries(Object.values(PLANETS).map((planet) => [planet.key, planet.name])),
  ...Object.fromEntries(MOON_KEYS.map((key) => [key, MOONS[key].name])),
}

/** Display name for a ship body key. */
export function bodyName(key: string): string {
  return NAMES[key] ?? key
}
