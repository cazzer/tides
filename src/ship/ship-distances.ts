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
//      km a scene unit stands for around R. Inside a moon system (Earth and
//      the Moon; Mars, Jupiter, Saturn, Uranus or Neptune and their major
//      moons, tides-2hv.8), its members count only their neighbours within
//      the system, since moons orbit on their own scale (moons.ts' log map:
//      ~14 000 km a unit between Saturn and Mimas against ~150 000 between
//      planets). Leaving, they hand over to the parent's planetary
//      neighbours' scale, or the parent's range would under-read by the
//      ratio of the two (~2.5× for Earth, ~10× for Saturn) all the way out.
//      The hand-over is linear in km per unit, k(d), with d the ship's
//      distance from the parent's centre, and a member's gap is measured
//      along it: a·gap + ∫(k − a) dd, so the range grows at k × the radial
//      speed, the rate the HUD's speed reads (a·gap alone, scaled up as the
//      ship leaves, would run ~2.5× faster than the speed through the band).
//   3. The guesses blend with weights 1 / (ship's gap to R)⁴, so the anchor is
//      whichever body the ship is near, handing over smoothly in between.
//      Inside a system its members outweigh a body outside it that happens
//      to be as near in the scene. (Venus can't be, near Earth at the flight
//      scale: it never comes within ~260 units. The boost dates from the
//      compressed scale, where it passed ~14 units from Earth.)
//   4. range(B) = |true B − true ship| − B's true radius. A moon system's
//      parent is the exception: near it, its range is its own anchor's gap
//      (a·gap plus the hand-over term), handing over to the formula above
//      only far out (RANGE_HAND_OVER). The blended position mixes anchors
//      whose scene directions and scales disagree (the log map bends the
//      moons' geometry), and on a straight run in to Jupiter or Saturn it
//      read the range going backwards by up to ~280 000 km; the anchor's gap
//      only shrinks as the ship closes, at k × its radial speed. A moon's
//      own anchor is no good for this (its scale is set by its nearest
//      neighbour, so Mimas from Saturn would read ~4× long), so the moons
//      keep the blended range: exact from the parent's surface, 0 on arrival.
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
// ship is), so it is the rate the ranges change at. Inside a system with
// several moons, ranges between members are approximate (up to ~1.4×), as
// the log map's chords don't scale linearly; they still read 0 on arrival.
// The moon systems also nudge ranges outside them: Mars's moons' anchors
// shift Earth's and Mars's ranges by 1–11% for a ship 200–400 units out.
//
// Near a body the ship flies down to its ground (Earth's terrain on the high
// tier, where its speed floor is under V_NORMAL: flight.ts speedFloor), its
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
// included) every range and speed is as it was. On the low tier the ship
// stops above the shells, nowhere near the ground, and nothing changes.

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
  moonSystemExtent,
  moonTrueOffsetKm,
  moonsOf,
} from '../moons/moons'
import { CLOUD_LAYER_TOP } from '../cloud-layer'
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

// Within a moon system's `inner` of its parent's centre, the members weigh
// MOON_SYSTEM_BOOST times as much as anchors and read on the system's own
// scales; past `outer` (2 × inner), the same as any body, on the planets'
// scale; between, a smooth blend. Earth's Moon orbits ~10 units out; the
// spawn is ~12 out on a wide screen and ~28 on a portrait phone (Earth
// framed across the short side), hence 30 to 60. The other systems can
// reach further (moonSystemExtent: Saturn's ~31), so theirs start at
// MOON_SYSTEM_EXTENT_FACTOR × that if it is more. The boost has to be large
// because another body's guess is tens of millions of km off (its scale is
// the planets'): 1e4 is a gap 10× smaller, so with a planet as near as Earth
// the position moves ~2% instead of ~50% (a boost of 100).
const MOON_SYSTEM_INNER = 30
const MOON_SYSTEM_EXTENT_FACTOR = 1.5
const MOON_SYSTEM_BOOST = 1e4

