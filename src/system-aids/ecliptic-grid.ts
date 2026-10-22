// The ecliptic grid's geometry (tides-2hv.9), kept out of EclipticGrid.tsx so
// it can be tested without a renderer.
//
// A polar grid in the ecliptic plane (scene y = 0): dashed rings at round
// distances from the Sun and spokes every 30° of ecliptic longitude. Polar
// rather than square because the system view's spacing is compressed
// radially (sceneDistance): equal squares would claim equal distances that
// aren't, while a ring is honest at any spacing as long as its label gives
// its true AU. The rings sit at positionsFor(scale).distance, so they cross
// the planets' orbits where the planets really are that far out.
import type { SceneDistance } from '../planets'

/** Ring distances from the Sun, AU: Earth, Mars-ish, Jupiter, Saturn, Uranus, Neptune. */
export const AU_RINGS = [1, 2, 5, 10, 20, 30] as const

/**
 * Points per ring. [TUNE] The 30 AU ring at the flight scale is 30 000 units
 * across; at 720 its chords sag 0.29 units, under a third of Neptune's
 * radius, so even flying along it the ring looks round.
 */
export const RING_SEGMENTS = 720 // [TUNE]

/**
 * Dashes per ring. [TUNE] Counted round the ring rather than measured along
 * it, so each ring reads the same at either scale: ~1.3 units long on the
 * 1 AU ring in the system view (a dotted line zoomed out, dashes zoomed in),
 * ~8 on the 30 AU ring. Dashed, unlike the solid orbits, because Neptune's
 * orbit all but lies on the 30 AU ring.
 */
export const RING_DASHES = 120 // [TUNE]

/** Spokes round the Sun, one per 30° of ecliptic longitude (the signs' edges). */
export const SPOKES = 12

/**
 * Where on each ring its label sits, as a scene angle φ = atan2(−z, x)
 * (ecliptic longitude φ + 180°). [TUNE] −45° is the near side from the main
 * view's starting eye ([100, 80, 80]), between two spokes, so the labels run
 * down the screen in a column that a phone's portrait frame keeps in view.
 */
export const LABEL_ANGLE = -Math.PI / 4 // [TUNE]

/** A ring's label: its true distance, whatever the scale draws it at. */
export function ringLabel(au: number): string {
  return `${au} AU`
}

// The scene point r out at scene angle φ (ZodiacRing's ringPoint).
function writeRingPoint(out: Float32Array, at: number, r: number, angle: number) {
  out[at] = r * Math.cos(angle)
  out[at + 1] = 0
  out[at + 2] = -r * Math.sin(angle)
}

export interface RingArrays {
  /** (RING_SEGMENTS + 1) points per ring: the first repeats at the end. */
  positions: Float32Array
  /**
   * Dash count from each ring's start, for LineDashedMaterial with a dash
   * period of 1. The repeated end point carries RING_DASHES, not 0, so the
   * closing segment doesn't squeeze a whole ring of dashes into itself.
   */
  lineDistances: Float32Array
  /** Segment pairs, ring by ring, for one LineSegments draw. */
  indices: Uint16Array
}

/** Every AU ring at `distance`'s spacing. */
export function ringArrays(distance: SceneDistance): RingArrays {
  const points = RING_SEGMENTS + 1
  const positions = new Float32Array(AU_RINGS.length * points * 3)
  const lineDistances = new Float32Array(AU_RINGS.length * points)
  const indices = new Uint16Array(AU_RINGS.length * RING_SEGMENTS * 2)
  AU_RINGS.forEach((au, ring) => {
    const r = distance(au)
    const base = ring * points
    for (let k = 0; k < points; k++) {
      writeRingPoint(positions, (base + k) * 3, r, (2 * Math.PI * k) / RING_SEGMENTS)
      lineDistances[base + k] = (RING_DASHES * k) / RING_SEGMENTS
    }
    for (let k = 0; k < RING_SEGMENTS; k++) {
      const at = (ring * RING_SEGMENTS + k) * 2
      indices[at] = base + k
      indices[at + 1] = base + k + 1
    }
  })
  return { positions, lineDistances, indices }
}

/**
 * The spokes as segment pairs, from the innermost ring to the outermost:
 * inside 1 AU the system view's calendar rings already mark the longitudes.
 */
export function spokePositions(distance: SceneDistance): Float32Array {
  const inner = distance(AU_RINGS[0])
  const outer = distance(AU_RINGS[AU_RINGS.length - 1])
  const positions = new Float32Array(SPOKES * 2 * 3)
  for (let k = 0; k < SPOKES; k++) {
    const angle = (2 * Math.PI * k) / SPOKES
    writeRingPoint(positions, k * 6, inner, angle)
    writeRingPoint(positions, k * 6 + 3, outer, angle)
  }
  return positions
}

/** Where the `au` ring's label is anchored, scene units. */
export function ringLabelPosition(distance: SceneDistance, au: number): [number, number, number] {
  const r = distance(au)
  return [r * Math.cos(LABEL_ANGLE), 0, -r * Math.sin(LABEL_ANGLE)]
}
