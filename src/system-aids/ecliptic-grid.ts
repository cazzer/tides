// The ecliptic grid's geometry (tides-2hv.9), kept out of EclipticGrid.tsx so
// it can be tested without a renderer.
//
// Dashed rings in the ecliptic plane (scene y = 0) at round distances from
// the Sun, each labelled with its true AU. Rings rather than a square grid
// because the system view's spacing is compressed radially (sceneDistance):
// equal squares would claim equal distances that aren't, while a ring is
// honest at any spacing as long as its label gives its true AU. The rings sit
// at positionsFor(scale).distance, so they cross the planets' orbits where the
// planets really are that far out. No spokes: they carried no information,
// and the calendar rings already mark the longitudes.
import { EARTH_ORBIT_RADIUS, type Vec3 } from '../ephemeris'
import type { SceneDistance } from '../planets'

/** Ring distances from the Sun, AU: Earth, Mars-ish, Jupiter, Saturn, Uranus, Neptune. */
export const AU_RINGS = [1, 2, 5, 10, 20, 30] as const

/**
 * The rings drawn as lines at `distance`'s spacing. The system view's 1 AU
 * ring would lie exactly on Earth's month ring (orbit-label.tsx, radius
 * EARTH_ORBIT_RADIUS), so there only its label is kept.
 */
export function drawnRings(distance: SceneDistance): readonly number[] {
  return AU_RINGS.filter((au) => distance(au) !== EARTH_ORBIT_RADIUS)
}

/**
 * Points per ring. [TUNE] The 30 AU ring in the system view is ~640 units
 * across; at 720 its chords sag well under a hundredth of a unit.
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

/**
 * Where on each ring its label sits, as a scene angle φ = atan2(−z, x)
 * (ecliptic longitude φ + 180°). [TUNE] −45° is the near side from the main
 * view's starting eye ([100, 80, 80]), so the labels run down the screen in
 * a column that a phone's portrait frame keeps in view.
 */
export const LABEL_ANGLE = -Math.PI / 4 // [TUNE]

/**
 * A body closer than this to a label's angle, on that label's ring, moves the
 * label aside by LABEL_NUDGE. [TUNE] Jupiter's moon system spans ~4° of the
 * 5 AU ring in the system view.
 */
export const LABEL_CLEARANCE = (6 * Math.PI) / 180 // [TUNE]
export const LABEL_NUDGE = (15 * Math.PI) / 180 // [TUNE]
// "On that ring": within this share of the ring's radius of it.
const SAME_RING = 0.25

/** A ring's label: its true distance, whatever the scale draws it at. */
export function ringLabel(au: number): string {
  return `${au} AU`
}

function wrapToPi(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI))
}

/**
 * Each AU ring's label angle given where the bodies are (scene positions):
 * LABEL_ANGLE, or LABEL_NUDGE to the side away from a body that sits on it.
 */
export function ringLabelAngles(distance: SceneDistance, bodies: readonly Vec3[]): number[] {
  const radii = AU_RINGS.map(distance)
  // Each body counts only for its nearest ring: the compressed rings sit
  // close enough that Jupiter would otherwise also be "on" the 10 AU ring.
  const nearest = bodies.map(([x, , z]) => {
    const r = Math.hypot(x, z)
    let best = 0
    radii.forEach((ring, i) => {
      if (Math.abs(r - ring) < Math.abs(r - radii[best])) best = i
    })
    return Math.abs(r - radii[best]) <= SAME_RING * radii[best] ? best : -1
  })
  return AU_RINGS.map((_, ring) => {
    for (let b = 0; b < bodies.length; b++) {
      if (nearest[b] !== ring) continue
      const [x, , z] = bodies[b]
      const offset = wrapToPi(Math.atan2(-z, x) - LABEL_ANGLE)
      if (Math.abs(offset) < LABEL_CLEARANCE) {
        return LABEL_ANGLE + (offset > 0 ? -LABEL_NUDGE : LABEL_NUDGE)
      }
    }
    return LABEL_ANGLE
  })
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

/** The `rings` (AU) at `distance`'s spacing. */
export function ringArrays(distance: SceneDistance, rings: readonly number[]): RingArrays {
  const points = RING_SEGMENTS + 1
  const positions = new Float32Array(rings.length * points * 3)
  const lineDistances = new Float32Array(rings.length * points)
  const indices = new Uint16Array(rings.length * RING_SEGMENTS * 2)
  rings.forEach((au, ring) => {
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

/** Where the `au` ring's label is anchored at scene angle `angle`, scene units. */
export function ringLabelPosition(
  distance: SceneDistance,
  au: number,
  angle = LABEL_ANGLE
): [number, number, number] {
  const r = distance(au)
  return [r * Math.cos(angle), 0, -r * Math.sin(angle)]
}

/**
 * Where a ring label's text starts from its anchor, in ems: just off the
 * ring, up and to the right on screen (left- and bottom-anchored there).
 */
export const RING_TEXT_OFFSET: readonly [number, number, number] = [0.35, 0.15, 0]

/**
 * Each AU ring's label anchor, scene units, clear of `bodies` (scene
 * positions of Earth and the planets, as ringLabelAngles takes them).
 */
export function ringLabelPositions(distance: SceneDistance, bodies: readonly Vec3[]): Vec3[] {
  const angles = ringLabelAngles(distance, bodies)
  return AU_RINGS.map((au, i) => ringLabelPosition(distance, au, angles[i]))
}

/**
 * The AU ring labels as EclipticGrid draws them, which it publishes so body
 * names (BodyLabels, tides-2hv.10) can keep off them. Per label, in
 * AU_RINGS order: its anchor (scene xyz) and its text's box in ems from the
 * anchor along the screen's right and up ([minX, minY, maxX, maxY], troika's
 * measured block plus RING_TEXT_OFFSET; NaN until laid out). `count` is 0
 * while the grid isn't mounted; `emPx` is the text's em, CSS px.
 */
export interface RingLabelLayout {
  count: number
  emPx: number
  anchors: Float64Array
  bounds: Float64Array
}

export const ringLabelLayout: RingLabelLayout = {
  count: 0,
  emPx: 0,
  anchors: new Float64Array(AU_RINGS.length * 3),
  bounds: new Float64Array(AU_RINGS.length * 4).fill(NaN),
}

/** Publish the labels' anchors and em size (EclipticGrid, on mount). */
export function publishRingLabels(anchors: readonly Vec3[], emPx: number): void {
  anchors.forEach((anchor, i) => ringLabelLayout.anchors.set(anchor, i * 3))
  ringLabelLayout.emPx = emPx
  ringLabelLayout.count = anchors.length
}

/** Publish ring label i's text block, troika's [minX, minY, maxX, maxY] at font size 1. */
export function publishRingLabelBounds(i: number, block: readonly number[]): void {
  const [dx, dy] = RING_TEXT_OFFSET
  ringLabelLayout.bounds.set([block[0] + dx, block[1] + dy, block[2] + dx, block[3] + dy], i * 4)
}

/**
 * Nothing published, as when the grid unmounts. The bounds stay: they hang
 * on the text alone, and troika won't measure it again on a remount.
 */
export function clearRingLabels(): void {
  ringLabelLayout.count = 0
}
