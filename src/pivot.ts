import { Quaternion, Vector3, type Camera } from 'three'
import type { OrbitControls } from 'three-stdlib'

export const MAX_TILT = (80 * Math.PI) / 180

/**
 * Finger (or right/middle-drag) travel in screen pixels, right and down positive,
 * to tilt and heading changes: half a turn per view height. Moving up tilts
 * toward the horizon; moving right turns the ground below the centre rightward.
 */
export function pixelsToPivot(
  dx: number,
  dy: number,
  height: number
): { tilt: number; heading: number } {
  const radPerPixel = Math.PI / height
  return { tilt: -dy * radPerPixel, heading: -dx * radPerPixel }
}

export function clampTilt(tilt: number): number {
  return Math.min(MAX_TILT, Math.max(0, tilt))
}

export function wrapAngle(angle: number): number {
  return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI))
}

/**
 * How far from Earth's centre toward the surface the pivot sits, as a share
 * of the radius. rotateSpeed falls below 1 only once the surface fills the
 * view, so far out the camera pivots about the centre and up close about the
 * ground at screen centre.
 */
export function pivotDepth(rotateSpeed: number): number {
  return 1 - Math.min(1, rotateSpeed) ** 2
}

/**
 * Below this pivot depth the surface no longer fills the view and a tilt
 * would only tip the whole system about Earth's centre, so the pivot takes no
 * input and the tilt and heading ease back to zero.
 */
export const MIN_PIVOT_DEPTH = 0.5

const PIVOT_EASE = 0.05

const easeToZero = (value: number) =>
  Math.abs(value) < 1e-4 ? 0 : value * (1 - PIVOT_EASE)

export const canPivot = (pivot: Pivot) => pivot.depth >= MIN_PIVOT_DEPTH

/**
 * Steps `pivot` one frame. `depth` is pivotDepth at the current zoom in Earth
 * focus, or null elsewhere. Zoomed out past MIN_PIVOT_DEPTH, or outside Earth
 * focus, the tilt and heading ease back so the orbit is the untilted one again.
 */
export function settlePivot(pivot: Pivot, depth: number | null): void {
  pivot.depth = depth ?? easeToZero(pivot.depth)
  if (depth === null || depth < MIN_PIVOT_DEPTH) {
    pivot.tilt = easeToZero(pivot.tilt)
    pivot.heading = easeToZero(pivot.heading)
  }
}

const _worldUp = new Vector3(0, 1, 0)

/**
 * The camera up vector for a heading: north rotated about the local vertical.
 * Its angle to `normal` doesn't change, so a heading never brings the orbit
 * any closer to the poles' degenerate lookAt than it already was.
 */
export function headingUp(out: Vector3, normal: Vector3, heading: number) {
  return out.copy(_worldUp).applyAxisAngle(normal, heading)
}

const _normal = new Vector3()
const _pivot = new Vector3()
const _right = new Vector3()
const _turn = new Quaternion()

/**
 * Tips a camera looking at `centre` by `tilt` about its own right axis through
 * the point `depth`·`radius` along the view axis from `centre`, mutating
 * `position` and `quaternion`. That point stays at screen centre, and the view
 * direction ends `tilt` away from the local vertical, with the horizon rising
 * from the top of the screen.
 */
export function applyTilt(
  position: Vector3,
  quaternion: Quaternion,
  centre: Vector3,
  radius: number,
  depth: number,
  tilt: number
): void {
  if (tilt === 0) return
  _normal.subVectors(position, centre).normalize()
  _pivot.copy(centre).addScaledVector(_normal, radius * depth)
  _right.set(1, 0, 0).applyQuaternion(quaternion)
  _turn.setFromAxisAngle(_right, tilt)
  position.sub(_pivot).applyQuaternion(_turn).add(_pivot)
  quaternion.premultiply(_turn)
}

export type Pivot = { tilt: number; heading: number; depth: number }

/**
 * three-stdlib's OrbitControls, drei's frame loop and CameraProvider all call
 * `controls.update` through the property, so wrapping it lets them orbit the
 * untilted pose (damping, clamps, zoom and the surface grab unchanged) while
 * the camera rests tilted between updates, so clicks hit what is shown.
 * Heading enters as camera.up: OrbitControls rebuilds its orbit frame from it
 * each update, keeping left-drag screen-aligned. `carry` (CameraProvider's
 * followMotion: the focused body's motion) moves the untilted eye on the
 * next update and is then spent, so the eye rides along with the body;
 * getDistance reports the untilted distance. `spin` (close-zoom.ts: Earth's
 * turn since the last frame) likewise turns the eye about the target, so
 * the ground under it stays put, and is then spent. `onOutsideMove` hears of
 * an update that found the camera moved by something else. Returns the undo.
 */
export function tiltControls(
  controls: OrbitControls,
  camera: Camera,
  pivot: Pivot,
  radius: () => number,
  carry = new Vector3(),
  onOutsideMove?: () => void,
  spin = new Quaternion()
): () => void {
  const original = controls.update
  const originalGetDistance = controls.getDistance
  const untilted = new Vector3()
  const shown = new Vector3(NaN, NaN, NaN)
  const lastShown = new Vector3(NaN, NaN, NaN)
  const lastShownQuaternion = new Quaternion()
  const normal = new Vector3()
  controls.update = () => {
    // Anything else that moved the camera wins over the stored pose.
    if (camera.position.equals(shown)) {
      camera.position
        .copy(untilted)
        .add(carry)
        .sub(controls.target)
        .applyQuaternion(spin)
        .add(controls.target)
    } else if (!Number.isNaN(shown.x)) {
      onOutsideMove?.()
    }
    carry.set(0, 0, 0)
    spin.identity()
    normal.subVectors(camera.position, controls.target).normalize()
    headingUp(camera.up, normal, pivot.heading)
    // Typed void, but three-stdlib returns whether it dispatched 'change'.
    const changed = Boolean(original() as unknown)
    untilted.copy(camera.position)
    applyTilt(
      camera.position,
      camera.quaternion,
      controls.target,
      radius(),
      pivot.depth,
      pivot.tilt
    )
    // A tilt or heading change alone still has to reach drei's invalidate.
    // Same thresholds as OrbitControls' own change check.
    const moved =
      !(lastShown.distanceToSquared(camera.position) <= 1e-6) ||
      8 * (1 - lastShownQuaternion.dot(camera.quaternion)) > 1e-6
    if (moved) {
      lastShown.copy(camera.position)
      lastShownQuaternion.copy(camera.quaternion)
      if (!changed) controls.dispatchEvent({ type: 'change', target: controls })
    }
    shown.copy(camera.position)
    return changed || moved
  }
  controls.getDistance = () =>
    camera.position.equals(shown)
      ? untilted.distanceTo(controls.target)
      : originalGetDistance()
  return () => {
    controls.update = original
    controls.getDistance = originalGetDistance
    if (camera.position.equals(shown)) camera.position.copy(untilted)
    camera.up.set(0, 1, 0)
  }
}
