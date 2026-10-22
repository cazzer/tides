// Motion trails behind the planets (tides-2hv.11): the last TRAIL_ARC_DEGREES
// of each body's own orbit in sim time, laid out as line segments so one draw
// covers every planet. Trails.tsx owns the three.js side; this is the
// bookkeeping, allocated once and then written in place.
//
// Body b is sampled on a fixed sim-time grid, every step_b = its period ·
// (arc / 360) / TRAIL_SAMPLES ms, at t = k · step_b. A ring buffer keeps the
// TRAIL_SAMPLES + 1 newest grid samples, slot k mod slots, so the clock
// moving on costs one ephemeris call per body per step crossed, and a scrub
// or a jump refills only the samples it hasn't got. Because the trail is
// sim time, it shows at every clock speed, paused included, and always points
// back along the direction of travel.
//
// The newest sample is at most one step (TRAIL_ARC_DEGREES / TRAIL_SAMPLES
// of the orbit) behind the body: inside every planet's disc at the system
// view's sizes, so the trail runs out from under the planet without a live
// head that would need the ephemeris every frame.

/** Degrees of its orbit a trail reaches back. [TUNE] */
export const TRAIL_ARC_DEGREES = 30 // [TUNE]
/**
 * Segments per trail. [TUNE] Fewer leaves a gap between Neptune and its
 * trail (a step is ~0.5° of orbit at 64, ~2.6 units out there, under
 * Neptune's ~5 unit radius) and shows corners.
 */
export const TRAIL_SAMPLES = 64 // [TUNE]
/**
 * Brightness at the planet, fading to 0 at the tail. [TUNE] Trails blend
 * additively, so this scales the colour; over a planet's faint orbit line
 * they add to it rather than hiding it.
 */
export const TRAIL_OPACITY = 0.8 // [TUNE]

/** Ring slots per body: TRAIL_SAMPLES segments need one more sample. */
export const TRAIL_SLOTS = TRAIL_SAMPLES + 1

const MS_PER_DAY = 86_400_000

/** Sim ms between body samples for an orbit of `periodDays`. */
export function sampleStep(periodDays: number): number {
  return (periodDays * MS_PER_DAY * (TRAIL_ARC_DEGREES / 360)) / TRAIL_SAMPLES
}

/** Where body `body` is at sim time `t` (epoch ms), scene xyz. */
export type TrailPositionAt = (body: number, t: number) => ArrayLike<number>

export interface TrailBuffer {
  bodies: number
  /** Per body: sim ms between samples. */
  step: Float64Array
  /** Per body: the grid index k of its newest sample; NaN while empty. */
  newest: Float64Array
  /** Per body, per ring slot (k mod TRAIL_SLOTS): the sample's xyz. */
  samples: Float32Array
  /**
   * Segment endpoints, xyz xyz: body b's segment i (0 at the planet) joins
   * its samples k − i and k − i − 1, at offset 6 · (b · TRAIL_SAMPLES + i).
   */
  segments: Float32Array
  /** Endpoint colours, rgb rgb, laid out as segments: the body's colour times its fade. */
  colors: Float32Array
  /** Per body: linear rgb. */
  rgb: Float32Array
  /** Sim time the colours were last faded for. */
  fadedAt: number
}

/** `periodDays[b]` and `rgb[b]` (linear) describe body b. */
export function createTrailBuffer(
  periodDays: ArrayLike<number>,
  rgb: readonly (readonly [number, number, number])[]
): TrailBuffer {
  const bodies = periodDays.length
  return {
    bodies,
    step: Float64Array.from({ length: bodies }, (_, b) => sampleStep(periodDays[b])),
    newest: new Float64Array(bodies).fill(NaN),
    samples: new Float32Array(bodies * TRAIL_SLOTS * 3),
    segments: new Float32Array(bodies * TRAIL_SAMPLES * 6),
    colors: new Float32Array(bodies * TRAIL_SAMPLES * 6),
    rgb: Float32Array.from(rgb.flat()),
    fadedAt: NaN,
  }
}

function slotOf(k: number): number {
  return ((k % TRAIL_SLOTS) + TRAIL_SLOTS) % TRAIL_SLOTS
}

