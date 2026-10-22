// The desktop mouse as an Elite Dangerous-style virtual joystick
// (tides-3bl.3): the cursor's offset from the centre of the ship view is a
// turn-rate demand. No pointer lock; the cursor stays visible and free.

/** Radius of the still zone round the centre, as a share of the view's short side. */
export const JOYSTICK_DEAD_ZONE = 0.04
/** Offset that gives full turn rate, as a share of the view's short side. */
export const JOYSTICK_SATURATION = 0.35
/** Response curve: >1 gives fine control near the centre. */
export const JOYSTICK_EXPONENT = 1.5

export interface JoystickDemand {
  /** −1..1; +1 is nose up (cursor above centre). */
  pitch: number
  /** −1..1; +1 is nose right (cursor right of centre). */
  yaw: number
  /**
   * The cursor offset clamped to the saturation circle, as a share of its
   * radius: x right, y down, |(x, y)| ≤ 1. Drives the on-screen widget.
   */
  x: number
  y: number
}

/**
 * Maps a cursor offset from the view's centre (CSS px, x right, y down) to a
 * pitch/yaw demand. Inside the dead zone the demand is zero; from its edge to
 * the saturation radius it rises along the response curve to 1; beyond that
 * it stays at 1. The demand vector keeps the cursor's direction, so it never
 * leaves the unit circle.
 */
export function joystickDemand(dx: number, dy: number, shortSide: number): JoystickDemand {
  const saturation = JOYSTICK_SATURATION * shortSide
  const deadZone = JOYSTICK_DEAD_ZONE * shortSide
  const distance = Math.hypot(dx, dy)
  if (!(saturation > 0) || !Number.isFinite(distance) || distance === 0) {
    return { pitch: 0, yaw: 0, x: 0, y: 0 }
  }
  const reach = Math.min(distance, saturation)
  const ux = dx / distance
  const uy = dy / distance
  const x = (ux * reach) / saturation
  const y = (uy * reach) / saturation
  if (distance <= deadZone) return { pitch: 0, yaw: 0, x, y }
  const magnitude = ((reach - deadZone) / (saturation - deadZone)) ** JOYSTICK_EXPONENT
  // || 0 turns −0 into 0 along the axes.
  return { pitch: -uy * magnitude || 0, yaw: ux * magnitude || 0, x, y }
}
