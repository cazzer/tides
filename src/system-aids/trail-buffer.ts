// Motion trails behind the planets (tides-2hv.11): a ring buffer of where
// each body has been over the last few wall-clock seconds, laid out as
// LineSegments vertices so one draw covers every planet. Trails.tsx owns the
// three.js side; this is the bookkeeping, allocated once and then written in
// place every frame.
//
// A trail shows motion: it spans wall time, not sim time, so it grows with
// the clock's speed and shrinks to nothing while paused. It is also capped
// by arc, so Mercury at a month a second doesn't draw most of its orbit.

/** Wall seconds a trail reaches back. [TUNE] Longer reads as orbit lines. */
export const TRAIL_SECONDS = 2 // [TUNE]
/** Samples per wall second. [TUNE] Fewer shows corners on fast planets. */
export const TRAIL_SAMPLES_PER_SECOND = 30 // [TUNE]
/** Longest arc a trail covers, degrees of its orbit. [TUNE] */
export const TRAIL_MAX_DEGREES = 40 // [TUNE]
/**
 * Opacity at the planet, fading to 0 at the tail. [TUNE] High: a trail runs
 * along the planet's faint orbit line and has to stand out from it.
 */
export const TRAIL_OPACITY = 0.85 // [TUNE]

/**
 * Ring slots per body: enough that a slot has faded out on wall age before
 * the ring comes back round to it, plus the live head.
 */
export const TRAIL_SLOTS = Math.ceil(TRAIL_SECONDS * TRAIL_SAMPLES_PER_SECOND) + 2

const SAMPLE_INTERVAL = 1 / TRAIL_SAMPLES_PER_SECOND
const MS_PER_DAY = 86_400_000

export interface TrailBuffer {
  bodies: number
  slots: number
  /** The live slot, rewritten every frame at the body's current position. */
  head: number
  /** Wall seconds when the head slot started. */
  headStartedAt: number
  /** Per slot (shared by every body): wall seconds of its last write. */
  wallAt: Float64Array
  /** Per slot: sim time (epoch ms) of its last write. */
  simAt: Float64Array
  /** Per body: wall seconds it was first written; slots before are empty. */
  firstSeen: Float64Array
  /**
   * LineSegments vertices: body b's segment j joins slot j to slot j + 1, at
   * vertices 2·(b·slots + j) and the one after.
   */
  positions: Float32Array
  /** RGBA per vertex; the RGB is the body's colour, the alpha the fade. */
  colors: Float32Array
}

/** `rgb[b]` is body b's linear colour. */
export function createTrailBuffer(
  rgb: readonly (readonly [number, number, number])[],
  slots = TRAIL_SLOTS
): TrailBuffer {
  const bodies = rgb.length
  const vertices = bodies * slots * 2
  const colors = new Float32Array(vertices * 4)
  for (let v = 0; v < vertices; v++) {
    const [r, g, b] = rgb[Math.floor(v / (slots * 2))]
    colors[v * 4] = r
    colors[v * 4 + 1] = g
    colors[v * 4 + 2] = b
  }
  return {
    bodies,
    slots,
    head: 0,
    headStartedAt: -Infinity,
    wallAt: new Float64Array(slots).fill(-Infinity),
    simAt: new Float64Array(slots),
    firstSeen: new Float64Array(bodies).fill(Infinity),
    positions: new Float32Array(vertices * 3),
    colors,
  }
}

/**
 * Starts the frame at wall time `now` (s) and sim time `sim` (ms): freezes
 * the head and moves to the next slot once a sample interval has passed,
 * then stamps the head with the times its positions are about to be.
 */
export function beginTrailFrame(buffer: TrailBuffer, now: number, sim: number): void {
  if (now - buffer.headStartedAt >= SAMPLE_INTERVAL) {
    buffer.head = (buffer.head + 1) % buffer.slots
    buffer.headStartedAt = now
  }
  buffer.wallAt[buffer.head] = now
  buffer.simAt[buffer.head] = sim
}

/** Writes body `body`'s current position into the head slot. */
export function writeTrailHead(
  buffer: TrailBuffer,
  body: number,
  x: number,
  y: number,
  z: number
): void {
  const { slots, head, positions } = buffer
  if (buffer.firstSeen[body] === Infinity) buffer.firstSeen[body] = buffer.wallAt[head]
  const base = body * slots
  // The start of the head's own segment and the end of the one before it.
  const start = (base + head) * 2 * 3
  const end = ((base + (head - 1 + slots) % slots) * 2 + 1) * 3
  positions[start] = positions[end] = x
  positions[start + 1] = positions[end + 1] = y
  positions[start + 2] = positions[end + 2] = z
}

/**
 * How much of a trail point is left: 1 at the planet, 0 once it is
 * TRAIL_SECONDS old or TRAIL_MAX_DEGREES behind, whichever comes first.
 */
export function trailFade(wallAge: number, arcDegrees: number): number {
  const spent = Math.max(wallAge / TRAIL_SECONDS, arcDegrees / TRAIL_MAX_DEGREES)
  return Math.min(1, Math.max(0, 1 - spent))
}

/**
 * Sets every vertex's alpha for wall time `now` (s) and sim time `sim` (ms).
 * `periodDays[b]` is body b's orbital period, for the arc cap. The segment
 * from the head to the oldest slot closes the ring, so it is never drawn.
 */
export function fadeTrail(
  buffer: TrailBuffer,
  now: number,
  sim: number,
  periodDays: ArrayLike<number>
): void {
  const { bodies, slots, head, colors } = buffer
  for (let b = 0; b < bodies; b++) {
    const degreesPerMs = 360 / (periodDays[b] * MS_PER_DAY)
    for (let j = 0; j < slots; j++) {
      const v = (b * slots + j) * 2
      const closesRing = j === head
      colors[v * 4 + 3] = closesRing
        ? 0
        : slotAlpha(buffer, b, j, now, sim, degreesPerMs)
      colors[(v + 1) * 4 + 3] = closesRing
        ? 0
        : slotAlpha(buffer, b, (j + 1) % slots, now, sim, degreesPerMs)
    }
  }
}

function slotAlpha(
  { wallAt, simAt, firstSeen }: TrailBuffer,
  body: number,
  slot: number,
  now: number,
  sim: number,
  degreesPerMs: number
): number {
  if (wallAt[slot] < firstSeen[body]) return 0
  const arc = Math.abs(sim - simAt[slot]) * degreesPerMs
  return TRAIL_OPACITY * trailFade(now - wallAt[slot], arc)
}