function sample(buffer: TrailBuffer, body: number, k: number, positionAt: TrailPositionAt): void {
  const p = positionAt(body, k * buffer.step[body])
  const o = (body * TRAIL_SLOTS + slotOf(k)) * 3
  buffer.samples[o] = p[0]
  buffer.samples[o + 1] = p[1]
  buffer.samples[o + 2] = p[2]
}

// Samples body `body` up to grid index k, keeping what it already has of
// k − TRAIL_SAMPLES … k. Returns whether anything changed.
function advanceBody(
  buffer: TrailBuffer,
  body: number,
  k: number,
  positionAt: TrailPositionAt
): boolean {
  const had = buffer.newest[body]
  if (had === k) return false
  const lo = k - TRAIL_SAMPLES
  if (Number.isNaN(had) || Math.abs(k - had) > TRAIL_SAMPLES) {
    for (let j = lo; j <= k; j++) sample(buffer, body, j, positionAt)
  } else if (k > had) {
    for (let j = had + 1; j <= k; j++) sample(buffer, body, j, positionAt)
  } else {
    // Back in time: the oldest end is new.
    for (let j = lo; j < had - TRAIL_SAMPLES; j++) sample(buffer, body, j, positionAt)
  }
  buffer.newest[body] = k
  return true
}

function writeSegments(buffer: TrailBuffer, body: number): void {
  const k = buffer.newest[body]
  const { samples, segments } = buffer
  for (let i = 0; i < TRAIL_SAMPLES; i++) {
    const o = (body * TRAIL_SAMPLES + i) * 6
    const a = (body * TRAIL_SLOTS + slotOf(k - i)) * 3
    const b = (body * TRAIL_SLOTS + slotOf(k - i - 1)) * 3
    segments[o] = samples[a]
    segments[o + 1] = samples[a + 1]
    segments[o + 2] = samples[a + 2]
    segments[o + 3] = samples[b]
    segments[o + 4] = samples[b + 1]
    segments[o + 5] = samples[b + 2]
  }
}

/**
 * How much of a trail point is left at `age`, the sim time since it, as a
 * share of the whole trail's span: 1 at the planet, 0 at the tail.
 */
export function trailFade(age: number): number {
  return Math.min(1, Math.max(0, 1 - age))
}

function fadeBody(buffer: TrailBuffer, body: number, t: number): void {
  const k = buffer.newest[body]
  const step = buffer.step[body]
  const span = step * TRAIL_SAMPLES
  const { colors, rgb } = buffer
  for (let i = 0; i < TRAIL_SAMPLES; i++) {
    const o = (body * TRAIL_SAMPLES + i) * 6
    const near = TRAIL_OPACITY * trailFade((t - (k - i) * step) / span)
    const far = TRAIL_OPACITY * trailFade((t - (k - i - 1) * step) / span)
    for (let c = 0; c < 3; c++) {
      colors[o + c] = rgb[body * 3 + c] * near
      colors[o + 3 + c] = rgb[body * 3 + c] * far
    }
  }
}

/** updateTrails flags: `segments` was rewritten. */
export const SEGMENTS_CHANGED = 1
/** updateTrails flags: `colors` was rewritten. */
export const COLORS_CHANGED = 2

/**
 * Brings every trail to sim time `t` (epoch ms). Returns which buffers
 * changed, as flags (a number, so a frame allocates nothing): segments when
 * a body crossed a sample step (or jumped), colours whenever t moved. A
 * paused clock changes neither.
 */
export function updateTrails(buffer: TrailBuffer, t: number, positionAt: TrailPositionAt): number {
  let changed = 0
  for (let b = 0; b < buffer.bodies; b++) {
    if (advanceBody(buffer, b, Math.floor(t / buffer.step[b]), positionAt)) {
      writeSegments(buffer, b)
      changed |= SEGMENTS_CHANGED
    }
  }
  if (t !== buffer.fadedAt) {
    for (let b = 0; b < buffer.bodies; b++) fadeBody(buffer, b, t)
    buffer.fadedAt = t
    changed |= COLORS_CHANGED
  }
  return changed
}
