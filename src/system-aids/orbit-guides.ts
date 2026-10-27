// The moon orbit lines' geometry and refresh rules (tides-2hv.9), kept out of
// OrbitGuides.tsx so they can be tested without a renderer.
//
// One line set per parent: Earth (its Moon) and each planet with moons in
// moons.ts. Every set is built relative to its parent's centre and drawn at
// the parent's live position. Earth's Moon sits at moonOffset, ~10 units, at
// both distance scales; a planet's moons orbit at the scale's own radii,
// which differ in flight only under ?truescale (moons.ts).
import { MOON_UNITS_PER_KM, moonOffset } from '../ephemeris'
import {
  MOON_PARENTS,
  moonOrbitPath,
  moonSystemExtent,
  moonsOf,
  type MoonParent,
} from '../moons/moons'
import type { DistanceScale } from '../distance-scale'

/** A body whose moons get orbit lines. */
export type GuideParent = 'earth' | MoonParent

/** Earth first, then outward from the Sun. */
export const GUIDE_PARENTS: readonly GuideParent[] = ['earth', ...MOON_PARENTS]

/**
 * Points per moon orbit. [TUNE] Iapetus' ~25-unit circle at 128 strays
 * 0.008 units off a true circle: under a pixel at the closest planet framing.
 */
export const MOON_ORBIT_SEGMENTS = 128 // [TUNE]

/** Sidereal month, days. */
export const SIDEREAL_MONTH_DAYS = 27.321661

const MS_PER_DAY = 86_400_000

/**
 * Sim days between rebuilds of a parent's orbit lines. [TUNE] A rebuild is
 * only for the orbit's plane and shape, never the moon's phase: every line
 * passes through its moon when built, and the moon then runs round it.
 *   - Earth's Moon: a month of true positions centred on the build time
 *     (planetOrbitPath's approach), so the Moon stays on it until the
 *     perturbed orbit has drifted; a tenth of a month, as planets use.
 *   - The Galileans: osculating circles (moons.ts), whose planes wobble by a
 *     fraction of a degree over days. Five days keeps each moon within ~0.01
 *     units of its line (orbit-guides.test.ts); at a month per second that
 *     is a rebuild every ~10 frames.
 *   - The rest: mean circular orbits in their parent's equator of date, which
 *     only turns with the pole's centuries-long precession; a year is plenty.
 */
export const ORBIT_GUIDE_REFRESH_DAYS: Readonly<Record<GuideParent, number>> = {
  earth: 0.1 * SIDEREAL_MONTH_DAYS,
  mars: 365,
  jupiter: 5,
  saturn: 365,
  uranus: 365,
  neptune: 365,
} // [TUNE]

/** True once the clock has moved (or jumped) far enough from pathT to rebuild. */
export function orbitGuideIsStale(parent: GuideParent, pathT: number, t: number): boolean {
  return Math.abs(t - pathT) > ORBIT_GUIDE_REFRESH_DAYS[parent] * MS_PER_DAY
}

/** How many orbit loops a parent's set holds. */
export function guideLoopCount(parent: GuideParent): number {
  return parent === 'earth' ? 1 : moonsOf(parent).length
}

/**
 * The Moon's path around Earth for a sidereal month centred on t, as
 * `segments` xyz triples relative to Earth (moonOffset's scale and axes).
 * The middle point is the Moon at t. The perturbed orbit doesn't quite
 * close, so a loop drawn through these has a short closing chord opposite
 * the Moon.
 */
export function earthMoonOrbitPath(t: number, segments: number, out?: Float32Array): Float32Array {
  const points = out ?? new Float32Array(segments * 3)
  const period = SIDEREAL_MONTH_DAYS * MS_PER_DAY
  for (let i = 0; i < segments; i++) {
    const [x, y, z] = moonOffset(t + (i / segments - 0.5) * period)
    points[i * 3] = x
    points[i * 3 + 1] = y
    points[i * 3 + 2] = z
  }
  return points
}

/**
 * Every orbit of `parent`'s moons at t into `positions` (guideLoopCount ×
 * segments xyz triples, one loop after another, relative to the parent).
 */
export function writeGuidePaths(
  parent: GuideParent,
  t: number,
  segments: number,
  scale: DistanceScale,
  positions: Float32Array
): Float32Array {
  if (parent === 'earth') return earthMoonOrbitPath(t, segments, positions)
  const stride = segments * 3
  moonsOf(parent).forEach((key, i) => {
    moonOrbitPath(key, t, segments, scale, positions.subarray(i * stride, (i + 1) * stride))
  })
  return positions
}

/**
 * Index pairs that close each of `loops` loops of `segments` points, for a
 * single LineSegments draw per parent instead of one LineLoop per moon.
 */
export function loopIndices(loops: number, segments: number): Uint16Array {
  const indices = new Uint16Array(loops * segments * 2)
  for (let loop = 0; loop < loops; loop++) {
    const base = loop * segments
    for (let k = 0; k < segments; k++) {
      const at = (base + k) * 2
      indices[at] = base + k
      indices[at + 1] = base + ((k + 1) % segments)
    }
  }
  return indices
}

// The Moon's apogee never passes ~406 700 km.
const EARTH_MOON_EXTENT = 406_700 * MOON_UNITS_PER_KM

/** How far the parent's outermost orbit line reaches from its centre at `scale`, scene units. */
export function guideExtent(parent: GuideParent, scale: DistanceScale): number {
  return parent === 'earth' ? EARTH_MOON_EXTENT : moonSystemExtent(parent, scale)
}

/**
 * On-screen radius, CSS pixels, below which a parent's orbit lines are
 * hidden, and above which they are at full strength. [TUNE] Zoomed out to
 * the whole system Mars' and Jupiter's moons sit within a few pixels of the
 * planet, where their rings would only thicken its dot.
 */
export const ORBIT_GUIDE_HIDE_PX = 12 // [TUNE]
export const ORBIT_GUIDE_SHOW_PX = 40 // [TUNE]

/** 0–1 strength of a parent's orbit lines whose extent spans `extentPx` on screen. */
export function orbitGuideFade(extentPx: number): number {
  const x = (extentPx - ORBIT_GUIDE_HIDE_PX) / (ORBIT_GUIDE_SHOW_PX - ORBIT_GUIDE_HIDE_PX)
  const s = Math.min(1, Math.max(0, x))
  return s * s * (3 - 2 * s)
}
