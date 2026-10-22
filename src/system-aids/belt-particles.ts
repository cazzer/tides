// The asteroid and Kuiper belts (tides-2hv.11): the pure maths behind Belts'
// shader. Each particle is a circular orbit, a (semi-major axis) through
// sceneDistance like the planets, inclined about a random node, moving at
// Kepler's 1 / a^1.5 revolutions a year. The GPU places every particle from
// these elements and one time uniform, so the CPU never loops over them per
// frame. beltPosition is the GLSL in Belts.tsx in TypeScript: the tests here
// pin the behaviour both share, so keep them in step.

import { sceneDistance } from '../planets'

const TAU = 2 * Math.PI
const DEG = Math.PI / 180
const MS_PER_YEAR = 365.25 * 86_400_000
/** J2000.0, 2000-01-01 12:00 TT (as UTC; a minute is nothing here). */
const J2000_MS = Date.UTC(2000, 0, 1, 12)

/**
 * Particles per belt. Each belt is one draw of this many points, placed in
 * the vertex shader. [TUNE] Fewer reads as sparse specks when zoomed out;
 * more costs vertex work on phones for little gain at 1–2 px a point.
 */
export const ASTEROID_COUNT = 2500 // [TUNE]
export const KUIPER_COUNT = 3000 // [TUNE]

/** Floats per particle in the `orbit` attribute (see beltOrbits). */
export const ORBIT_STRIDE = 4
/** Floats per particle in the `shape` attribute (see beltOrbits). */
export const SHAPE_STRIDE = 2

// The main belt runs 2.2–3.3 AU, densest near 2.7, with Kirkwood gaps where
// Jupiter's 3:1, 5:2, 7:3 and 2:1 resonances cleared it. Inclinations are
// a few degrees, a half-normal of this spread.
export const ASTEROID_A_AU: readonly [number, number] = [2.2, 3.3]
const KIRKWOOD_GAPS_AU = [2.5, 2.82, 2.95, 3.27]
const KIRKWOOD_HALF_WIDTH_AU = 0.025
const ASTEROID_INCLINATION_SIGMA = 7 * DEG

// The Kuiper belt, 30–50 AU: a thin "cold" classical belt at 42–48 AU, the
// plutinos in Neptune's 3:2 resonance at 39.4 AU, and a hotter, more inclined
// spread over the whole range.
export const KUIPER_A_AU: readonly [number, number] = [30, 50]
const CLASSICAL_A_AU: readonly [number, number] = [42, 48]
const PLUTINO_A_AU = 39.4
const PLUTINO_SPREAD_AU = 0.4
const CLASSICAL_SHARE = 0.55
const PLUTINO_SHARE = 0.2
const CLASSICAL_INCLINATION_SIGMA = 3 * DEG
const HOT_INCLINATION_SIGMA = 12 * DEG
// Half-normal inclinations clamp here, so none sits near-polar.
const MAX_INCLINATION = 40 * DEG

export interface BeltOrbits {
  count: number
  /**
   * Per particle: scene radius (sceneDistance of a), mean motion in
   * revolutions per year, mean longitude at J2000 (rad), ascending node (rad).
   */
  orbit: Float32Array
  /** Per particle: inclination (rad), brightness (0–1). */
  shape: Float32Array
}