// Out to `outer` a parent's range is its own anchor's gap; from there to
// RANGE_HAND_OVER × outer it hands over to the blended position's. The
// members' anchors disagree by millions of km (each counts the hand-over
// band at its own scale), so a quick hand-over ran Jupiter's range
// backwards; spread this wide its rate never drops below ~70% of the
// planets' scale. [TUNE]
const RANGE_HAND_OVER = 10

interface Band {
  inner: number
  outer: number
}

interface MoonSystem extends Band {
  parent: string
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

const MOON_SYSTEMS: readonly MoonSystem[] = [
  { parent: 'earth', inner: MOON_SYSTEM_INNER, outer: 2 * MOON_SYSTEM_INNER },
  ...MOON_PARENTS.map((parent) => {
    const inner = Math.max(MOON_SYSTEM_INNER, MOON_SYSTEM_EXTENT_FACTOR * moonSystemExtent(parent))
    return { parent, inner, outer: 2 * inner }
  }),
]

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
// (ship-bodies.ts, planets.ts).
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

function pairGap(a: FlightBody, b: FlightBody): number {
  return Math.max(MIN_GAP, a.position.distanceTo(b.position) - collisionRadius(a) - collisionRadius(b))
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
}

export function createShipRanges(count: number): ShipRanges {
  return {
    km: new Float64Array(count),
    nearest: -1,
    kmPerUnit: NaN,
    position: new THREE.Vector3(),
  }
}

const gaps: number[] = []
const logScales: number[] = []
// Per body: its index in MOON_SYSTEMS, or -1 outside every system.
const systemOf: number[] = []
// Per system: the parent's body index (-1 when it or all its moons are
// missing from the bodies), the ship's departure (0 inside, 1 clear), its
// members' weight boost, the parent's km per unit against the planets, and
// ∫departure (bandIntegral).
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

/**
 * Fill `out` with the ship's true position, its range to every body, the
 * nearest by range and the local km per scene unit (see the header), for a
 * ship at scene `position` among `bodies`. `truth` is trueBodies for the same
 * bodies in the same order.
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
    const departure = THREE.MathUtils.smoothstep(fromParent, system.inner, system.outer)
    systemDeparture[s] = departure
    systemBoost[s] = MOON_SYSTEM_BOOST ** (1 - departure)
    // The parent against the planets (its moons not counted): what its
    // members' km per unit hands over to on the way out.
    systemKm[s] = departure > 0 ? Math.exp(neighbourLogScale(parent, bodies, truth, -1, s)) : 0
    systemIntegral[s] = bandIntegral(fromParent, system)
    systemHandOver[s] = THREE.MathUtils.smoothstep(
      fromParent,
      system.outer,
      RANGE_HAND_OVER * system.outer
    )
  }
  for (let i = 0; i < n; i++) {
    if (systemOf[i] >= 0 && systemParent[systemOf[i]] < 0) systemOf[i] = -1
  }

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
    if (s >= 0) {
      a = Math.exp(neighbourLogScale(r, bodies, truth, s))
      const departureKm = systemDeparture[s] > 0 ? systemKm[s] - a : 0
      leavingKm = departureKm * systemDeparture[s]
      leavingGapKm = departureKm * systemIntegral[s]
      w *= systemBoost[s]
    } else {
      a = Math.exp(neighbourLogScale(r, bodies, truth))
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
    anchor.copy(truth.positions[r]).addScaledVector(direction, truth.radii[r] + gapKm)
    out.position.addScaledVector(anchor, w)
    weightSum += w
    logSum += w * logScales[r]
  }
  if (weightSum > 0) out.position.divideScalar(weightSum)
  out.kmPerUnit = weightSum > 0 ? Math.exp(logSum / weightSum) : NaN

  // A moon system's parent reads its own anchor's gap near it, handing over
  // to the blended position's far out (see the header).
  out.nearest = -1
  for (let b = 0; b < n; b++) {
    const km = Math.max(0, truth.positions[b].distanceTo(out.position) - truth.radii[b])
    const s = systemOf[b]
    out.km[b] =
      s >= 0 && systemParent[s] === b
        ? THREE.MathUtils.lerp(anchorGapKm[b], km, systemHandOver[s])
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
