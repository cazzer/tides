import { MathUtils, Spherical, Vector3 } from 'three'

/**
 * The opening move (tides-6m0.4): as the loading overlay fades, the main
 * view's eye comes in from a pose off its own and settles on it. The move is
 * a spherical offset from the pose the app's camera logic puts the eye in
 * (the clock ride, OrbitControls), easing to nothing, so it composes with
 * them instead of owning the camera.
 */

/** How far the eye starts from its own pose: a turn about the target's up, a rise, and a distance ratio. */
export interface OpeningOffset {
  /** Radians round the up axis. */
  azimuth: number
  /** Radians up from the eye's own elevation (negative: down). */
  elevation: number
  /** The eye's distance as a ratio of its own. */
  scale: number
}

export interface OpeningMove {
  /** The offset the eye starts at. */
  from: OpeningOffset
  /** Milliseconds from the overlay starting to fade to the eye landing. */
  duration: number
  /** Eases 0..1 to 0..1. */
  ease: (t: number) => number
}

const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2

/**
 * Straight in from further out and a little above (tides-6m0.5 picked it
 * over a swing round the Sun and a rise from edge-on), easing in and out so
 * most of the travel shows after the overlay has faded.
 */
export const OPENING_MOVE: OpeningMove = {
  from: { azimuth: 0, elevation: 0.22, scale: 2.4 },
  duration: 3600,
  ease: easeInOutCubic,
}

export const NO_OFFSET: OpeningOffset = { azimuth: 0, elevation: 0, scale: 1 }

/** The offset `elapsed` ms into `move`: its `from` at 0, none from its duration on. */
export function openingOffset(move: OpeningMove, elapsed: number): OpeningOffset {
  const t = MathUtils.clamp(elapsed / move.duration, 0, 1)
  const k = 1 - move.ease(t)
  return {
    azimuth: move.from.azimuth * k,
    elevation: move.from.elevation * k,
    scale: move.from.scale ** k,
  }
}

// Short of the poles, so the eye never passes over the top of the target.
const PHI_MIN = 0.02
const PHI_MAX = Math.PI - 0.02

const spherical = new Spherical()

/**
 * Moves `eye` from `applied`, the offset it was given last frame, to `next`,
 * about `target` (Y up): whatever moved the eye since (the clock ride's turn,
 * OrbitControls) stays, as only the difference is applied.
 */
export function shiftOpening(
  eye: Vector3,
  target: Vector3,
  applied: OpeningOffset,
  next: OpeningOffset
): void {
  const offset = eye.sub(target)
  spherical.setFromVector3(offset)
  spherical.theta += next.azimuth - applied.azimuth
  spherical.phi = MathUtils.clamp(
    spherical.phi - (next.elevation - applied.elevation),
    PHI_MIN,
    PHI_MAX
  )
  spherical.radius *= next.scale / applied.scale
  eye.setFromSpherical(spherical).add(target)
}

/**
 * The opening's progress, shared by the loading overlay (which starts it as
 * it fades) and the main view's camera (which plays it). Only the first load
 * plays it: once done or cut short it stays done.
 */
export const opening: {
  /** performance.now() when the overlay started to fade, or null before. */
  startedAt: number | null
  done: boolean
} = { startedAt: null, done: false }

export function startOpening(now: number): void {
  if (opening.startedAt === null) opening.startedAt = now
}

export function endOpening(): void {
  opening.done = true
}

/**
 * The user touching or scrolling the view: ends a move that has started,
 * where it is. A tap on the loading screen (pointer-events: none, so it
 * reaches the view) doesn't, so a phone user waiting on a slow load still
 * gets the opening.
 */
export function interruptOpening(): void {
  if (opening.startedAt !== null) endOpening()
}

/** For tests: back to before the overlay faded. */
export function resetOpening(): void {
  opening.startedAt = null
  opening.done = false
}

/**
 * Whether the main view may play the opening: the default (clock) view only,
 * as the clock ride eases nothing else in and leaves the eye's pose to it.
 * Earth focus is left out because tiltControls takes an outside write as a
 * new pose, a planet's because it would end the framing ease. Not under
 * reduced motion, nor over a restored pose, nor through an orthographic camera.
 */
export function openingAllowed(view: {
  focus: string
  reducedMotion: boolean
  restored: boolean
  perspective: boolean
}): boolean {
  return (
    view.focus === 'clock' &&
    !view.reducedMotion &&
    !view.restored &&
    view.perspective
  )
}