/** Small deterministic PRNG (mulberry32): the same belts every visit. */
export function random(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function halfNormal(next: () => number, sigma: number): number {
  // Box–Muller; 1 − u keeps the log finite.
  const g = Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(TAU * next())
  return Math.min(Math.abs(g) * sigma, MAX_INCLINATION)
}

/** Kepler's third law around one solar mass: revolutions per year at a AU. */
export function meanMotion(aAu: number): number {
  return aAu ** -1.5
}

/** Sim time (epoch ms) as Julian years since J2000, the shader's clock. */
export function yearsSinceJ2000(t: number): number {
  return (t - J2000_MS) / MS_PER_YEAR
}

function inKirkwoodGap(aAu: number): boolean {
  return KIRKWOOD_GAPS_AU.some((gap) => Math.abs(aAu - gap) < KIRKWOOD_HALF_WIDTH_AU)
}

function asteroid(next: () => number): { a: number; i: number } {
  const [lo, hi] = ASTEROID_A_AU
  for (;;) {
    // Triangular, peaked at the middle (2.75 AU).
    const a = lo + (hi - lo) * 0.5 * (next() + next())
    if (!inKirkwoodGap(a)) return { a, i: halfNormal(next, ASTEROID_INCLINATION_SIGMA) }
  }
}

function kuiperObject(next: () => number): { a: number; i: number } {
  const kind = next()
  if (kind < CLASSICAL_SHARE) {
    const [lo, hi] = CLASSICAL_A_AU
    return { a: lo + (hi - lo) * next(), i: halfNormal(next, CLASSICAL_INCLINATION_SIGMA) }
  }
  if (kind < CLASSICAL_SHARE + PLUTINO_SHARE) {
    return {
      a: PLUTINO_A_AU + PLUTINO_SPREAD_AU * (2 * next() - 1),
      i: halfNormal(next, HOT_INCLINATION_SIGMA),
    }
  }
  const [lo, hi] = KUIPER_A_AU
  return { a: lo + (hi - lo) * next(), i: halfNormal(next, HOT_INCLINATION_SIGMA) }
}

function beltOrbits(
  count: number,
  seed: number,
  sample: (next: () => number) => { a: number; i: number }
): BeltOrbits {
  const next = random(seed)
  const orbit = new Float32Array(count * ORBIT_STRIDE)
  const shape = new Float32Array(count * SHAPE_STRIDE)
  for (let k = 0; k < count; k++) {
    const { a, i } = sample(next)
    orbit[k * ORBIT_STRIDE] = sceneDistance(a)
    orbit[k * ORBIT_STRIDE + 1] = meanMotion(a)
    orbit[k * ORBIT_STRIDE + 2] = TAU * next()
    orbit[k * ORBIT_STRIDE + 3] = TAU * next()
    shape[k * SHAPE_STRIDE] = i
    // Mostly dim, a few brighter: a belt, not a second starfield.
    shape[k * SHAPE_STRIDE + 1] = 0.35 + 0.65 * next() ** 2
  }
  return { count, orbit, shape }
}

export function asteroidBelt(count = ASTEROID_COUNT): BeltOrbits {
  return beltOrbits(count, 0x2b17, asteroid)
}

export function kuiperBelt(count = KUIPER_COUNT): BeltOrbits {
  return beltOrbits(count, 0x4b3e, kuiperObject)
}

/**
 * Where particle `k` is at `years` since J2000, in scene coordinates. The
 * vertex shader in Belts.tsx is this function in GLSL: a circular orbit in
 * the ecliptic (x toward the equinox, z north), then eclipticToScene's
 * (x, y, z) → (−x, z, y).
 */
export function beltPosition(
  belt: BeltOrbits,
  k: number,
  years: number,
  out: [number, number, number] = [0, 0, 0]
): [number, number, number] {
  const o = k * ORBIT_STRIDE
  const r = belt.orbit[o]
  const revs = years * belt.orbit[o + 1]
  const node = belt.orbit[o + 3]
  // Argument of latitude: mean longitude less the node.
  const u = belt.orbit[o + 2] + TAU * (revs - Math.floor(revs)) - node
  const inc = belt.shape[k * SHAPE_STRIDE]
  const cu = Math.cos(u)
  const su = Math.sin(u)
  const cn = Math.cos(node)
  const sn = Math.sin(node)
  const x = r * (cn * cu - sn * su * Math.cos(inc))
  const y = r * (sn * cu + cn * su * Math.cos(inc))
  const z = r * su * Math.sin(inc)
  out[0] = -x
  out[1] = z
  out[2] = y
  return out
}
