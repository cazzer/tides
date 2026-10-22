// The desktop mouse as an Elite Dangerous-style virtual joystick
// (tides-3bl.3): the cursor's offset from the centre of the ship view is a
// turn-rate demand. No pointer lock; the cursor stays visible and free.

/** Radius of the still zone round the centre, as a share of the view's short side. */
export const JOYSTICK_DEAD_ZONE = 0.04
/** Offset that gives full turn rate, as a share of the view's short side. */
export const JOYSTICK_SATURATION = 0.3
/** Response curve: >1 gives fine control near the centre. */
export const JOYSTICK_EXPONENT = 1.25

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

/**
 * - unarmed: the cursor hasn't been back to the centre since steering was
 *   last interrupted, so it doesn't steer.
 * - holding: armed, but in the dead zone or over a control.
 * - steering: armed and turning the ship.
 */
export type JoystickMode = 'unarmed' | 'holding' | 'steering'

export interface MouseSteer extends JoystickDemand {
  armed: boolean
  mode: JoystickMode
}

export interface SteerContext {
  /** The cursor is over a button or other control. */
  overUi: boolean
  /** A modal dialog is open. */
  dialogOpen: boolean
}

/**
 * One mouse sample through the arming gate. Wherever the cursor happens to
 * be when steering starts (on the ship button at entry, on a modal's close
 * button) must not slam the ship into a full turn, so the joystick only
 * steers once the cursor has passed through the dead zone. An open dialog
 * disarms it; the caller disarms it too when the cursor leaves the window or
 * the window loses focus.
 */
export function mouseSteer(
  armed: boolean,
  dx: number,
  dy: number,
  shortSide: number,
  { overUi, dialogOpen }: SteerContext
): MouseSteer {
  const demand = joystickDemand(dx, dy, shortSide)
  const inDeadZone = Math.hypot(dx, dy) <= JOYSTICK_DEAD_ZONE * shortSide
  const nowArmed = !dialogOpen && (armed || inDeadZone)
  if (!nowArmed) return { ...demand, pitch: 0, yaw: 0, armed: false, mode: 'unarmed' }
  if (overUi || (demand.pitch === 0 && demand.yaw === 0)) {
    return { ...demand, pitch: 0, yaw: 0, armed: true, mode: 'holding' }
  }
  return { ...demand, armed: true, mode: 'steering' }
}
